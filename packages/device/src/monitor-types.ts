export type MonitorPortState = "ready" | "empty" | "initializing" | "unknown" | "error";

export interface MonitorInput {
  /** Zero-based physical input port on the local brick. */
  port: number;
  type: number;
  connection: number;
  mode: number;
  state: MonitorPortState;
  name: string;
  modeName: string;
  unit: string;
  decimals: number;
  values: Array<number | null>;
  switchable: boolean;
}

export interface MonitorOutput {
  /** Zero-based physical output port (A–D) on the local brick. */
  port: number;
  type: number;
  state: MonitorPortState;
  name: string;
  angle: number | null;
}

export interface DeviceMonitorSnapshot {
  sampledAt: number;
  battery: { percent: number | null; voltage: number | null };
  program: { status: "stopped" | "running" | "unknown"; rawStatus: number; result: number };
  inputs: MonitorInput[];
  outputs: MonitorOutput[];
}

export interface DeviceInputModes {
  port: number;
  type: number;
  modes: Array<{ mode: number; name: string }>;
}
