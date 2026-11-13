import type { ChannelDefinition, TelemetryFrame } from "@kobrixa/plugin-protocol";
import { validateCalibration } from "./calibration.js";

export const LIMITS = {
  channels: 4,
  durationMs: 1_800_000,
  frames: 3600,
  recordings: 50,
  checkpointMs: 5000,
  previewMs: 60_000,
  previewFrames: 240,
  seriesPerChart: 2,
  pointsPerSeries: 800,
  charts: 4,
  totalPoints: 6400,
  tableRows: 50,
  dialogs: 1,
} as const;
export interface SensorChannel {
  id: string;
  kind: "input" | "output";
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
export interface Provenance {
  providerId: string;
  sessionId: string;
  sourceRevision: number;
}
export type SourceSnapshot =
  | { origin: "legacy-ev3"; channel: SensorChannel }
  | { origin: "public"; channel: ChannelDefinition; provenance: Provenance };
export interface CalibratedChannel {
  source: SourceSnapshot;
  calibration: SensorCalibration;
}
export interface Frame {
  sampledAt: number;
  /** Recording-relative monotonic time, including for legacy imports. */
  elapsedMs: number;
  /** Original public TelemetryFrame.elapsedMs; absent on legacy frames. */
  sessionElapsedMs?: number;
  values: Array<number | null>;
  status: "ok" | "busy" | "error" | "gap";
  segment: number;
  sequence?: number;
  sourceRevision?: number;
  gap?: TelemetryFrame["gap"];
  program?: TelemetryFrame["program"];
}
export type StopReason =
  | "manual"
  | "limit"
  | "source-changed"
  | "disconnected"
  | "suspend"
  | "close"
  | "update"
  | "interrupted";
export interface LegacyDevice {
  id: string;
  name: string;
  transport: "usb" | "wifi" | "mock";
  address?: string;
  serialNumber?: string;
  metadata?: Record<string, string>;
}
export interface Recording {
  schemaVersion: 2;
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  frameCount: number;
  /** Required for public recordings, even before their first frame. */
  recordingOrigin?: RecordingMonotonicOrigin;
  reason?: StopReason;
  provenance?: { origin: "legacy-ev3"; schemaVersion: 1; device: LegacyDevice };
  channels: CalibratedChannel[];
  frames: Frame[];
}
/** Recording start expressed in the public session's monotonic time domain. */
export interface RecordingMonotonicOrigin {
  providerId: string;
  sessionId: string;
  sessionElapsedMs: number;
}
export interface CalibrationProfile {
  schemaVersion: 2;
  id: string;
  name: string;
  source: SourceSnapshot;
  calibration: SensorCalibration;
}
export interface ValidationIssue {
  path: string;
  code: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; errors: ValidationIssue[] };
export class ModelError extends Error {
  constructor(
    public readonly path: string,
    public readonly code: string,
  ) {
    super(`${path}: ${code}`);
  }
}
export function requireModel(
  condition: unknown,
  path: string,
  code = "invalid",
): asserts condition {
  if (!condition) throw new ModelError(path, code);
}
export function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  path = "value",
): Record<string, unknown> {
  requireModel(value !== null && typeof value === "object" && !Array.isArray(value), path);
  const obj = value as Record<string, unknown>;
  requireModel(
    required.every((k) => Object.hasOwn(obj, k)) &&
      Object.keys(obj).every((k) => required.includes(k) || optional.includes(k)),
    path,
    "shape",
  );
  return obj;
}
export function text(
  value: unknown,
  max: number,
  path: string,
  nonempty = false,
): asserts value is string {
  requireModel(
    typeof value === "string" &&
      value.length <= max &&
      !value.includes("\0") &&
      (!nonempty || value.trim().length > 0),
    path,
  );
}
export function finite(
  value: unknown,
  min: number,
  max: number,
  path: string,
): asserts value is number {
  requireModel(
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
    path,
  );
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  path: string,
): asserts value is number {
  finite(value, min, max, path);
  requireModel(Number.isInteger(value), path);
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
export function validateLegacyChannel(value: unknown): SensorChannel {
  const x = object(
    value,
    ["id", "kind", "port", "type", "mode", "channel", "name", "modeName", "unit", "decimals"],
    [],
    "source",
  );
  requireModel(x.kind === "input" || x.kind === "output", "source.kind");
  integer(x.port, 0, 3, "source.port");
  integer(x.type, 1, 124, "source.type");
  integer(x.mode, 0, 7, "source.mode");
  integer(x.channel, 0, 7, "source.channel");
  integer(x.decimals, 0, 6, "source.decimals");
  text(x.id, 300, "source.id");
  for (const k of ["name", "modeName", "unit"]) text(x[k], 160, `source.${k}`);
  const source = x as unknown as SensorChannel;
  requireModel(source.id === channelKey(source), "source.id", "identity");
  requireModel(
    source.kind === "input" ||
      ([7, 8].includes(source.type) &&
        source.mode === 0 &&
        source.channel === 0 &&
        source.unit === "deg"),
    "source",
    "motor",
  );
  return source;
}
export function calibrationSnapshot(value: unknown): SensorCalibration {
  const x = object(
    value,
    ["twoPoint", "sourceA", "sourceB", "targetA", "targetB", "zeroOffset", "unit"],
    [],
    "calibration",
  );
  requireModel(typeof x.twoPoint === "boolean", "calibration.twoPoint");
  const c = x as unknown as SensorCalibration;
  requireModel(!validateCalibration(c), "calibration", validateCalibration(c) ?? "invalid");
  return immutableSnapshot(c);
}
export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (x: unknown): void => {
    if (x !== null && typeof x === "object") {
      Object.values(x).forEach(freeze);
      Object.freeze(x);
    }
  };
  freeze(copy);
  return copy;
}
/** Callers supply validated public DTOs; preserve opaque IDs and all display metadata. */
export function snapshotPublicSource(
  channel: ChannelDefinition,
  provenance: Provenance,
): Extract<SourceSnapshot, { origin: "public" }> {
  integer(provenance.sourceRevision, 0, Number.MAX_SAFE_INTEGER, "sourceRevision");
  text(provenance.providerId, 160, "providerId", true);
  text(provenance.sessionId, 160, "sessionId", true);
  text(channel.channelId, 160, "channelId", true);
  return immutableSnapshot({ origin: "public", channel, provenance });
}
export function publicFrame(
  sources: readonly SourceSnapshot[],
  frame: TelemetryFrame,
  segment: number,
  recordingOrigin: RecordingMonotonicOrigin,
): Frame {
  requireModel(sources.length > 0 && sources.length <= LIMITS.channels, "sources", "limit");
  requireModel(
    sources.every(
      (s) => s.origin === "public" && s.provenance.sourceRevision === frame.sourceRevision,
    ),
    "sourceRevision",
    "revision",
  );
  const first = sources[0] as Extract<SourceSnapshot, { origin: "public" }>;
  validateRecordingOrigin(recordingOrigin, first.provenance);
  finite(frame.elapsedMs, 0, Number.MAX_VALUE, "sessionElapsedMs");
  requireModel(
    sources.every(
      (s) =>
        s.origin === "public" &&
        s.provenance.providerId === first.provenance.providerId &&
        s.provenance.sessionId === first.provenance.sessionId,
    ),
    "sources",
    "session",
  );
  const ids = sources.map((s) => (s.origin === "public" ? s.channel.channelId : ""));
  requireModel(new Set(ids).size === ids.length, "sources", "duplicate");
  const values = new Map(frame.values.map((v) => [v.channelId, v.value]));
  requireModel(values.size === frame.values.length, "values", "duplicate");
  requireModel(
    ids.every((id) => values.has(id)),
    "values",
    "missing-channel",
  );
  const result: Frame = {
    sampledAt: frame.sampledAt,
    elapsedMs: frame.elapsedMs - recordingOrigin.sessionElapsedMs,
    sessionElapsedMs: frame.elapsedMs,
    values: ids.map((id) => values.get(id)!),
    status: frame.status,
    segment,
    sequence: frame.sequence,
    sourceRevision: frame.sourceRevision,
    program: frame.program,
    ...(frame.gap ? { gap: frame.gap } : {}),
  };
  validateFrames([result], sources.length, LIMITS.durationMs, false);
  return immutableSnapshot(result);
}
function validateRecordingOrigin(
  origin: RecordingMonotonicOrigin | undefined,
  provenance: Provenance,
): asserts origin is RecordingMonotonicOrigin {
  requireModel(origin !== undefined, "recordingOrigin", "required");
  finite(origin.sessionElapsedMs, 0, Number.MAX_VALUE, "recordingOrigin.sessionElapsedMs");
  requireModel(
    origin.providerId === provenance.providerId && origin.sessionId === provenance.sessionId,
    "recordingOrigin",
    "session",
  );
}
export function validateFrames(
  frames: readonly Frame[],
  count: number,
  duration: number,
  legacy: boolean,
): void {
  requireModel(frames.length <= LIMITS.frames, "frames", "limit");
  frames.forEach((f, i) => {
    object(
      f,
      ["sampledAt", "elapsedMs", "values", "status", "segment"],
      legacy ? [] : ["sessionElapsedMs", "sequence", "sourceRevision", "gap", "program"],
      `frames.${i}`,
    );
    finite(f.sampledAt, 0, Number.MAX_VALUE, "sampledAt");
    finite(f.elapsedMs, 0, duration, "elapsedMs");
    if (f.sessionElapsedMs !== undefined)
      finite(f.sessionElapsedMs, 0, Number.MAX_VALUE, "sessionElapsedMs");
    integer(f.segment, 0, Number.MAX_SAFE_INTEGER, "segment");
    requireModel(
      (legacy ? ["ok", "busy", "error"] : ["ok", "busy", "error", "gap"]).includes(f.status),
      "status",
    );
    requireModel(Array.isArray(f.values) && f.values.length === count, "values", "cardinality");
    for (const value of f.values)
      if (value !== null) finite(value, -Number.MAX_VALUE, Number.MAX_VALUE, "value");
    requireModel(i === 0 || f.elapsedMs >= frames[i - 1]!.elapsedMs, "elapsedMs", "order");
    if (f.sequence !== undefined) integer(f.sequence, 0, Number.MAX_SAFE_INTEGER, "sequence");
    if (f.sourceRevision !== undefined)
      integer(f.sourceRevision, 0, Number.MAX_SAFE_INTEGER, "sourceRevision");
    if (f.program !== undefined)
      requireModel(["stopped", "running", "unknown"].includes(f.program), "program");
    if (f.gap !== undefined) {
      const g = object(f.gap, ["fromSequence", "toSequence", "reason"], [], "gap");
      integer(g.fromSequence, 0, Number.MAX_SAFE_INTEGER, "gap.fromSequence");
      integer(g.toSequence, g.fromSequence, Number.MAX_SAFE_INTEGER, "gap.toSequence");
      requireModel(["busy", "overflow", "read-error"].includes(g.reason as string), "gap.reason");
    }
  });
}
export function validateTerminal(record: { endedAt?: number; reason?: StopReason }): void {
  requireModel(
    (record.endedAt === undefined) === (record.reason === undefined),
    "terminal",
    "paired",
  );
  if (record.endedAt !== undefined) finite(record.endedAt, 0, Number.MAX_VALUE, "endedAt");
  if (record.reason !== undefined)
    requireModel(
      [
        "manual",
        "limit",
        "source-changed",
        "disconnected",
        "suspend",
        "close",
        "update",
        "interrupted",
      ].includes(record.reason),
      "reason",
    );
}
export function snapshotRecording(record: Recording): Recording {
  requireModel(record.schemaVersion === 2, "schemaVersion");
  text(record.id, 160, "id", true);
  text(record.name, 160, "name", true);
  finite(record.startedAt, 0, Number.MAX_VALUE, "startedAt");
  finite(record.durationMs, 0, LIMITS.durationMs, "durationMs");
  requireModel(
    record.channels.length >= 1 && record.channels.length <= LIMITS.channels,
    "channels",
    "limit",
  );
  const ids = record.channels.map(({ source, calibration }) => {
    calibrationSnapshot(calibration);
    if (source.origin === "legacy-ev3") return `legacy:${validateLegacyChannel(source.channel).id}`;
    requireModel(source.origin === "public", "source.origin");
    snapshotPublicSource(source.channel, source.provenance);
    return `public:${source.channel.channelId}`;
  });
  requireModel(new Set(ids).size === ids.length, "channels", "duplicate");
  validateFrames(record.frames, record.channels.length, record.durationMs, false);
  const publicSources = record.channels.map((c) => c.source).filter((s) => s.origin === "public");
  requireModel(
    publicSources.length === 0 || publicSources.length === record.channels.length,
    "channels",
    "mixed-origin",
  );
  if (publicSources.length) {
    const first = publicSources[0]!;
    const origin = record.recordingOrigin;
    validateRecordingOrigin(origin, first.provenance);
    requireModel(
      publicSources.every(
        (s) =>
          s.provenance.sessionId === first.provenance.sessionId &&
          s.provenance.providerId === first.provenance.providerId &&
          s.provenance.sourceRevision === first.provenance.sourceRevision,
      ),
      "channels",
      "provenance",
    );
    for (const frame of record.frames) {
      finite(frame.sessionElapsedMs, 0, Number.MAX_VALUE, "sessionElapsedMs");
      requireModel(
        frame.elapsedMs === frame.sessionElapsedMs - origin.sessionElapsedMs,
        "elapsedMs",
        "recording-origin",
      );
      requireModel(
        frame.sourceRevision === first.provenance.sourceRevision &&
          frame.sequence !== undefined &&
          frame.program !== undefined,
        "frame",
        "revision",
      );
    }
  }
  requireModel(record.frameCount === record.frames.length, "frameCount");
  validateTerminal(record);
  return immutableSnapshot(record);
}
export function trimPreview<T extends { elapsedMs: number }>(frames: readonly T[]): T[] {
  const end = frames.at(-1)?.elapsedMs ?? 0;
  return frames
    .filter((f) => f.elapsedMs >= end - LIMITS.previewMs)
    .slice(-LIMITS.previewFrames)
    .map((f) => immutableSnapshot(f));
}
export function compatible(
  a: CalibratedChannel,
  b: CalibratedChannel,
  calibrated: boolean,
): boolean {
  if (
    a.source.origin !== b.source.origin ||
    (calibrated && a.calibration.unit !== b.calibration.unit)
  )
    return false;
  if (a.source.origin === "legacy-ev3" && b.source.origin === "legacy-ev3")
    return channelKey(a.source.channel) === channelKey(b.source.channel);
  if (a.source.origin === "public" && b.source.origin === "public") {
    const x = a.source.channel,
      y = b.source.channel;
    return (
      a.source.provenance.providerId === b.source.provenance.providerId &&
      x.kind === y.kind &&
      x.portId === y.portId &&
      x.typeId === y.typeId &&
      x.modeId === y.modeId &&
      x.component === y.component &&
      x.unit === y.unit
    );
  }
  return false;
}
