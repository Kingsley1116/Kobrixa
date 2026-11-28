import { channelDefinitionSchema } from "@kobrixa/plugin-protocol";
import { calibrationCode } from "./model/calibration.js";
import {
  channelKey,
  immutableSnapshot,
  validateLegacyChannel,
  type CalibratedChannel,
  type SensorCalibration,
  type SensorChannel,
  type SourceSnapshot,
} from "./model/data.js";

/** Display/code compatibility only. Never replace a public opaque channel ID or
 * use this semantic identity to authorize a device request. */
export function ev3Channel(source: SourceSnapshot): SensorChannel | null {
  if (source.origin === "legacy-ev3") {
    try {
      return immutableSnapshot(validateLegacyChannel(source.channel));
    } catch {
      return null;
    }
  }
  if (source.provenance.providerId !== "kobrixa.device-ev3") return null;
  const parsed = channelDefinitionSchema.safeParse(source.channel);
  if (!parsed.success) return null;
  const c = parsed.data;
  let kind: SensorChannel["kind"], port: number, type: number, mode: number;
  if (c.kind === "input") {
    if (
      !/^input:[0-3]$/.test(c.portId ?? "") ||
      !/^ev3:[1-9][0-9]{0,2}$/.test(c.typeId) ||
      !/^mode:[0-7]$/.test(c.modeId ?? "")
    )
      return null;
    kind = "input";
    port = Number(c.portId!.slice(6));
    type = Number(c.typeId.slice(4));
    mode = Number(c.modeId!.slice(5));
    if (type > 124) return null;
  } else if (c.kind === "output-angle") {
    if (
      !/^output:[0-3]$/.test(c.portId ?? "") ||
      !["ev3:7", "ev3:8"].includes(c.typeId) ||
      c.modeId !== null ||
      c.component !== 0 ||
      c.unit !== "deg"
    )
      return null;
    kind = "output";
    port = Number(c.portId!.slice(7));
    type = Number(c.typeId.slice(4));
    mode = 0;
  } else return null;
  const value = {
    kind,
    port,
    type,
    mode,
    channel: c.component,
    name: c.name,
    modeName: c.modeName,
    unit: c.unit,
    decimals: c.decimals,
  };
  return immutableSnapshot({ id: channelKey(value), ...value });
}

export function ev3SourceKey(source: SourceSnapshot): string | null {
  const c = ev3Channel(source);
  return c ? JSON.stringify(["ev3", c.kind, c.port, c.type, c.mode, c.channel, c.unit]) : null;
}

export function compatibleEv3Sources(
  a: CalibratedChannel,
  b: CalibratedChannel,
  calibrated: boolean,
): boolean {
  if (calibrated && a.calibration.unit !== b.calibration.unit) return false;
  const left = ev3SourceKey(a.source),
    right = ev3SourceKey(b.source);
  return left !== null && right !== null && left === right;
}

export function generateEv3CalibrationCode(
  source: SourceSnapshot,
  calibration: SensorCalibration,
  locale: "en" | "zh-TW",
): { available: true; code: string } | { available: false; reason: string } {
  const channel = ev3Channel(source);
  if (!channel) return { available: false, reason: "unsupported-source" };
  try {
    return { available: true, code: calibrationCode(channel, calibration, locale) };
  } catch (error) {
    if (error instanceof RangeError) return { available: false, reason: error.message };
    throw error;
  }
}
