import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadComposition } from "./declarative-ui-load-fixture.ts";
import { describeDurations, describeRevokes, analyzeLoad } from "./declarative-ui-load-report.mjs";
import { joinSamples } from "./declarative-ui-load-diagnose.mjs";
import { diagnoseRenderer } from "./declarative-ui-load-diagnose-renderer.ts";

test("duration report identifies each short interval without rounding", () => {
  for (const warmupMs of [4999.99, 5000])
    for (const durationMs of [59999.99, 60000]) {
      const d = describeDurations({ warmupMs, durationMs });
      assert.equal(d.warmup.passed, warmupMs === 5000);
      assert.equal(d.active.passed, durationMs === 60000);
      assert.equal(d.warmup.measuredMs, warmupMs);
      assert.equal(d.active.measuredMs, durationMs);
    }
});

test("unmatched hide distinguishes absent binding from an out-of-window revoke", () => {
  const result = describeRevokes(
    [
      { at: 100, panelInstance: "a" },
      { at: 50, panelInstance: "b" },
    ],
    [{ kind: "revoke", time: 211, binding: { panelInstance: "a" } }],
    10,
    26.71,
  );
  assert.equal(result[0].nearestDeltaMs, 101);
  assert.equal(result[1].nearestDeltaMs, null);
  assert.equal(result[0].lowerMs, -26.71);
});

async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "load-diagnose-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("offline acceptance reader refuses the diagnostic producer before reading any metrics", async (t) => {
  const dir = await temporary(t);
  assert.deepEqual(loadComposition(false), {
    composition: "composeDesktopMain/createDesktopFoundation",
  });
  await writeFile(
    path.join(dir, "report.json"),
    JSON.stringify({ kind: "ui-maximum-load-run", ...loadComposition(true) }),
  );
  const matrix = path.join(dir, "matrix.json");
  await writeFile(
    matrix,
    JSON.stringify({ kind: "ui-maximum-load", reports: [{ path: "report.json" }] }),
  );
  await assert.rejects(analyzeLoad(matrix), /diagnoseMain/);
});

test("renderer records actual state entry, snapshot reply revision and update only in the active window", async () => {
  let receive,
    publish,
    revision = 1;
  const binding = { panelInstance: "p" };
  const d = diagnoseRenderer({
    onEvent(f) {
      receive = f;
      return () => {};
    },
    snapshot: async () => ({ ok: true, value: { binding, revision: 2 } }),
  });
  d.bridge.onEvent(() => {});
  d.watch({
    subscribe(fn) {
      publish = fn;
      return () => {};
    },
    getSnapshot: () => ({ snapshot: { binding, revision } }),
  });
  const event = { type: "state", binding, revision: 1 };
  receive(event);
  d.start();
  receive(event);
  await d.bridge.snapshot({ binding });
  revision = 2;
  publish();
  publish();
  const { rows, anchors } = d.stop();
  assert.deepEqual(
    rows.map((r) => r.revision),
    [1, 2, 2],
  );
  assert.equal(rows[0].pushed, false);
  assert.ok(rows[1].arrival >= rows[1].request);
  assert.equal(anchors.length, 2);
});

test("attribution uses paired intervals, preserves unmatched records and refuses ambiguous joins", () => {
  const binding = { panelInstance: "p", generation: 1 },
    owner = { sourceKey: "s" },
    id = { binding, owner, revision: 3 };
  const main = [{ ...id, kind: "apply", time: 100 }];
  const patches = [
    { ...id, applyStart: 94, applyEnd: 96 },
    { ...id, origin: 100, observerStart: 101, observerEnd: 102 },
    { ...id, sendStart: 103, sendEnd: 104 },
    { ...id, revision: 2, applyStart: 90, applyEnd: 91 },
  ];
  const delivered = [
    { ...id, eventEntry: 100, pushed: false },
    { ...id, requestedRevision: 3, request: 101, arrival: 121 },
    { ...id, storeUpdate: 122 },
  ];
  const renderer = { observations: [{ ...id, kind: "apply", time: 123 }] };
  const run = (uncertainty) =>
    joinSamples(main, renderer, patches, delivered, { offset: 10 }, uncertainty);
  let result = run(1);
  assert.equal(result.worst[0].stage, "snapshotRoundTrip");
  assert.equal(result.worst[0].observerToCommitMs, 33);
  assert.equal(result.counts.rows, 2);
  assert.equal(result.worst[0].durations.delivery, 6);
  assert.equal(run(26.71).worst[0].stage, "indistinguishable");
  delivered.push({ ...id, eventEntry: 120 });
  assert.equal(run(1).worst[0].stage, "incomplete or ambiguous");
  renderer.observations[0].owner = { sourceKey: "someoneElse" };
  result = run(1);
  assert.equal(result.counts.matched, 0);
  assert.ok(result.samples.some((s) => s.owner?.sourceKey === "someoneElse" && !s.events.origin));
});

test("comparison schedules nine serialized full-driver trials and retains failed driver exits", async (t) => {
  const dir = await temporary(t);
  const trees = [];
  for (const name of ["a", "b", "c"]) {
    const tree = path.join(dir, name);
    trees.push(tree);
    await mkdir(path.join(tree, "tests/desktop"), { recursive: true });
    await mkdir(path.join(tree, "tools/release"), { recursive: true });
    await writeFile(path.join(tree, "tools/release/journal-harness.mjs"), "");
    await writeFile(
      path.join(tree, "tests/desktop/declarative-ui-motion-run.mjs"),
      `
      import {appendFileSync} from "node:fs";
      const selected=[0,1,2].map(repeat=>({repeat}));
      for (const scenario of selected) {
        appendFileSync(${JSON.stringify(path.join(dir, "order"))},${JSON.stringify(name)}+scenario.repeat+" ");
      }
      process.exitCode=${name === "b" ? 1 : 0};
    `,
    );
  }
  const output = path.join(dir, "output");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./declarative-ui-load-diagnose-compare.mjs", import.meta.url)),
      output,
      ...trees,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(await readFile(path.join(dir, "order"), "utf8"), "a0 b0 c0 b1 c1 a1 c2 a2 b2 ");
  const schedule = JSON.parse(await readFile(path.join(output, "schedule.json"), "utf8"));
  assert.equal(schedule.length, 9);
  assert.equal(schedule.at(-1).next.exit.code, 1);
});

