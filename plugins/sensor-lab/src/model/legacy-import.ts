import {
  calibrationSnapshot,
  immutableSnapshot,
  integer,
  finite,
  text,
  object,
  requireModel,
  validateLegacyChannel,
  validateFrames,
  validateTerminal,
  snapshotRecording,
  ModelError,
  LIMITS,
} from "./data.js";
import type {
  Result,
  Recording,
  CalibrationProfile,
  LegacyDevice,
  Frame,
  StopReason,
} from "./data.js";

export const MAX_LEGACY_BYTES = 8 * 1024 * 1024;
function uuid(value: unknown, path: string): asserts value is string {
  requireModel(
    typeof value === "string" &&
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(
        value,
      ),
    path,
    "uuid",
  );
}
function decode<T>(
  bytes: Uint8Array,
  expectedId: string,
  map: (value: unknown) => T & { id: string },
): Result<T> {
  if (bytes.byteLength > MAX_LEGACY_BYTES)
    return { ok: false, errors: [{ path: "bytes", code: "size" }] };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, errors: [{ path: "bytes", code: "encoding-or-json" }] };
  }
  try {
    const candidate = map(value);
    requireModel(candidate.id === expectedId, "id", "identity-mismatch");
    return { ok: true, value: immutableSnapshot(candidate) };
  } catch (error) {
    if (error instanceof ModelError)
      return { ok: false, errors: [{ path: error.path, code: error.code }] };
    return { ok: false, errors: [{ path: "value", code: "invalid" }] };
  }
}
function profile(value: unknown) {
  const x = object(value, ["id", "name", "source", "calibration"], [], "profile");
  uuid(x.id, "id");
  text(x.name, 160, "name", true);
  return {
    id: x.id,
    name: x.name,
    source: { origin: "legacy-ev3" as const, channel: validateLegacyChannel(x.source) },
    calibration: calibrationSnapshot(x.calibration),
  };
}
export function importLegacyCalibration(
  bytes: Uint8Array,
  expectedId: string,
): Result<CalibrationProfile> {
  return decode(bytes, expectedId, (value) => {
    const envelope = object(value, ["schemaVersion", "profile"]);
    requireModel(envelope.schemaVersion === 1, "schemaVersion", "unsupported-version");
    return { schemaVersion: 2, ...profile(envelope.profile) };
  });
}
function device(value: unknown): LegacyDevice {
  const x = object(
    value,
    ["id", "name", "transport"],
    ["address", "serialNumber", "metadata"],
    "device",
  );
  requireModel(typeof x.id === "string" && x.id.length >= 1 && x.id.length <= 1024, "device.id");
  text(x.name, 160, "device.name");
  requireModel(["usb", "wifi", "mock"].includes(x.transport as string), "device.transport");
  for (const k of ["address", "serialNumber"])
    if (x[k] !== undefined)
      requireModel(typeof x[k] === "string" && x[k].length <= 1024, `device.${k}`);
  if (x.metadata !== undefined) {
    requireModel(
      x.metadata !== null && typeof x.metadata === "object" && !Array.isArray(x.metadata),
      "metadata",
    );
    for (const [key, v] of Object.entries(x.metadata)) {
      requireModel(key.length <= 1024, "metadata.key");
      requireModel(typeof v === "string" && v.length <= 4096, "metadata.value");
    }
  }
  return x as unknown as LegacyDevice;
}
export function importLegacyRecording(bytes: Uint8Array, expectedId: string): Result<Recording> {
  return decode(bytes, expectedId, (value) => {
    const x = object(
      value,
      [
        "schemaVersion",
        "id",
        "name",
        "startedAt",
        "durationMs",
        "frameCount",
        "device",
        "channels",
        "frames",
      ],
      ["endedAt", "reason"],
    );
    requireModel(x.schemaVersion === 1, "schemaVersion", "unsupported-version");
    uuid(x.id, "id");
    text(x.name, 160, "name", true);
    finite(x.startedAt, 0, Number.MAX_VALUE, "startedAt");
    finite(x.durationMs, 0, LIMITS.durationMs, "durationMs");
    integer(x.frameCount, 0, LIMITS.frames, "frameCount");
    const legacyDevice = device(x.device);
    requireModel(
      Array.isArray(x.channels) && x.channels.length >= 1 && x.channels.length <= LIMITS.channels,
      "channels",
      "limit",
    );
    const channels = x.channels.map((value) => {
      const c = object(value, ["source", "calibration"], [], "channel");
      return {
        source: { origin: "legacy-ev3" as const, channel: validateLegacyChannel(c.source) },
        calibration: calibrationSnapshot(c.calibration),
      };
    });
    requireModel(Array.isArray(x.frames), "frames");
    const frames = x.frames as Frame[];
    validateFrames(frames, channels.length, x.durationMs, true);
    requireModel(x.frameCount === frames.length, "frameCount");
    const terminal = {
      ...(x.endedAt !== undefined ? { endedAt: x.endedAt as number } : {}),
      ...(x.reason !== undefined ? { reason: x.reason as StopReason } : {}),
    };
    validateTerminal(terminal);
    return snapshotRecording({
      schemaVersion: 2,
      id: x.id,
      name: x.name,
      startedAt: x.startedAt,
      durationMs: x.durationMs,
      frameCount: x.frameCount,
      channels,
      frames,
      provenance: { origin: "legacy-ev3", schemaVersion: 1, device: legacyDevice },
      ...(terminal.endedAt === undefined
        ? { endedAt: frames.at(-1)?.sampledAt ?? x.startedAt, reason: "interrupted" as const }
        : terminal),
    });
  });
}
