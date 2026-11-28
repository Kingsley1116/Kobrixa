import { describe, expect, it } from "vitest";
import { csvCell, recordingCsv } from "../../../../../plugins/sensor-lab/src/model/csv.js";
import { identityCalibration } from "../../../../../plugins/sensor-lab/src/model/calibration.js";
import {
  snapshotPublicSource,
  publicFrame,
} from "../../../../../plugins/sensor-lab/src/model/data.js";
import type { ChannelDefinition } from "../../../../../packages/plugin-protocol/src/device-types.js";
function publicSource(id = "a") {
  return snapshotPublicSource(
    {
      channelId: id,
      kind: "input",
      portId: "in:1",
      typeId: "opaque:type",
      modeId: "opaque:mode",
      component: 2,
      name: "sensor",
      modeName: "distance",
      unit: "cm",
      decimals: 1,
      state: "ready",
    } as ChannelDefinition,
    { providerId: "test:provider", sessionId: "session", sourceRevision: 3 },
  );
}
const origin = { providerId: "test:provider", sessionId: "session", sessionElapsedMs: 0 };
function recording() {
  const sources = [publicSource("a"), publicSource("b")];
  return {
    schemaVersion: 2 as const,
    id: "record",
    name: "trial",
    startedAt: 0,
    durationMs: 10,
    frameCount: 1,
    recordingOrigin: origin,
    channels: sources.map((source) => ({ source, calibration: identityCalibration("cm") })),
    frames: [
      publicFrame(
        sources,
        {
          sequence: 2,
          sampledAt: 10,
          elapsedMs: 10,
          sourceRevision: 3,
          status: "ok",
          program: "stopped",
          values: [
            { channelId: "b", value: null },
            { channelId: "a", value: -5 },
          ],
        },
        0,
        origin,
      ),
    ],
  };
}

it("protects all textual cells including leading control/whitespace and keeps numbers numeric", () => {
  for (const text of ["=x", "+x", "-5", "@x", "\tx", "\rx", "\nx", "  =x", "\u0001 +x"])
    expect(csvCell(text).replace(/^"/, "").startsWith("'")).toBe(true);
  expect(csvCell(-5)).toBe("-5");
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
});
it("exports raw rows with explicit public identity and gaps and validates dates", () => {
  const r = recording();
  r.name = "  =formula";
  const result = recordingCsv(r);
  expect(result.startsWith("\uFEFF")).toBe(true);
  expect(result).toContain("\r\n");
  expect(result).toContain("'  =formula");
  expect(result).toContain("opaque:type");
  expect(result).toContain("source_revision");
  expect(result).toContain(",-5,-5,");
  expect(result.split("\r\n")).toHaveLength(4);
  expect(() => recordingCsv({ ...r, startedAt: 8.64e15 + 1 })).toThrow(/date/);
});

it("protects textual metadata uniformly and includes frame sequence/gap provenance", () => {
  const r = recording();
  const source = r.channels[0]!.source;
  if (source.origin !== "public") throw Error("fixture");
  r.channels[0] = {
    ...r.channels[0]!,
    source: {
      ...source,
      channel: {
        ...source.channel,
        name: "\n=label",
        modeName: "\tmode",
        typeId: " =type",
        unit: "-unit",
      },
      provenance: { ...source.provenance, providerId: " +provider" },
    },
    calibration: { ...r.channels[0]!.calibration, unit: "@unit" },
  };
  r.frames[0] = { ...r.frames[0]!, gap: { fromSequence: 0, toSequence: 1, reason: "overflow" } };
  const result = recordingCsv(r);
  for (const value of ["'\n=label", "'\tmode", "' =type", "'-unit", "' +provider", "'@unit"])
    expect(result).toContain(value);
  expect(result).toContain(",0,1,overflow,");
  expect(() => recordingCsv({ ...r, endedAt: Infinity })).toThrow(/date/);
  expect(() =>
    recordingCsv({ ...r, frames: [{ ...r.frames[0]!, sampledAt: 8.64e15 + 1 }] }),
  ).toThrow(/date/);
});

it("exports recording time separately from original public session time and origin", () => {
  const record = recording();
  record.recordingOrigin = { ...record.recordingOrigin, sessionElapsedMs: 1_800_001 };
  record.frames[0] = { ...record.frames[0]!, sessionElapsedMs: 1_800_011 };
  const lines = recordingCsv(record).slice(1).trimEnd().split("\r\n");
  const headers = lines[0]!.split(",");
  const rows = lines.slice(1).map((line) => line.split(","));
  for (const row of rows) {
    expect(row[headers.indexOf("elapsed_ms")]).toBe("10");
    expect(row[headers.indexOf("session_elapsed_ms")]).toBe("1800011");
    expect(row[headers.indexOf("recording_origin_session_elapsed_ms")]).toBe("1800001");
    expect(row[headers.indexOf("host_received_at")]).toBe("1970-01-01T00:00:00.010Z");
  }
});

import type { SensorRecording } from "../../shared/sensor-lab.js";
import { channelKey, sensorRecordingCsv } from "./legacy-oracle.js";
// Transferred baseline assertions: f822f3c main/sensor-lab/csv.test.ts.
describe("frozen f822f3c sensor recording CSV", () => {
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
