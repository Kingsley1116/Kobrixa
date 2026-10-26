import type { SensorRecording } from "../../shared/sensor-lab.js";

// D0 baseline f822f3c; design 2026-10-24 §3 rows are identified by their labels,
// not by a new public contract. Synthetic inputs exercise the real legacy exports.
// No runtime, UIv2, public EV3 vocabulary, or migration-write proof is claimed.
export const recordingFixture = {
  id: "D0-3-store-profiles-history-snapshots",
  rows: [
    "main store.ts list/read/save/delete/profiles/flush/recover",
    "profiles save/apply/delete",
  ],
  // schema.ts sensorRecordingSchema is the parser used by store.ts initialize/save;
  // calibrationProfileSchema is used inside store.ts's {schemaVersion:1,profile} envelope.
  record: {
    schemaVersion: 1,
    id: "12345678-1234-4234-8234-123456789abc",
    name: 'Trial, "臺灣"\nsecond line',
    startedAt: 100_000,
    endedAt: 104_200,
    durationMs: 4000,
    frameCount: 5,
    reason: "manual",
    device: {
      id: "brick-original",
      name: "=EV3()",
      transport: "wifi",
      address: "192.0.2.1",
      serialNumber: "original-serial",
      metadata: { label: 'bench,"A"' },
    },
    channels: [
      {
        source: {
          id: '["input",1,30,0,1,"cm"]',
          kind: "input",
          port: 1,
          type: 30,
          mode: 0,
          channel: 1,
          name: 'US, "distance"',
          modeName: 'DIST,"CM"',
          unit: "cm",
          decimals: 1,
        },
        calibration: {
          twoPoint: true,
          sourceA: 10,
          sourceB: 50,
          targetA: 0,
          targetB: 100,
          zeroOffset: 5,
          unit: 'scaled,"cm"',
        },
      },
      {
        source: {
          id: '["output",2,7,0,0,"deg"]',
          kind: "output",
          port: 2,
          type: 7,
          mode: 0,
          channel: 0,
          name: "Motor C",
          modeName: "angle",
          unit: "deg",
          decimals: 0,
        },
        calibration: {
          twoPoint: false,
          sourceA: 0,
          sourceB: 1,
          targetA: 0,
          targetB: 1,
          zeroOffset: -10,
          unit: "deg",
        },
      },
    ],
    // Receipt wall clock intentionally rolls backwards; elapsed time does not.
    // Legacy service.ts start/observe keeps these as separate clock domains.
    frames: [
      { sampledAt: 99_900, elapsedMs: 0, values: [30, -25], status: "ok", segment: 0 },
      { sampledAt: 100_500, elapsedMs: 500, values: [null, null], status: "busy", segment: 1 },
      { sampledAt: 100_400, elapsedMs: 1000, values: [null, -10], status: "ok", segment: 1 },
      { sampledAt: 103_500, elapsedMs: 3500, values: [50, null], status: "ok", segment: 2 },
      { sampledAt: 104_000, elapsedMs: 4000, values: [null, null], status: "error", segment: 3 },
    ],
  } satisfies SensorRecording,
};

export const csvFixture = {
  id: "D0-3-exportCSVContent-raw-calibrated-rows",
  // Explicit schema evolution only: every old column must still compare.
  renamedColumns: { source: "source_kind", channel: "component" },
  addedColumns: [
    "source_origin",
    "source_name",
    "channel_id",
    "provider_id",
    "session_id",
    "source_revision",
    "sequence",
    "gap_from_sequence",
    "gap_to_sequence",
    "gap_reason",
    "program",
    "device_id",
    "device_address",
    "device_serial_number",
    "device_metadata",
    "session_elapsed_ms",
    "recording_origin_session_elapsed_ms",
  ],
  raw: ["30", "-25", "", "", "", "-10", "50", "", "", ""],
  calibrated: ["45", "-15", "", "", "", "0", "95", "", "", ""],
  status: ["ok", "ok", "busy", "busy", "invalid", "ok", "ok", "invalid", "error", "error"],
};

export const chartFixture = {
  id: "D0-3-chart-full-extrema-gap-bucket",
  // Legacy sensor-lab-chart.tsx reduceChartPoints: default budget 800 yields
  // size=3; a null in the first bucket discards BOTH neighbouring extrema.
  // Design §3 chart row / §2 chart.ts explicitly retains full extrema/gap runs.
  points: Array.from({ length: 804 }, (_, i) => ({
    time: i * 100,
    value: i === 0 ? -80 : i === 1 ? null : i === 2 ? 120 : 2,
  })),
  range: [-80, 120],
  legacyFirstBucket: { time: 100, value: null },
};

export const cursorFixture = {
  id: "D0-3-chart-common-cursor-original-readings",
  // Actual legacy nearestChartValue and model cursorReading are compared below;
  // parity.test.ts also locks later-INPUT ties and the inclusive 1500ms cutoff.
  // Missing readings normalize model undefined to legacy null only in tests.
  queries: [
    { time: 0, raw: 30, calibrated: 45 },
    { time: 450, raw: null, calibrated: null },
    { time: 1000, raw: null, calibrated: null },
    { time: 3500, raw: 50, calibrated: 95 },
    { time: 4000, raw: null, calibrated: null },
  ],
};
