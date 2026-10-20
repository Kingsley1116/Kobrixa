export type DeviceIoStep = "motor" | "file-transfer" | "ordinary";
export interface DeviceIoBoundary {
  beforeExchange(step: DeviceIoStep): void;
  timeoutMs(step: DeviceIoStep): number;
  afterExchange(step: DeviceIoStep): void;
}
