import type { DeviceDescriptor, DeviceTransport } from "./contracts.js";
import type * as NodeHidModule from "node-hid";
import { DeviceOperationError, normalizeDeviceError } from "./errors.js";
import { FramedConnection } from "./framing.js";
import { EV3DeviceSession } from "./session.js";

const LEGO_VENDOR_ID = 0x0694;
const EV3_PRODUCT_ID = 0x0005;

type NodeHid = typeof NodeHidModule;
type HidDevice = InstanceType<NodeHid["HID"]>;

export function trimHidReply(data: Uint8Array): Uint8Array {
  const report = data[0] === 0 && data.length > 5 ? data.slice(1) : data;
  if (report.length < 2) return report;
  const frameLength = new DataView(report.buffer, report.byteOffset, report.byteLength).getUint16(
    0,
    true,
  );
  const totalLength = frameLength + 2;
  return totalLength <= report.length ? report.slice(0, totalLength) : report;
}

async function loadHid(): Promise<NodeHid> {
  try {
    return await import("node-hid");
  } catch (error) {
    throw new DeviceOperationError(
      "not-found",
      "USB support is unavailable because node-hid could not be loaded.",
      true,
      { cause: error },
    );
  }
}

export class HidConnection extends FramedConnection {
  private closed = false;
  private failure: DeviceOperationError | undefined;
  private readonly listeners = new Set<(error: Error) => void>();
  private pending: { resolve(data: Uint8Array): void; reject(error: Error): void } | undefined;

  constructor(private readonly device: HidDevice) {
    super();
    device.on("error", this.onError);
    device.on("data", this.onData);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending?.reject(new DeviceOperationError("connection", "USB connection closed."));
    this.listeners.clear();
    // node-hid stops its continuous reader and removes handlers when closed.
    this.device.close();
  }

  private onData = (data: Uint8Array): void => {
    if (!this.closed && !this.failure) this.pending?.resolve(trimHidReply(data));
  };

  private onError = (error: Error): void => {
    this.fail(normalizeDeviceError(error, "connection"));
  };

  private fail(error: DeviceOperationError): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    this.pending?.reject(error);
    for (const listener of this.listeners) listener(error);
    void this.close().catch(() => {});
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new DeviceOperationError("connection", "USB connection closed.");
  }

  protected async exchangeFrame(
    frame: Uint8Array,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    this.assertOpen();
    return new Promise<Uint8Array>((resolve, reject) => {
      const finish = (error?: Error, data?: Uint8Array): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending = undefined;
        if (error) reject(error);
        else resolve(data!);
      };
      // A cancelled exchange cannot reuse the handle: its late reply could be
      // mistaken for the next request's response.
      const abort = (): void => {
        const error = normalizeDeviceError(signal.reason, "cancelled");
        finish(error);
        this.fail(new DeviceOperationError("connection", "USB exchange was interrupted."));
      };
      const timer = setTimeout(
        () => this.fail(new DeviceOperationError("timeout", "USB reply timed out.")),
        timeoutMs,
      );
      this.pending = {
        resolve: (data) => finish(undefined, data),
        reject: (error) => finish(error),
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.device.write([0, ...frame]);
      } catch (error) {
        this.onError(normalizeDeviceError(error, "connection"));
      }
    });
  }

  protected async sendFrame(frame: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.assertOpen();
    try {
      this.device.write([0, ...frame]);
    } catch (error) {
      const normalized = normalizeDeviceError(error, "connection");
      this.fail(normalized);
      throw normalized;
    }
  }
}

export class UsbTransport implements DeviceTransport {
  async discover(signal: AbortSignal): Promise<DeviceDescriptor[]> {
    signal.throwIfAborted();
    const HID = await loadHid();
    signal.throwIfAborted();
    try {
      return (await HID.devicesAsync(LEGO_VENDOR_ID, EV3_PRODUCT_ID)).map((device, index) => ({
        id: `usb:${device.serialNumber ?? device.path ?? index}`,
        name: device.product ?? "LEGO EV3",
        transport: "usb" as const,
        ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
        ...(device.path ? { metadata: { path: device.path } } : {}),
      }));
    } catch (error) {
      throw normalizeDeviceError(error, "permission");
    }
  }

  async connect(target: DeviceDescriptor, signal: AbortSignal): Promise<EV3DeviceSession> {
    signal.throwIfAborted();
    const HID = await loadHid();
    signal.throwIfAborted();
    try {
      const path = target.metadata?.path;
      const handle = path ? new HID.HID(path) : new HID.HID(LEGO_VENDOR_ID, EV3_PRODUCT_ID);
      return new EV3DeviceSession(target, new HidConnection(handle));
    } catch (error) {
      throw normalizeDeviceError(error, "permission");
    }
  }
}
