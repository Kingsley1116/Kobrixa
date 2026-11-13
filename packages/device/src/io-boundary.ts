import type { Ev3Connection } from "./contracts.js";
export type DeviceIoStep = "motor" | "file-transfer" | "ordinary";
export interface DeviceIoBoundary {
  beforeExchange(step: DeviceIoStep): void;
  timeoutMs(step: DeviceIoStep): number;
  afterExchange(step: DeviceIoStep): void;
}
export interface DeviceIoBinding {
  readonly step: DeviceIoStep;
  readonly signal: AbortSignal;
  readonly boundary: DeviceIoBoundary;
  exchange<T>(
    payload: Uint8Array,
    invoke: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  ): Promise<T>;
}
export function deviceIoStep(payload: Uint8Array, fallback: DeviceIoStep): DeviceIoStep {
  if (payload[0] === 1 && payload[1] === 0x98) return "ordinary";
  return payload[0] === 1 && [0x92, 0x93, 0x94, 0x95, 0x99, 0x9a].includes(payload[1] ?? -1)
    ? "file-transfer"
    : fallback;
}
export function bindDeviceConnection(
  connection: Ev3Connection,
  binding: DeviceIoBinding,
): Ev3Connection {
  const run = async <T>(
    payload: Uint8Array,
    requested: number,
    invoke: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  ): Promise<T> => {
    const step = deviceIoStep(payload, binding.step);
    const closing = payload[0] === 1 && payload[1] === 0x98;
    if (!closing) binding.boundary.beforeExchange(step);
    // Original-operation close has its own broker cleanup deadline. Do not
    // reject it merely because the ordinary work budget has expired.
    const remaining = closing ? 5000 : binding.boundary.timeoutMs(step);
    const limit = Math.min(
      requested,
      remaining,
      step === "motor" ? 2000 : step === "file-transfer" ? 10000 : 5000,
    );
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("deadline");
    const value = await binding.exchange(payload, (signal, remaining) =>
      invoke(signal, Math.min(limit, remaining)),
    );
    if (!closing) binding.boundary.afterExchange(step);
    return value;
  };
  return {
    ...(connection.onDisconnect
      ? { onDisconnect: (listener: (error: Error) => void) => connection.onDisconnect!(listener) }
      : {}),
    exchange: (payload, _signal, timeoutMs = 5000) =>
      run(payload, timeoutMs, (signal, timeout) => connection.exchange(payload, signal, timeout)),
    transmit: (payload, _signal) =>
      run(payload, 5000, (signal) => connection.transmit(payload, signal)),
    close: () => connection.close(),
  };
}
