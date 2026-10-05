import { describe, expect, it } from "vitest";
import { channelKey, type SensorRecording } from "../../shared/sensor-lab.js";
import { sensorRecordingCsv } from "./csv.js";

describe("sensor recording CSV", () => {
  it("exports BOM, escaped metadata, calibrated values and empty gaps with explicit status", () => {
    const source = {
      kind: "input" as const,
      port: 0,
      type: 29,
      mode: 0,
      channel: 0,
      name: "Color",
      modeName: "COL-REFLECT",
      unit: "%",
      decimals: 1,
    };
    const record: SensorRecording = {
      schemaVersion: 1,
      id: "0e8e71c7-e6e0-4883-ae76-15e1c5a77f13",
      name: 'Run, "one"\nnext',
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      frameCount: 3,
      reason: "manual",
      device: { id: "usb", name: "=DANGEROUS()", transport: "usb" },
      channels: [
        {
          source: { ...source, id: channelKey(source) },
          calibration: {
            twoPoint: true,
            sourceA: 0,
            sourceB: 100,
            targetA: 0,
            targetB: 10,
            zeroOffset: 1,
            unit: "ratio",
          },
        },
      ],
      frames: [
        { sampledAt: 1000, elapsedMs: 0, values: [50], status: "ok", segment: 0 },
        { sampledAt: 1500, elapsedMs: 500, values: [null], status: "busy", segment: 1 },
        { sampledAt: 2000, elapsedMs: 1000, values: [null], status: "ok", segment: 1 },
      ],
    };
    const csv = sensorRecordingCsv(record);
    expect(csv.startsWith("\uFEFFrecording_id,")).toBe(true);
    expect(csv).toContain('"Run, ""one""\nnext"');
    expect(csv).toContain("'=DANGEROUS()");
    expect(csv).toContain(",%,ratio,50,4,ok,0,");
    expect(csv).toContain(",%,ratio,,,busy,1,");
    expect(csv).toContain(",%,ratio,,,invalid,1,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
