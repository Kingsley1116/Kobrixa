import type { UiScalar } from "@kobrixa/plugin-protocol";
import { calibrate, validateCalibration } from "./model/calibration.js";
import type { SensorCalibration } from "./model/data.js";

const numeric = [
  ["source-a", "sourceA"],
  ["source-b", "sourceB"],
  ["target-a", "targetA"],
  ["target-b", "targetB"],
  ["zero-offset", "zeroOffset"],
] as const;
export function calibrationDraft(form: Readonly<Record<string, UiScalar>>): SensorCalibration {
  const values = numeric.map(([field]) => {
    const text = form[field];
    if (typeof text !== "string" || !text.trim() || !Number.isFinite(Number(text)))
      throw new Error(`Invalid calibration field: ${field}`);
    return Number(text);
  });
  if (typeof form["two-point"] !== "boolean" || typeof form.unit !== "string")
    throw new Error("Invalid calibration draft");
  const result: SensorCalibration = {
    twoPoint: form["two-point"],
    sourceA: values[0]!,
    sourceB: values[1]!,
    targetA: values[2]!,
    targetB: values[3]!,
    zeroOffset: values[4]!,
    unit: form.unit,
  };
  const error = validateCalibration(result);
  if (error) throw new Error(error);
  return result;
}
export function calibrationForm(calibration: SensorCalibration): Record<string, UiScalar> {
  return {
    "two-point": calibration.twoPoint,
    unit: calibration.unit,
    ...Object.fromEntries(numeric.map(([field, key]) => [field, String(calibration[key])])),
  };
}
export function draftZero(form: Readonly<Record<string, UiScalar>>, raw: number): string {
  const calibration = calibrationDraft({ ...form, "zero-offset": "0" });
  const offset = calibrate(raw, calibration);
  if (offset === null) throw new Error("Calibration overflow");
  return String(offset);
}
export function draftSlot(form: Readonly<Record<string, UiScalar>>): number {
  if (typeof form.slot !== "string" || !/^[0-3]$/.test(form.slot))
    throw new Error("Invalid channel slot");
  return Number(form.slot);
}
