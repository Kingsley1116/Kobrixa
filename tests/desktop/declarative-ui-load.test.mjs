import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { assertMeasurements, summary } from "./declarative-ui-harness.mjs";
import { analyzeLoad } from "./declarative-ui-load-report.mjs";

test(
  "actual 30-second slow renderer preserves drafts, bounds queues and ignores a retired snapshot",
  {
    skip: !process.env.KOBRIXA_UI_SLOW_REPORT,
  },
  async () => {
    const file = process.env.KOBRIXA_UI_SLOW_REPORT;
    const bytes = await readFile(file);
    const report = JSON.parse((file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
    assert.equal(report.kind, "ui-slow-renderer-run");
    assert.equal(report.composition, "composeDesktopMain/createDesktopFoundation");
    assert.ok(report.durationMs >= 30000 && report.samples.length >= 100);
    assert.equal(report.delayMs, 800);
    for (const sample of report.samples) {
      assert.equal(sample.state.raw, "-");
      assert.equal(sample.state.focused, true);
      assert.equal(sample.state.active, true);
      for (const row of sample.counters) {
        assert.ok(row.counters.queuedEvents <= 4);
        assert.ok(row.counters.queuedBytes <= 65536);
      }
    }
    assert.ok(
      report.samples.some(
        (sample, index, rows) =>
          index > 0 && sample.state.revision - rows[index - 1].state.revision > 1,
      ),
    );
    assert.ok(report.snapshotDeliveries.length > 100);
    assert.ok(report.snapshotDeliveries.every((row) => row.count <= 1 && row.bytes <= 65536));
    assert.equal(report.afterClose, false);
    assert.notEqual(report.reopened.panelInstance, report.initial.panelInstance);
    assert.ok(report.after.active && report.after.revision > report.reopened.revision);
    assert.equal(report.final.length, 3);
    for (const row of [...report.final, ...report.rendererFinal])
      assert.ok(Object.values(row.counters).every((value) => value === 0));
    assert.equal(report.normalClose, true);
    assert.ok(report.orphanCheckMs >= 5000);
    assert.deepEqual(report.remainingPids, []);
    assert.deepEqual(report.failures, []);
  },
);

test(
  "three actual native maximum-load runs meet UI timing, heap and cleanup limits",
  {
    skip: !process.env.KOBRIXA_UI_LOAD_REPORT,
  },
  async () => {
    const report = await analyzeLoad(process.env.KOBRIXA_UI_LOAD_REPORT);
    for (const run of report.runs) assert.equal(run.pass, true, JSON.stringify(run.checks));
    assert.equal(report.pass, true);
  },
);

// Separate from maximum-load acceptance: this verifies an actual renderer-cycle
// receipt only when the controller provides one, never the example below.
test(
  "actual production renderer cycles release registered instances and bounded post-GC heap",
  {
    skip: !process.env.KOBRIXA_UI_RENDERER_REPORT,
  },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_UI_RENDERER_REPORT, "utf8"));
    assert.equal(report.productionMain, true);
    assert.equal(report.productionPreload, true);
    assert.equal(report.productionRenderer, true);
    assert.equal(report.artifact.rendererInstrumentation, true);
    assert.match(report.artifact.commit, /^[a-f0-9]{40}$/);
    assert.equal(report.normalClose, true);
    assert.deepEqual(report.remainingPids, []);
    const data = report.rendererDiagnostics;
    assert.equal(data.cycles, 1000);
    assert.equal(data.singleton, true);
    assert.equal(data.unknownRejected, true);
    assert.ok(data.final.raw.length >= 1004);
    for (const sample of [data.baseline, ...data.observations, data.final]) {
      assert.equal(new Set(sample.raw.map((row) => row.id)).size, sample.raw.length);
      for (const [key, value] of Object.entries(sample.counters)) {
        assert.ok(Number.isSafeInteger(value) && value >= 0);
        assert.equal(
          value,
          sample.raw.reduce((sum, row) => sum + row.snapshot[key], 0),
        );
      }
    }
    assert.ok(Object.values(data.final.counters).every((value) => value === 0));
    assert.ok(data.baseline.counters.resourceReaders > 0);
    assert.ok(data.events.some((event) => event.kind === "apply"));
    // No motion gesture is started in these mount/unmount cycles. Revocation
    // observations belong to the separate native motion acceptance matrix.
    const heap = report.rendererHeap;
    assert.equal(heap.scope, "renderer-isolate-only");
    assert.equal(heap.before.length, 3);
    assert.equal(heap.after.length, 3);
    for (const sample of [...heap.before, ...heap.after])
      assert.ok(Number.isFinite(sample.usedSize) && sample.usedSize > 0);
    assert.equal(
      heap.retainedBytes,
      Math.max(...heap.after.map((sample) => sample.usedSize)) -
        Math.min(...heap.before.map((sample) => sample.usedSize)),
    );
    assert.ok(heap.retainedBytes < 2 * 1024 * 1024);
  },
);

