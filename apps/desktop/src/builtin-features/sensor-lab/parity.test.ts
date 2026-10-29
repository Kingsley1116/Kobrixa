import { describe, expect, it } from "vitest";
// Frozen D0 functions, isolated from both deleted runtime candidates and new models.
import {
  sensorRecordingSchema,
  calibrationProfileSchema,
  sensorRecordingCsv,
  recordingPoints,
  nearestChartValue,
  reduceChartPoints,
  sensorChartGeometry,
} from "./legacy-oracle.js";
import {
  importLegacyRecording,
  importLegacyCalibration,
} from "../../../../../plugins/sensor-lab/src/model/legacy-import.js";
import { recordingCsv } from "../../../../../plugins/sensor-lab/src/model/csv.js";
import { calibrate } from "../../../../../plugins/sensor-lab/src/model/calibration.js";
import { cursorReading, reduceSeries } from "../../../../../plugins/sensor-lab/src/model/chart.js";
import { recordingFixture, csvFixture, chartFixture, cursorFixture } from "./parity-fixtures.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function recordings() {
  const input = structuredClone(recordingFixture.record);
  const originalBytes = bytes(input);
  const legacy = sensorRecordingSchema.parse(JSON.parse(new TextDecoder().decode(originalBytes)));
  const imported = importLegacyRecording(originalBytes, legacy.id);
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  expect(originalBytes).toEqual(bytes(input));
  expect(input).toEqual(recordingFixture.record);
  return { input, originalBytes, legacy, migrated: imported.value };
}

