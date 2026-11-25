import { BroadcastChannel, Worker } from "node:worker_threads";
import { once } from "node:events";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

test("bundled RSS main selects its profile and requests the lock before its first yield", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rss-startup-"));
  try {
    const main = path.join(dir, "main.cjs");
    await build({
      entryPoints: ["tests/desktop/plugin-persistence-main-entry.mjs"],
      platform: "node",
      tsconfig: "tsconfig.base.json",
      format: "cjs",
      bundle: true,
      outfile: main,
      external: ["electron", "usb", "node-hid"],
      plugins: [rawResourcePlugin()],
      logLevel: "silent",
    });
    const mock = path.join(dir, "node_modules/electron");
    await mkdir(mock, { recursive: true });
    // Refuse the lock so no real desktop services can be constructed. A
    // microtask is an earlier readiness boundary than the native ready event.
    await writeFile(
      path.join(mock, "index.js"),
      `
const assert = require("node:assert/strict");
let ready = false, profile;
queueMicrotask(() => { ready = true; });
exports.app = {
  isReady: () => ready,
  setPath(name, value) { assert.equal(ready, false); assert.equal(name, "userData"); profile = value; },
  getPath: () => profile,
  requestSingleInstanceLock() { assert.equal(ready, false); assert.ok(profile); return false; },
  quit() {}, on() {}, exit(code) { process.exitCode = code; }
};`,
    );
    for (const workload of ["storage-ui-pressure", "rss-import"]) {
      const file = path.join(dir, workload + ".json");
      const config = {
        case: workload,
        profile: dir,
        buildRoot: dir,
        rendererUrl: "unit",
        preload: main,
        workerEntry: main,
        commit: "a".repeat(40),
        artifact: main,
        artifactSha256: "b".repeat(64),
        filesystem: "unit",
        report: file + ".report",
        rss: { cold: file + ".cold" },
      };
      await writeFile(file, JSON.stringify(config));
      const result = spawnSync(process.execPath, [main, "--persistence-config=" + file], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 1, result.stderr);
      const failure = JSON.parse(await readFile(config.report + ".entry-failure.json", "utf8"));
      assert.equal(failure.originalError.message, "BLOCKED: primary profile already held");
      const cold = JSON.parse(await readFile(config.rss.cold, "utf8"));
      assert.equal(cold.pid, failure.pid);
      assert.ok(cold.bytes > 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "sampler preserves rows through pipe drain, retained footer and writer exit",
  { timeout: 35000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rss-pipe-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // Request back-pressure on the first accepted sample in this unit worker.
    // The real child Node process still has to write every row and close the file.
    const preload = `
    import { Socket } from "node:net";
    import { parentPort } from "node:worker_threads";
    const write = Socket.prototype.write;
    Socket.prototype.write = function(chunk, ...args) {
      const accepted = write.call(this, chunk, ...args);
      if (typeof chunk === "string" && chunk.startsWith('{"kind":"sample"')) {
        Socket.prototype.write = write;
        parentPort.postMessage("unit-backpressure");
        if (accepted) setImmediate(() => this.emit("drain"));
        return false;
      }
      return accepted;
    };`;
    const file = path.join(dir, "rss.jsonl");
    const channel = new BroadcastChannel(file);
    t.after(() => channel.close());
    const notices = [];
    channel.onmessage = ({ data }) => notices.push(data);
    const worker = new Worker(new URL("./b2-process-rss-sampler.mjs", import.meta.url), {
      workerData: { node: process.execPath, file, trial: "node-unit", checkpointChannel: file },
      execArgv: ["--import", "data:text/javascript," + encodeURIComponent(preload)],
    });
    t.after(() => worker.terminate());
    const acks = [];
    worker.on("message", (phase) => {
      acks.push(phase);
      if (phase === "work") worker.postMessage("cleanup");
      if (phase === "cleanup") worker.postMessage("idle");
    });
    assert.deepEqual(await once(worker, "exit"), [0]);
    assert.deepEqual(acks, ["unit-backpressure", "work", "cleanup", "idle"]);
    const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map(JSON.parse);
    const header = rows[0];
    assert.equal(header.trial, "node-unit");
    assert.equal(header.pid, process.pid);
    assert.notEqual(header.writerPid, process.pid);
    const markers = rows.filter((row) => row.kind === "marker");
    assert.deepEqual(
      markers.map((row) => row.phase),
      ["warmup", "baseline", "work", "cleanup", "idle", "end"],
    );
    assert.equal(markers[1].at - markers[0].at, 5000);
    assert.equal(markers[2].at - markers[0].at, 10000);
    assert.equal(markers[5].at - markers[4].at, 10000);
    const samples = rows.filter((row) => row.kind === "sample");
    assert.ok(samples.length > 1);
    const peak = samples
      .filter((row) => ["work", "idle", "cleanup"].includes(row.phase))
      .reduce((max, row) => (row.bytes > max.bytes ? row : max));
    assert.deepEqual(notices.filter((n) => n.label === "peak").at(-1), {
      label: "peak",
      seq: peak.seq,
      at: peak.at,
      bytes: peak.bytes,
    });
    assert.deepEqual(notices.at(-1), { label: "retained-end", at: markers.at(-1).at });
    for (const [seq, row] of samples.entries()) {
      assert.equal(row.seq, seq);
      assert.equal(row.pid, process.pid);
      assert.ok(row.bytes > 0);
    }
    assert.deepEqual(rows.at(-1), { kind: "end", at: markers[5].at, count: samples.length });
  },
);

test("main and worker checkpoints describe their own isolates at the same sampled peak", async (t) => {
  const { observeIsolate } = await import("./b2-process-rss-observer.ts");
  const { checkpointReport } = await import("./b2-process-rss-checkpoints.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "rss-checkpoints-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = path.join(dir, "rss.jsonl");
  const observer = observeIsolate(path.join(dir, "main-diagnostics.jsonl"), raw, () => [
    { pid: process.pid, type: "Browser", workingSetKiB: 123 },
  ]);
  t.after(() => observer.stop());
  const probe = new Worker(
    new URL(
      "data:text/javascript," +
        encodeURIComponent(`
    import {parentPort,workerData} from 'node:worker_threads';
    import {observeIsolate} from ${JSON.stringify(new URL("./b2-process-rss-observer.ts", import.meta.url).href)};
    const observation = observeIsolate(workerData.file, workerData.raw);
    parentPort.on("message", () => { observation.stop(); parentPort.close(); });
    parentPort.postMessage("ready");
  `),
    ),
    { workerData: { raw, file: path.join(dir, "worker-diagnostics.jsonl") } },
  );
  t.after(() => probe.terminate());
  await once(probe, "message");
  observer.checkpoint("baseline-end");
  const channel = new BroadcastChannel(raw);
  t.after(() => channel.close());
  const at = Number(process.hrtime.bigint()) / 1e6;
  const row = { kind: "sample", seq: 20, bytes: 12345, phase: "cleanup", at };
  await writeFile(raw, JSON.stringify(row) + "\n");
  channel.postMessage({ label: "peak", seq: 19, bytes: 12000, at: at - 20 });
  channel.postMessage({ label: "peak", seq: 20, bytes: 12345, at });
  const until = Date.now() + 5000;
  let peak;
  do {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const report = await checkpointReport(dir, "rss-import");
    assert.equal(report.sampleStreamEnded, false);
    assert.equal(report.checkpoints.at(-1).main, null);
    peak = report.checkpoints.find((point) => point.label === "peak");
  } while ((!peak.main || !peak.persistence) && Date.now() < until);
  assert.equal(peak.main.threadId, 0);
  assert.ok(peak.persistence.threadId > 0);
  for (const snapshot of [peak.main, peak.persistence]) {
    assert.equal(snapshot.pid, process.pid);
    assert.equal(snapshot.trigger.seq, 20);
    assert.ok(snapshot.spaces.some((space) => space.space_name === "new_space"));
    for (const key of ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"])
      assert.ok(Number.isSafeInteger(snapshot.memory[key]));
    assert.ok(snapshot.maxRSSKiB > 0 && snapshot.deliveryLagMs >= 0);
  }
  assert.equal(peak.main.processes[0].workingSetKiB, 123);
  assert.equal(peak.persistence.processes, undefined);
});