// This validates the evidence gate; these invented samples are NEVER performance evidence.
function example() {
  return {
    kind: "real-ui-measurement",
    artifact: "a".repeat(40),
    os: "test",
    arch: "test",
    cpu: "test",
    ramBytes: 1,
    filesystem: "test",
    node: "test",
    electron: "test",
    locale: "en",
    gc: "CDP HeapProfiler.collectGarbage + V8 main GC, three settled collections",
    fixture: {
      panels: 16,
      statuses: 16,
      nodesPerPanel: 256,
      depth: 8,
      resourceBytes: 8 * 1024 * 1024,
      patchHz: 10,
    },
    repeats: Array.from({ length: 3 }, () => ({
      warmupMs: 5000,
      durationMs: 60000,
      patches: 600,
      applyMs: [1, 2, 16],
      inputMs: [50, 100],
      revokeMs: [25, 50],
      stopDispatchMs: [1],
      clockUncertaintyMs: 0,
      mainHeapDelta: 0,
      rendererHeapDelta: 0,
    })),
    clock: { method: "performance.timeOrigin + performance.now", samples: 30, uncertaintyMs: 0 },
    diagnosticOwners: ["T2", "T3", "T5", "T6", "T7"],
    memoryMetric: "post-GC retained heap",
    rssBytes: 0,
    observations: { apply: 600, revoke: 1, "stop-dispatch": 1 },
    cycles: 1000,
    live: {
      owners: 0,
      bindings: 0,
      subscriptions: 0,
      queuedEvents: 0,
      queuedBytes: 0,
      timers: 0,
      pendingInvocations: 0,
      actionTokens: 0,
      resourceReaders: 0,
      workerJobs: 0,
    },
    retainedAfterCycles: 0,
    normalClose: true,
    orphanCheckMs: 5000,
    remainingPids: [],
    source: "controller-observed",
    proof: ["main.heapsnapshot", "renderer.heapsnapshot", "trace.json"],
  };
}
test("nearest-rank p95 uses the tail and rejects empty/nonfinite samples", () => {
  assert.deepEqual(summary([100, 1, 2, 3]), { n: 4, p50: 2, p95: 100, max: 100 });
  assert.throws(() => summary([]));
  assert.throws(() => summary([NaN]));
});
test("the full U03/U05/U09/U13 measurement envelope is mandatory", () => {
  assert.doesNotThrow(() => assertMeasurements(example()));
  for (const edit of [
    (r) => {
      r.fixture.panels = 15;
    },
    (r) => {
      r.fixture.statuses = 15;
    },
    (r) => {
      r.fixture.resourceBytes--;
    },
    (r) => {
      r.fixture.patchHz = 9;
    },
    (r) => {
      r.repeats.pop();
    },
    (r) => {
      r.repeats[0].warmupMs = 4999;
    },
    (r) => {
      r.repeats[0].durationMs = 59999;
    },
    (r) => {
      r.repeats[0].patches = 599;
    },
    (r) => {
      r.repeats[0].applyMs = [17];
    },
    (r) => {
      r.repeats[0].applyMs = [51];
    },
    (r) => {
      r.repeats[0].inputMs = [101];
    },
    (r) => {
      r.repeats[0].revokeMs = [51];
    },
    (r) => {
      r.repeats[0].revokeMs = [101];
    },
    (r) => {
      r.repeats[0].mainHeapDelta = 64 * 1024 * 1024 + 1;
    },
    (r) => {
      r.cycles = 999;
    },
    (r) => {
      r.live.subscriptions = 1;
    },
    (r) => {
      r.retainedAfterCycles = 2 * 1024 * 1024 + 1;
    },
    (r) => {
      r.normalClose = false;
    },
    (r) => {
      r.orphanCheckMs = 4999;
    },
    (r) => {
      r.remainingPids = [123];
    },
    (r) => {
      r.gc = "RSS screenshot";
    },
    (r) => {
      r.proof = [];
    },
    (r) => {
      r.source = "mock";
    },
    (r) => {
      delete r.clock;
    },
    (r) => {
      r.diagnosticOwners.pop();
    },
    (r) => {
      r.memoryMetric = "RSS";
    },
    (r) => {
      r.observations["stop-dispatch"] = 0;
    },
    (r) => {
      r.live.queuedBytes = 1;
    },
    (r) => {
      r.live.actionTokens = 1;
    },
    (r) => {
      r.repeats[0].clockUncertaintyMs = 1;
    },
  ]) {
    const report = example();
    edit(report);
    assert.throws(() => assertMeasurements(report));
  }
});