// Tokenize without unescaping: equality checks the exact CSV encoding as well as
// cell values, including embedded commas, doubled quotes, LF and CRLF in strings.
function csvRows(csv: string): Array<Record<string, string>> {
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv.endsWith("\r\n")).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 1; i < csv.length; i++) {
    const c = csv[i]!;
    if (c === '"') {
      cell += c;
      if (quoted && csv[i + 1] === '"') cell += csv[++i];
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\r")) {
      row.push(cell);
      cell = "";
      if (c === "\r") {
        expect(csv[++i]).toBe("\n");
        rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(cell).toBe("");
  const headers = rows.shift()!;
  expect(new Set(headers).size).toBe(headers.length);
  return rows.map((cells) => {
    expect(cells).toHaveLength(headers.length);
    return Object.fromEntries(headers.map((key, i) => [key, cells[i]!]));
  });
}

describe("D0 pure legacy parity (f822f3c; design §3)", () => {
  it(recordingFixture.id, () => {
    const { input, originalBytes, legacy, migrated } = recordings();
    const before = structuredClone(legacy);
    // Compare the entire old payload, allowing only the explicit v2 wrapper.
    const { schemaVersion, provenance, channels, ...unchanged } = migrated;
    expect(schemaVersion).toBe(2);
    expect({
      ...unchanged,
      schemaVersion: 1,
      device: provenance?.device,
      channels: channels.map(({ source, calibration }) => {
        expect(source.origin).toBe("legacy-ev3");
        return { source: source.channel, calibration };
      }),
    }).toEqual(legacy);
    expect(provenance).toEqual({ origin: "legacy-ev3", schemaVersion: 1, device: legacy.device });
    expect(migrated).not.toHaveProperty("recordingOrigin");
    for (const frame of migrated.frames) expect(frame).not.toHaveProperty("sessionElapsedMs");

    const draft = {
      id: "22345678-1234-4234-8234-123456789abc",
      name: "Later profile",
      ...input.channels[0]!,
    };
    draft.calibration.zeroOffset = 15;
    const oldProfile = calibrationProfileSchema.parse(draft);
    const newProfile = importLegacyCalibration(
      bytes({ schemaVersion: 1, profile: draft }),
      draft.id,
    );
    expect(newProfile.ok).toBe(true);
    if (!newProfile.ok) throw new Error("Profile import failed");
    expect(newProfile.value).toEqual({
      ...oldProfile,
      schemaVersion: 2,
      source: { origin: "legacy-ev3", channel: oldProfile.source },
    });
    draft.calibration.zeroOffset = 25;
    input.channels[0]!.source.name = "Changed live source";
    input.frames[0]!.values[0] = 999;
    input.device.metadata.label = "changed device";
    originalBytes.fill(0);
    expect(legacy).toEqual(before);
    expect(migrated.frames).toEqual(before.frames);
    expect(migrated.channels[0]!.source.channel).toEqual(before.channels[0]!.source);
    expect(migrated.channels[0]!.calibration).toEqual(before.channels[0]!.calibration);
    expect(migrated.provenance?.device).toEqual(before.device);
    expect(newProfile.value.calibration.zeroOffset).toBe(15);
    expect(oldProfile.calibration.zeroOffset).toBe(15);
    expect(migrated.channels[0]!.calibration.zeroOffset).toBe(5);
    for (const nested of [
      migrated,
      migrated.frames[0]!.values,
      migrated.channels[0]!.source.channel,
      migrated.channels[0]!.calibration,
      migrated.provenance?.device.metadata,
    ])
      expect(Object.isFrozen(nested)).toBe(true);
  });

  it(csvFixture.id, () => {
    const { legacy, migrated } = recordings();
    const oldRows = csvRows(sensorRecordingCsv(legacy));
    const newRows = csvRows(recordingCsv(migrated));
    expect(newRows).toHaveLength(legacy.frames.length * legacy.channels.length);
    expect(oldRows).toHaveLength(newRows.length);
    const renamed: Record<string, string> = csvFixture.renamedColumns;
    expect(Object.keys(newRows[0]!).sort()).toEqual(
      [
        ...Object.keys(oldRows[0]!).map((key) => renamed[key] ?? key),
        ...csvFixture.addedColumns,
      ].sort(),
    );
    oldRows.forEach((row, i) => {
      const next = newRows[i]!;
      for (const [key, value] of Object.entries(row))
        expect(next[renamed[key] ?? key], key).toBe(value);
      const source = legacy.channels[i % 2]!.source;
      const additions: Record<string, string> = {
        source_origin: "legacy-ev3",
        source_name: source.kind === "input" ? '"US, ""distance"""' : "Motor C",
        channel_id:
          source.kind === "input"
            ? '"[""input"",1,30,0,1,""cm""]"'
            : '"[""output"",2,7,0,0,""deg""]"',
        device_id: "brick-original",
        device_address: "192.0.2.1",
        device_serial_number: "original-serial",
        device_metadata: '"{""label"":""bench,\\""A\\""""}"',
      };
      for (const key of csvFixture.addedColumns) expect(next[key], key).toBe(additions[key] ?? "");
    });
    for (const rows of [oldRows, newRows]) {
      expect(rows.map((row) => row.raw_value)).toEqual(csvFixture.raw);
      expect(rows.map((row) => row.calibrated_value)).toEqual(csvFixture.calibrated);
      expect(rows.map((row) => row.status)).toEqual(csvFixture.status);
      expect(rows[0]!.recording_name).toBe('"Trial, ""臺灣""\nsecond line"');
      expect(rows[0]!.device_name).toBe("'=EV3()");
      expect(rows[0]!.mode_name).toBe('"DIST,""CM"""');
      expect(rows[1]!.port).toBe("C");
    }
  });

  it(cursorFixture.id, () => {
    const { legacy, migrated } = recordings();
    for (const calibrated of [false, true]) {
      const oldPoints = recordingPoints(legacy.frames, legacy.channels[0]!, 0, calibrated);
      // Test projection of original frames, not a replacement production adapter.
      const points = migrated.frames.map((frame) => ({
        time: frame.elapsedMs,
        value: calibrated
          ? calibrate(frame.values[0]!, migrated.channels[0]!.calibration)
          : frame.values[0]!,
        status: frame.status,
        segment: frame.segment,
      }));
      for (const query of cursorFixture.queries) {
        const expected = calibrated ? query.calibrated : query.raw;
        expect(nearestChartValue(oldPoints, query.time)).toBe(expected);
        // Legacy returns null for both missing samples and no nearby sample.
        expect(cursorReading(points, query.time)?.value ?? null).toBe(expected);
      }
      const geometry = sensorChartGeometry([{ label: "history", points: oldPoints }], [0, 4000]);
      const reduced = reduceSeries(points);
      expect(reduced.range).toEqual(geometry.range);
      expect(reduced.fullPointCount).toBe(geometry.count);
      expect(reduced.runs).toHaveLength(2);
      expect(geometry.paths[0]?.match(/M/g)).toHaveLength(2);
    }
  });

  it.each([
    {
      label: "equal distance",
      points: [
        { time: 0, value: 1 },
        { time: 1000, value: 2 },
      ],
      time: 500,
      index: 1,
    },
    {
      label: "unsorted equal distance",
      points: [
        { time: 1000, value: 2 },
        { time: 0, value: 1 },
      ],
      time: 500,
      index: 1,
    },
    {
      label: "duplicate time",
      points: [
        { time: 0, value: 1 },
        { time: 0, value: 2 },
      ],
      time: 0,
      index: 1,
    },
    { label: "exactly 1500ms after", points: [{ time: 0, value: 7 }], time: 1500, index: 0 },
    { label: "exactly 1500ms before", points: [{ time: 0, value: 7 }], time: -1500, index: 0 },
    {
      label: "just outside after",
      points: [{ time: 0, value: 7 }],
      time: 1500.001,
      index: undefined,
    },
    {
      label: "just outside before",
      points: [{ time: 0, value: 7 }],
      time: -1500.001,
      index: undefined,
    },
    {
      label: "null nearest is not skipped",
      points: [
        { time: 0, value: 7 },
        { time: 100, value: null },
      ],
      time: 90,
      index: 1,
    },
    {
      label: "null wins tie",
      points: [
        { time: 0, value: 7 },
        { time: 100, value: null },
      ],
      time: 50,
      index: 1,
    },
    { label: "empty", points: [], time: 0, index: undefined },
    { label: "nonfinite query", points: [{ time: 0, value: 7 }], time: NaN, index: undefined },
  ])("frozen f822f3c cursor policy: $label", ({ points, time, index }) => {
    const before = structuredClone(points);
    const expectedPoint = index === undefined ? undefined : points[index];
    const legacy = nearestChartValue(points, time);
    const reading = cursorReading(points, time);
    expect(legacy).toBe(expectedPoint?.value ?? null);
    // Explicit display normalization: undefined (no nearby point) and a Point
    // with value:null both display legacy null, but remain distinct model results.
    expect(reading?.value ?? null).toBe(legacy);
    expect(reading).toEqual(expectedPoint);
    if (reading) {
      expect(reading).not.toBe(expectedPoint);
      expect(Object.isFrozen(reading)).toBe(true);
    }
    expect(points).toEqual(before);
  });

  it(chartFixture.id, () => {
    const points = structuredClone(chartFixture.points);
    const oldReduced = reduceChartPoints(points);
    const next = reduceSeries(points);
    const geometry = sensorChartGeometry([{ label: "full history", points }], [0, 80_300]);
    expect(geometry.range).toEqual(chartFixture.range);
    expect(next.range).toEqual(geometry.range);
    expect(next.fullPointCount).toBe(geometry.count);
    expect(oldReduced[0]).toEqual(chartFixture.legacyFirstBucket);
    expect(oldReduced.filter((p) => p.value !== null).every((p) => p.value === 2)).toBe(true);
    // Expected intentional bug fix: legacy range sees the extrema but its path
    // drops them with the null bucket; the new drawable runs retain both.
    expect(next.extrema).toEqual({ minimum: points[0], maximum: points[2] });
    expect(next.runs[0]!.points).toEqual([points[0]]);
    expect(next.runs[1]!.points[0]).toEqual(points[2]);
    expect(next.pointCount).toBeLessThanOrEqual(800);
    expect(points).toEqual(chartFixture.points);
  });
});

import type { CalibratedChannel, SensorFrame, SensorRecording } from "../../shared/sensor-lab.js";
import { identityCalibration, recordingSeries, parseCalibrationDraft } from "./legacy-oracle.js";
// Pure presentation assertions retained before renderer removal (f822f3c).
describe("frozen D0 presentation fixtures", () => {
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
      expect(
        recordingSeries(channel, 0, frames, comparison, false, "en")[1]?.points[0]?.value,
      ).toBe(50);
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
});