test("main instrumentation surrounds the real callbacks, saves the CDP profile and restores both methods", async (t) => {
  const { diagnoseMain } = await import("./declarative-ui-load-diagnose-main.ts");
  const directory = await temporary(t);
  const binding = { panelInstance: "a" },
    owner = { sourceKey: "s" };
  const categories = [
    "renderer.scheduler,toplevel",
    "devtools.timeline",
    "v8",
    "disabled-by-default-v8.gc",
    "ipc",
    "blink.user_timing",
  ];
  const calls = [];
  const trace = {
    getCategories: async () => categories,
    startRecording: async (o) => {
      calls.push(o);
    },
    stopRecording: async (p) => {
      calls.push(p);
    },
  };
  const profile = { nodes: [{ id: 1 }] };
  const contents = {
    send() {
      calls.push("sent");
    },
    debugger: {
      sendCommand: async (name) => {
        calls.push(name);
        if (name === "Performance.getMetrics")
          return { metrics: [{ name: "Timestamp", value: 4 }] };
        if (name === "Profiler.stop") return { profile };
      },
    },
  };
  const states = { patch: () => ({ ok: true, value: { revision: 4 } }) };
  const patch = states.patch,
    send = contents.send;
  const d = diagnoseMain(states, contents, directory, trace, "44.7.0");
  const observed = d.wrap(() => calls.push("observed"));
  await d.start();
  states.patch(owner, { binding });
  observed({ owner, binding, kind: "apply", time: 5 });
  contents.send("plugins:ui:event:1", { type: "state", binding, revision: 4 });
  await d.stop();
  assert.equal(contents.send, send);
  assert.equal(states.patch, patch);
  const read = async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"));
  const [application, observer, ipc] = await read("diagnostic-main.json");
  assert.equal(application.revision, 4);
  assert.ok(application.applyEnd >= application.applyStart);
  assert.equal(observer.origin, 5);
  assert.ok(observer.observerEnd >= observer.observerStart);
  assert.ok(ipc.sendEnd >= ipc.sendStart);
  assert.equal(ipc.revision, 4);
  assert.deepEqual(await read("renderer.cpuprofile"), profile);
  assert.ok(
    calls.includes("Profiler.start") && calls.includes("observed") && calls.includes("sent"),
  );
  assert.equal(calls.at(-1), path.join(directory, "electron.trace"));
  categories.pop();
  await assert.rejects(d.start(), /missing trace categories/);
  assert.equal(states.patch, patch);
});

test("actual verifier keeps a missing revoke null and budgets the full uncertainty", async (t) => {
  const dir = await temporary(t);
  const save = (name, value) => writeFile(path.join(dir, name), JSON.stringify(value));
  const heap = { main: [0], renderer: [0] },
    binding = { panelInstance: "a" };
  const calibration = Array.from({ length: 30 }, () => ({ offset: 0, uncertainty: 0.1 }));
  calibration[29] = { offset: 0, uncertainty: 26.71 };
  const report = {
    kind: "ui-maximum-load-run",
    ...loadComposition(false),
    calibration,
    clock: calibration[0],
    warmupMs: 5000,
    durationMs: 59999.75,
    artifact: { dirty: false, fixture: { resourceBytes: 8388608 } },
    fullCounters: { main: [{ counters: { bindings: 32 } }, { counters: { owners: 8 } }] },
    fullHeap: heap,
    baselineHeap: heap,
    afterHeap: heap,
    cycles: 0,
    final: [],
    rendererFinal: [],
    normalClose: false,
    failures: [],
  };
  await save("report.json", report);
  await save("matrix.json", { kind: "ui-maximum-load", reports: [{ path: "report.json" }] });
  await writeFile(
    path.join(dir, "main-events.jsonl"),
    [
      { kind: "apply", binding, revision: 1, time: 10 },
      { kind: "revoke", binding, time: 101 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const renderer = {
    observations: [{ kind: "apply", binding, revision: 1, time: 11 }],
    inputPaints: [],
    hides: [
      { at: 100, panelInstance: "a", trusted: true },
      { at: 500, panelInstance: "a", trusted: true },
    ],
  };
  await save("renderer-events.json", renderer);
  const read = async () => (await analyzeLoad(path.join(dir, "matrix.json"))).runs[0];
  const run = await read();
  assert.deepEqual(run.rawIntervals.revoke, [1, null]);
  assert.equal(run.missingRevokes, 1);
  assert.equal(run.revoke, null);
  assert.equal(run.checks.clock, true);
  assert.equal(run.apply.max, 27.71);
  assert.equal(run.durationDetails.active.passed, false);
  assert.equal(run.checks.fullDuration, false);
  assert.equal(run.pass, false);
  renderer.hides.pop();
  await save("renderer-events.json", renderer);
  assert.equal((await read()).revoke.max, 27.71);
  renderer.hides = [];
  await save("renderer-events.json", renderer);
  assert.equal((await read()).revoke, null);
});
