import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isolateDiagnostics,
  partialCadence,
  trials,
  verifySuite,
  verifyStageRetirements,
} from "./b2-process-rss-verify.mjs";
import { rssSettingsResource, rssSettingsValues } from "./b2-process-rss-settings.ts";
import { validateSettingsResource } from "../../packages/plugin-protocol/src/persistence-validation.ts";
import { validateSettingsValues } from "../../packages/plugin-protocol/src/settings.ts";
test("128-key settings pressure hits the actual protocol byte ceiling", () => {
  const resource = rssSettingsResource(),
    values = rssSettingsValues();
  validateSettingsResource(resource, Buffer.byteLength(JSON.stringify(resource)));
  assert.equal(Buffer.byteLength(JSON.stringify(values)), 65536);
  assert.equal(values.length, 128);
  assert.deepEqual(validateSettingsValues(resource, values, true), values);
  values[0].value += "x";
  assert.throws(() => validateSettingsValues(resource, values, true));
});
test("six required directories, absent raw evidence blocks verification", async () => {
  assert.equal(trials.length, 6);
  const dir = await mkdtemp(path.join(os.tmpdir(), "b2-rss-oracle-"));
  try {
    await assert.rejects(
      verifySuite(dir),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 6 &&
        error.errors.every((e) => e.cause.code === "ENOENT"),
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("each isolate needs all four fields, same PID and continuous workload coverage", () => {
  const markers = [0, 5000, 10000, 15000, 16000, 26000].map((at) => ({ at }));
  const rows = Array.from({ length: 53 }, (_, i) => ({
    at: i * 500,
    pid: 1,
    threadId: 3,
    heapUsed: 7,
    heapTotal: 9,
    external: 8,
    arrayBuffers: 4,
  }));
  assert.deepEqual(isolateDiagnostics(rows, 3, 1, markers).retained, {
    heapUsed: 7,
    heapTotal: 9,
    external: 8,
    arrayBuffers: 4,
  });
  for (const alter of [
    (r) => delete r[20].external,
    (r) => r[20].threadId++,
    (r) => r[20].pid++,
    (r) => r.splice(22, 2),
    (r) => r.splice(30),
  ]) {
    const changed = structuredClone(rows);
    alter(changed);
    assert.throws(() => isolateDiagnostics(changed, 3, 1, markers));
  }
});

test("raw RSS cap failure survives missing approval and workload; in-budget partial stays invalid", async () => {
  const { deriveTrial } = await import("./b2-process-rss-verify.mjs");
  const { approval, phases } = await import("./b2-process-rss.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "b2-rss-invalid-oracle-"));
  const write = (name, obj) => writeFile(path.join(dir, name), JSON.stringify(obj));
  try {
    const id = { trial: "unit-fixture", profile: dir, platform: "test", arch: "test" };
    await write("identity.json", {
      ...id,
      nodeEnv: "production",
      argv: ["fixture"],
      versions: { node: "fixture", electron: "fixture", v8: "fixture" },
      pid: 17,
    });
    await write("launch.json", { ...id, command: ["fixture"], workload: "rss-import", host: {} });
    await write("approval.json", { ...approval, peakBytes: approval.peakBytes + 1 });
    await write("cold.json", { phase: "cold-start", pid: 17, trial: id.trial, at: 1, bytes: 1000 });
    const markers = phases.map((phase, i) => ({
      kind: "marker",
      phase,
      at: 1000 + [0, 5000, 10000, 11000, 12000, 22000][i],
    }));
    for (const over of [0, 1]) {
      const rows = [{ kind: "header", periodMs: 20, pid: 17, writerPid: 18, trial: id.trial }];
      for (let at = 1000; at < 23000; at += 20) {
        const marker = markers.findLast((m) => m.at <= at);
        if (at === marker.at) rows.push(marker);
        rows.push({
          kind: "sample",
          phase: marker.phase,
          at,
          pid: 17,
          seq: (at - 1000) / 20,
          bytes: 1000 + (at === 11100 ? approval.peakBytes + over : 0),
        });
      }
      rows.push(markers.at(-1), { kind: "end", at: 23000, count: 1100 });
      await writeFile(
        path.join(dir, "rss.jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      const result = await deriveTrial(dir, "rss-import");
      // Independent verifier must never consult optional checkpoint artifacts.
      await writeFile(path.join(dir, "rss-attribution.json"), '{"status":"PASS","peakDelta":0}');
      await writeFile(path.join(dir, "main-diagnostics.jsonl.checkpoints.jsonl"), "truncated");
      assert.deepEqual(await deriveTrial(dir, "rss-import"), result);
      assert.equal(result.status, over ? "FAIL" : "INVALID");
      assert.equal(result.memory.peakDelta, approval.peakBytes + over);
      assert.ok(result.problems.length);
      assert.deepEqual(result.cadence.intervalsMs, {
        count: 1099,
        min: 20,
        p50: 20,
        p95: 20,
        p99: 20,
        max: 20,
      });
      // Shift one timestamp into its successor's slot, preserving count and sequence.
      rows.find((r) => r.seq === 2).at += 21;
      rows.find((r) => r.seq === 3).at += 3;
      await writeFile(
        path.join(dir, "rss.jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      const jitter = await deriveTrial(dir, "rss-import");
      assert.equal(jitter.status, "INVALID");
      assert.equal(jitter.memory.reason, "missing or duplicate 20 ms slot");
      assert.deepEqual(jitter.cadence, {
        skippedSlots: 1,
        duplicateSlots: 1,
        intervalsMs: { count: 1099, min: 2, p50: 20, p95: 20, p99: 20, max: 41 },
      });
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("incomplete trace cadence uses only recorded complete lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "b2-rss-prefix-"));
  try {
    assert.equal(await partialCadence(dir), undefined);
    const rows = [
      { kind: "marker", phase: "warmup", at: 100 },
      ...[120, 140, 220, 225].map((at) => ({ kind: "sample", at })),
    ];
    await writeFile(
      path.join(dir, "rss.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + '\n{"kind":"sample"',
    );
    assert.deepEqual(await partialCadence(dir), {
      skippedSlots: 4,
      duplicateSlots: 1,
      intervalsMs: { count: 3, min: 5, p50: 20, p95: 80, p99: 80, max: 80 },
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("retirement requires a raw abort reply, empty recovery snapshot and no recovery changes", () => {
  const owner = { pluginId: "a", sourceKey: "builtin:a", processEpoch: "p" };
  const write = "last";
  const p = {
    owners: [owner],
    steps: [{ phases: { restoredStaging: [{ pluginId: "a", result: { write } }] } }],
    ui: { retirements: [{ pluginId: "a", write, recoveryIds: [] }] },
  };
  const rpc = [
    {
      direction: "plugin",
      owner,
      at: 1,
      message: { id: 7, method: "storage/abortWrite", params: { write } },
    },
    {
      direction: "host",
      owner,
      at: 2,
      method: "storage/abortWrite",
      message: { id: 7, result: { ok: true, value: { disposition: "aborted" } } },
    },
  ];
  verifyStageRetirements(p, rpc, []);
  for (const operation of ["evidence.saveRecovery", "evidence.removeRecovery"]) {
    assert.throws(() => verifyStageRetirements(p, rpc, [{ kind: "request", operation }]));
  }
  p.ui.retirements[0].recoveryIds.push("blocker");
  assert.throws(() => verifyStageRetirements(p, rpc, []));
  p.ui.retirements[0].recoveryIds.pop();
  assert.throws(() => verifyStageRetirements(p, rpc.slice(0, 1), []));
  rpc[1].message.result.value.disposition = "unknown";
  assert.throws(() => verifyStageRetirements(p, rpc, []));
});
