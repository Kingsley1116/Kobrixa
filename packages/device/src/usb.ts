import type { DeviceDescriptor, DeviceTransport } from "./contracts.js";
import type * as NodeHidModule from "node-hid";
import { DeviceOperationError, normalizeDeviceError, withTimeout } from "./errors.js";
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

class HidConnection extends FramedConnection {
  constructor(private readonly device: HidDevice) {
    super();
  }

  async close(): Promise<void> {
    this.device.close();
  }

  protected async exchangeFrame(
    frame: Uint8Array,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    try {
      this.device.write([0, ...frame]);
      const data = await withTimeout(
        () =>
          new Promise<number[]>((resolve, reject) =>
            this.device.read((error, reply) => (error ? reject(error) : resolve(reply))),
          ),
        signal,
        timeoutMs,
      );
      const bytes = Uint8Array.from(data);
      return trimHidReply(bytes);
    } catch (error) {
      throw normalizeDeviceError(error, "transfer");
    }
  }

  protected async sendFrame(frame: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      this.device.write([0, ...frame]);
    } catch (error) {
      throw normalizeDeviceError(error, "transfer");
    }
  }
}

export class UsbTransport implements DeviceTransport {
  async discover(signal: AbortSignal): Promise<DeviceDescriptor[]> {
    signal.throwIfAborted();
    const HID = await loadHid();
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
    try {
      const path = target.metadata?.path;
      const handle = path ? new HID.HID(path) : new HID.HID(LEGO_VENDOR_ID, EV3_PRODUCT_ID);
      return new EV3DeviceSession(target, new HidConnection(handle));
    } catch (error) {
      throw normalizeDeviceError(error, "permission");
    }
  }
}
