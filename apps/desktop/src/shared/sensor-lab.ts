import type { DeviceDescriptor, DeviceMonitorSnapshot } from "@kobrixa/device";

export interface SensorChannel {
  id: string;
  kind: "input" | "output";
  /** Physical local port, zero based. */
  port: number;
  type: number;
  mode: number;
  channel: number;
  name: string;
  modeName: string;
  unit: string;
  decimals: number;
}

export interface SensorCalibration {
  twoPoint: boolean;
  sourceA: number;
  sourceB: number;
  targetA: number;
  targetB: number;
  zeroOffset: number;
  unit: string;
}

export interface CalibratedChannel {
  source: SensorChannel;
  calibration: SensorCalibration;
}

export type SensorLabStopReason =
  | "manual"
  | "limit"
  | "source-changed"
  | "disconnected"
  | "suspend"
  | "close"
  | "update"
  | "interrupted";

export interface SensorFrame {
  /** Host receipt time, not a hardware sampling clock. */
  sampledAt: number;
  elapsedMs: number;
  values: Array<number | null>;
  status: "ok" | "busy" | "error";
  segment: number;
}

export interface SensorRecordingSummary {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number | undefined;
  durationMs: number;
  frameCount: number;
  reason?: SensorLabStopReason | undefined;
}

export interface SensorRecording extends SensorRecordingSummary {
  schemaVersion: 1;
  device: DeviceDescriptor;
  channels: CalibratedChannel[];
  frames: SensorFrame[];
}

export interface CalibrationProfile {
  id: string;
  name: string;
  source: SensorChannel;
  calibration: SensorCalibration;
}

export interface MonitorUpdate {
  sessionId: string;
  sequence: number;
  status: "paused" | "waiting" | "live" | "error";
  recording?: boolean;
  snapshot?: DeviceMonitorSnapshot | undefined;
  error?: string | undefined;
}

export interface SensorLabState {
  recording: SensorRecording | undefined;
  active: boolean;
  waiting: boolean;
  saved: boolean;
  error: string | undefined;
  issues: string[];
}

export interface SensorLabStartRequest {
  sessionId: string;
  name: string;
  channels: CalibratedChannel[];
}

export interface SensorLabApi {
  getState(): Promise<SensorLabState>;
  start(request: SensorLabStartRequest): Promise<SensorLabState>;
  stop(reason?: "manual" | "close" | "update"): Promise<SensorLabState>;
  retrySave(): Promise<SensorLabState>;
  list(): Promise<SensorRecordingSummary[]>;
  read(id: string): Promise<SensorRecording>;
  delete(id: string): Promise<void>;
  listCalibrations(): Promise<CalibrationProfile[]>;
  saveCalibration(
    profile: Omit<CalibrationProfile, "id"> & { id?: string },
  ): Promise<CalibrationProfile>;
  deleteCalibration(id: string): Promise<void>;
  exportCsv(id: string): Promise<{ cancelled: boolean }>;
  onState(listener: (state: SensorLabState) => void): () => void;
}

export function channelKey(
  source: Omit<SensorChannel, "id" | "name" | "modeName" | "decimals">,
): string {
  return JSON.stringify([
    source.kind,
    source.port,
    source.type,
    source.mode,
    source.channel,
    source.unit,
  ]);
}

export function monitorChannels(snapshot: DeviceMonitorSnapshot): SensorChannel[] {
  const channels: SensorChannel[] = [];
  for (const input of snapshot.inputs) {
    if (input.state !== "ready") continue;
    input.values.forEach((_value, channel) => {
      const source = {
        kind: "input" as const,
        port: input.port,
        type: input.type,
        mode: input.mode,
        channel,
        name: input.name,
        modeName: input.modeName,
        unit: input.unit,
        decimals: input.decimals,
      };
      channels.push({ ...source, id: channelKey(source) });
    });
  }
  for (const output of snapshot.outputs) {
    if (output.state !== "ready" || ![7, 8].includes(output.type)) continue;
    const source = {
      kind: "output" as const,
      port: output.port,
      type: output.type,
      mode: 0,
      channel: 0,
      name: output.name,
      modeName: "angle",
      unit: "deg",
      decimals: 0,
    };
    channels.push({ ...source, id: channelKey(source) });
  }
  return channels;
}

export function channelReading(
  snapshot: DeviceMonitorSnapshot,
  source: SensorChannel,
): number | null {
  if (!monitorChannels(snapshot).some((current) => current.id === source.id)) return null;
  const value =
    source.kind === "input"
      ? snapshot.inputs.find((input) => input.port === source.port)?.values[source.channel]
      : snapshot.outputs.find((output) => output.port === source.port)?.angle;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
