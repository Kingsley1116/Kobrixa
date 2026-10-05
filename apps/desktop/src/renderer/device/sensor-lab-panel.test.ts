import { describe, expect, it } from "vitest";
import { identityCalibration } from "../../shared/sensor-calibration.js";
import type { CalibratedChannel, SensorFrame, SensorRecording } from "../../shared/sensor-lab.js";
import {
  nearestChartValue,
  parseCalibrationDraft,
  recordingPoints,
  recordingSeries,
} from "./sensor-lab-panel.js";

const channel: CalibratedChannel = {
  source: {
    id: "input-0",
    kind: "input",
    port: 0,
    type: 29,
    mode: 0,
    channel: 0,
    name: "Color",
    modeName: "COL-REFLECT",
    unit: "%",
    decimals: 0,
  },
  calibration: { ...identityCalibration("%"), twoPoint: true, sourceA: 10, sourceB: 90 },
};
const frames: SensorFrame[] = [
  { sampledAt: 1000, elapsedMs: 0, values: [50], status: "ok", segment: 0 },
  { sampledAt: 1500, elapsedMs: 500, values: [null], status: "error", segment: 0 },
  { sampledAt: 2000, elapsedMs: 1000, values: [90], status: "ok", segment: 1 },
];
const comparison: SensorRecording = {
  schemaVersion: 1,
  id: "previous",
  name: "Previous",
  startedAt: 500,
  endedAt: 2000,
  durationMs: 1500,
  frameCount: 3,
  device: { id: "ev3", name: "EV3", transport: "usb" },
  channels: [{ ...channel, calibration: { ...identityCalibration("%"), zeroOffset: 10 } }],
  frames,
};
describe("sensor lab presentation", () => {
  it("uses each recording's immutable calibration instead of recalibrating the comparison", () => {
    const series = recordingSeries(channel, 0, frames, comparison, true, "en");
    expect(series[0]?.points[0]?.value).toBe(50);
    expect(series[1]?.points[0]?.value).toBe(40);
    expect(series[1]?.comparison).toBe(true);
    expect(recordingSeries(channel, 0, frames, comparison, false, "en")[1]?.points[0]?.value).toBe(
      50,
    );
  });
  it("omits an overlay with incompatible calibrated units but allows raw comparison", () => {
    const other = {
      ...comparison,
      channels: [{ ...channel, calibration: identityCalibration("cm") }],
    };
    expect(recordingSeries(channel, 0, frames, other, true, "en")).toHaveLength(1);
    expect(recordingSeries(channel, 0, frames, other, false, "en")).toHaveLength(2);
  });
  it("keeps null readings and explicit segment breaks", () => {
    expect(recordingPoints(frames, channel, 0, false)).toEqual([
      { time: 0, value: 50 },
      { time: 500, value: null },
      { time: 1000, value: null },
      { time: 1000, value: 90 },
    ]);
    expect(
      nearestChartValue(
        [
          { time: 0, value: 3 },
          { time: 500, value: null },
          { time: 5000, value: 4 },
        ],
        500,
      ),
    ).toBeNull();
    expect(
      nearestChartValue(
        [
          { time: 0, value: 3 },
          { time: 5000, value: 4 },
        ],
        2500,
      ),
    ).toBeNull();
  });
  it("does not turn blank calibration inputs into physical zero", () => {
    const draft = {
      twoPoint: true,
      sourceA: "10",
      sourceB: "90",
      targetA: "100",
      targetB: "0",
      zeroOffset: "0",
      unit: "%",
    };
    expect(parseCalibrationDraft(draft)).toMatchObject({ targetA: 100, targetB: 0 });
    for (const value of ["", " ", "NaN", "Infinity"])
      expect(parseCalibrationDraft({ ...draft, sourceA: value })).toBeUndefined();
  });
});
