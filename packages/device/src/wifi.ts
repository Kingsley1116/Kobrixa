import dgram from "node:dgram";
import net from "node:net";
import type { DeviceDescriptor, DeviceTransport } from "./contracts.js";
import { DeviceOperationError, normalizeDeviceError, withTimeout } from "./errors.js";
import { FramedConnection } from "./framing.js";
import { EV3DeviceSession } from "./session.js";

const EV3_PORT = 5555;
const DISCOVERY_PORT = 3015;

function parseAdvertisement(message: string, address: string): DeviceDescriptor | undefined {
  const fields = Object.fromEntries(
    message
      .split(/\r?\n/)
      .map((line) => line.split(/:\s*/, 2))
      .filter((parts) => parts.length === 2),
  );
  if (fields.Protocol !== "EV3") return undefined;
  const serialNumber = fields["Serial-Number"];
  return {
    id: `wifi:${serialNumber ?? address}`,
    name: fields.Name ?? `EV3 ${address}`,
    transport: "wifi",
    address,
    ...(serialNumber ? { serialNumber } : {}),
  };
}

class TcpConnection extends FramedConnection {
  #buffer = Buffer.alloc(0);
  #waiters: Array<() => void> = [];

  constructor(private readonly socket: net.Socket) {
    super();
    socket.on("data", (data) => {
      this.#buffer = Buffer.concat([this.#buffer, data]);
      this.#waiters.splice(0).forEach((wake) => wake());
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.end();
      setTimeout(() => this.socket.destroy(), 250).unref();
    });
  }

  protected async exchangeFrame(
    frame: Uint8Array,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    await new Promise<void>((resolve, reject) =>
      this.socket.write(frame, (error) => (error ? reject(error) : resolve())),
    );
    return withTimeout(
      async (bounded) => {
        const header = await this.readBytes(2, bounded);
        const length = header.readUInt16LE(0);
        if (length < 3 || length > 65_535)
          throw new DeviceOperationError("protocol", "Invalid EV3 TCP frame length.");
        const rest = await this.readBytes(length, bounded);
        return Uint8Array.from(Buffer.concat([header, rest]));
      },
      signal,
      timeoutMs,
    );
  }

  protected async sendFrame(frame: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) =>
      this.socket.write(frame, (error) => (error ? reject(error) : resolve())),
    );
  }

  private async readBytes(length: number, signal: AbortSignal): Promise<Buffer> {
    while (this.#buffer.length < length) {
      if (this.socket.destroyed)
        throw new DeviceOperationError("connection", "EV3 closed the TCP connection.");
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = (): void => {
          const index = this.#waiters.indexOf(wake);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason);
        };
        this.#waiters.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    const result = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return result;
  }
}

export interface WiFiConnectOptions {
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export class WiFiTransport implements DeviceTransport {
  async discover(signal: AbortSignal): Promise<DeviceDescriptor[]> {
    return withTimeout(
      (bounded) =>
        new Promise<DeviceDescriptor[]>((resolve, reject) => {
          const socket = dgram.createSocket("udp4");
          const devices = new Map<string, DeviceDescriptor>();
          const finish = (): void => {
            socket.close();
            resolve([...devices.values()]);
          };
          const abort = (): void => {
            socket.close();
            if (signal.aborted)
              reject(new DeviceOperationError("cancelled", "Discovery cancelled."));
            else resolve([...devices.values()]);
          };
          bounded.addEventListener("abort", abort, { once: true });
          socket.on("message", (message, remote) => {
            const descriptor = parseAdvertisement(message.toString("utf8"), remote.address);
            if (descriptor) devices.set(descriptor.id, descriptor);
          });
          socket.once("error", (error) => reject(normalizeDeviceError(error, "connection")));
          socket.bind(DISCOVERY_PORT, "0.0.0.0", () => setTimeout(finish, 2500));
        }),
      signal,
      3000,
    );
  }

  async connect(
    target: DeviceDescriptor,
    signal: AbortSignal,
    options: WiFiConnectOptions = {},
  ): Promise<EV3DeviceSession> {
    if (!target.address)
      throw new DeviceOperationError("connection", "A Wi-Fi address is required.");
    const socket = await withTimeout(
      (bounded) =>
        new Promise<net.Socket>((resolve, reject) => {
          bounded.throwIfAborted();
          const client = net.createConnection({ host: target.address!, port: EV3_PORT });
          const cleanup = () => {
            bounded.removeEventListener("abort", aborted);
            client.removeListener("connect", connected);
            client.removeListener("error", failed);
            client.removeListener("close", closed);
          };
          const failed = (error: Error) => {
            cleanup();
            client.destroy();
            reject(error);
          };
          const aborted = () => failed(bounded.reason);
          const closed = () =>
            failed(new DeviceOperationError("connection", "EV3 closed the connection."));
          const connected = () => {
            cleanup();
            resolve(client);
          };
          client.once("connect", connected);
          client.once("error", failed);
          client.once("close", closed);
          bounded.addEventListener("abort", aborted, { once: true });
        }),
      signal,
      options.connectTimeoutMs ?? 5000,
    );
    try {
      const accepted = await withTimeout(
        (bounded) =>
          new Promise<boolean>((resolve, reject) => {
            bounded.throwIfAborted();
            const cleanup = () => {
              socket.removeListener("data", onData);
              socket.removeListener("error", onError);
              socket.removeListener("close", onClose);
              bounded.removeEventListener("abort", onAbort);
            };
            const onData = (data: Buffer) => {
              cleanup();
              resolve(data.toString("ascii").includes("Accept:EV340"));
            };
            const onError = (error: Error) => {
              cleanup();
              reject(error);
            };
            const onAbort = () => onError(bounded.reason);
            const onClose = () =>
              onError(new DeviceOperationError("connection", "EV3 closed the handshake."));
            socket.once("data", onData);
            socket.once("error", onError);
            socket.once("close", onClose);
            bounded.addEventListener("abort", onAbort, { once: true });
            const serial = target.serialNumber ?? "";
            socket.write(`GET /target?sn=${serial} VMTP1.0\r\nProtocol: EV3\r\n\r\n`);
          }),
        signal,
        options.handshakeTimeoutMs ?? 3000,
      );
      if (!accepted)
        throw new DeviceOperationError("protocol", "EV3 rejected the Wi-Fi handshake.");
      return new EV3DeviceSession(target, new TcpConnection(socket));
    } catch (error) {
      socket.destroy();
      throw normalizeDeviceError(error, "connection");
    }
  }
}
