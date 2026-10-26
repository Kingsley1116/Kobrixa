import { expect, it } from "vitest";
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
