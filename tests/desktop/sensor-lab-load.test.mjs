import assert from "node:assert/strict";
import test from "node:test";
import {
  maximumOriginals,
  percentile,
  verifyMaximum,
  verifyLatencies,
  verifyLoad,
  verifyDirectory,
} from "./sensor-lab-load-run.mjs";

test("W15 originals have bounded maximum records, independent four channels, gaps and extrema", () => {
  const records = maximumOriginals();
  assert.equal(records.length, 49);
  assert.equal(new Set(records.map((r) => r.id)).size, 49);
  for (const r of records) {
    assert.equal(r.channels.length, 4);
    assert.equal(new Set(r.channels.map((c) => c.source.id)).size, 4);
    assert.equal(r.frames.length, 3600);
    assert.equal(r.frameCount, 3600);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 8 * 1024 * 1024);
    assert.deepEqual(r.frames[1800].values, [null, null, null, null]);
    assert.equal(r.frames[1800].status, "busy");
    assert.equal(r.frames[1801].segment, 1);
    for (let c = 0; c < 4; c++) {
      const values = r.frames.filter((f) => f.status === "ok").map((f) => f.values[c]);
      assert.equal(Math.min(...values), -50 * (c + 1));
      assert.equal(Math.max(...values), 50 * (c + 1));
    }
  }
});
test("nearest rank p95 includes the upper tail and refuses absent/nonfinite raw data", () => {
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
  for (const samples of [[], [NaN], [Infinity], [-1]])
    assert.throws(() => percentile(samples, 0.95));
});
test("maximum validator rejects absent charts, bytes over cap, and reduced counts", () => {
  assert.throws(() => verifyMaximum({ charts: [], cacheBytes: 0, datasets: 0 }));
  const charts = Array.from({ length: 4 }, () => ({ header: { series: [{}, {}] }, entries: [] }));
  assert.throws(() => verifyMaximum({ charts, cacheBytes: 524289, datasets: 4 }), /cap/);
  assert.throws(() => verifyMaximum({ charts, cacheBytes: 0, datasets: 9 }));
  assert.throws(() => verifyMaximum({ charts, cacheBytes: 0, datasets: 4 }), /Maximum legal/);
});
test("partial or failing producer never becomes a native pass", () => {
  assert.throws(() => verifyLoad({ schema: 1, stage: "startup", failures: [] }));
  assert.throws(() => verifyLoad({ schema: 1, stage: "complete", failures: ["timeout"] }));
  assert.throws(
    () =>
      verifyLoad({
        schema: 1,
        stage: "complete",
        failures: [],
        checkpoints: { steadyStart: 0, steadyEnd: 59999 },
      }),
    /60 seconds/,
  );
});
test(
  "independent native component receipt (set SENSOR_LAB_LOAD_EVIDENCE; full W15 remains open)",
  {
    skip: !process.env.SENSOR_LAB_LOAD_EVIDENCE && "Native receipt absent; W15 acceptance NOT RUN",
  },
  async () => {
    await verifyDirectory(process.env.SENSOR_LAB_LOAD_EVIDENCE);
  },
);

test("production Lab reducer reaches 4 x 2 x 800 inside canonical byte caps, preserving raw truth", async () => {
  const { createRequire } = await import("node:module");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const directory = await mkdtemp(path.join(tmpdir(), "w15-oracle-"));
  try {
    const root = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
    const alias = Object.fromEntries(
      Object.entries(config.compilerOptions.paths).map(([key, [file]]) => [
        key,
        path.join(root, file),
      ]),
    );
    const output = path.join(directory, "oracle.cjs");
    await build({
      stdin: {
        contents: `export {labCharts,labCursorReadings} from './plugins/sensor-lab/src/presentation.ts'; export {canonicalDatasetV2Bytes,validateDatasetV2,validateDatasetPanelV2} from '@kobrixa/plugin-protocol';`,
        resolveDir: root,
        loader: "ts",
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      alias,
    });
    const {
      labCharts,
      labCursorReadings,
      canonicalDatasetV2Bytes,
      validateDatasetV2,
      validateDatasetPanelV2,
    } = require(output);
    const records = maximumOriginals()
      .slice(0, 2)
      .map((r) => ({
        ...r,
        channels: r.channels.map((c) => ({
          ...c,
          source: { origin: "legacy-ev3", channel: c.source },
        })),
      }));
    const input = {
      current: records[0],
      comparison: records[1],
      selected: [],
      preview: [],
      calibrated: false,
    };
    const charts = labCharts(input);
    const panel = JSON.parse(
      await readFile(path.join(root, "plugins/sensor-lab/ui/panel.json"), "utf8"),
    );
    const payloads = charts.map((data, i) => ({
      declaration: panel.datasets[`chart${i}`],
      ...data,
    }));
    const history = {
      header: { kind: "list" },
      entries: Array.from({ length: 50 }, (_, i) => ({
        key: `record-${i}`,
        version: "1",
        cells: [`W15 maximum ${i}`],
      })),
    };
    payloads.push({ declaration: panel.datasets.history, ...history });
    for (const data of payloads) validateDatasetV2(data.declaration, data.header, data.entries);
    validateDatasetPanelV2(payloads);
    const cacheBytes = payloads.reduce(
      (n, d) => n + canonicalDatasetV2Bytes(d.header, d.entries).length,
      0,
    );
    verifyMaximum({ charts, cacheBytes, datasets: 5 });
    const gap = labCursorReadings(input, 900000);
    assert.equal(gap.c0raw, null);
    const raw = labCursorReadings(input, 50500);
    assert.equal(raw.c0raw, -50);
    for (const mutate of [
      (s) => s.charts[0].entries.pop(),
      (s) => s.charts[0].entries[0][3]++,
      (s) => s.charts[0].header.series[0].extrema[0][1]++,
      (s) => (s.charts[0].entries[0][1] = 1),
      (s) => (s.cacheBytes = 524289),
    ]) {
      const snapshot = structuredClone({ charts, cacheBytes, datasets: 5 });
      mutate(snapshot);
      assert.throws(() => verifyMaximum(snapshot));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Oracle inputs only: these numeric arrays are not native observations or receipts.
test("latency oracle retains every original percentile/max budget", () => {
  const m = {
    apply: Array(100).fill(16),
    input: Array(100).fill(100),
    cursor: Array(100).fill(100),
  };
  m.apply[99] = 50;
  verifyLatencies(m);
  for (const key of ["apply", "input", "cursor"]) {
    const bad = structuredClone(m);
    bad[key] = Array(100).fill(key === "apply" ? 16.01 : 100.01);
    assert.throws(() => verifyLatencies(bad));
  }
  const spike = structuredClone(m);
  spike.apply[99] = 50.01;
  assert.throws(() => verifyLatencies(spike), /max/);
  assert.throws(() => verifyLatencies({ ...m, input: [] }));
});
