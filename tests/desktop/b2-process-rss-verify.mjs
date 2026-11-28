import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { approval, evaluateRss } from "./b2-process-rss.mjs";
import { verifyLoadWorkload, verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import {
  verifyPressureWorkerTrace,
  verifyPressureRpcTrace,
} from "./plugin-persistence-pressure.ts";
import { rssSettingsValues } from "./b2-process-rss-settings.ts";

export async function approvedRecord() {
  const spec = "docs/superpowers/specs/2026-10-17-plugin-system-3b2-settings-storage-design.md";
  const source = await readFile(new URL("../../" + spec, import.meta.url), "utf8");
  const signed = source
    .split("\n")
    .filter((line) => line.startsWith("**核准記錄（2026-11-18）。**"));
  assert.equal(signed.length, 1, "Missing unique owner approval");
  for (const field of [
    approval.owner,
    approval.contract,
    "Peak delta 上限 41,943,040 bytes",
    "retained delta 上限 16,777,216 bytes",
  ])
    assert.ok(signed[0].includes(field), "Approval mismatch");
  return { ...approval, spec, signed: signed[0] };
}
export const trials = ["storage-ui-pressure", "rss-import"].flatMap((workload) =>
  [1, 2, 3].map((n) => ({ workload, folder: `${workload}-${n}` })),
);
function distribution(values) {
  assert.ok(values.length && values.every((v) => Number.isFinite(v) && v >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
// Summarize the original timestamps independently of the first failing slot.
function sampleCadence(samples, start, end) {
  if (!samples.length || !Number.isFinite(start)) return undefined;
  const intervals = [];
  let previousSlot = -1;
  let skippedSlots = 0;
  let duplicateSlots = 0;
  for (const [i, sample] of samples.entries()) {
    const at = sample.at;
    if (!Number.isFinite(at) || at < start || (i && at < samples[i - 1].at)) return undefined;
    const slot = Math.floor((at - start) / 20);
    if (i) intervals.push(at - samples[i - 1].at);
    if (slot === previousSlot) duplicateSlots++;
    else skippedSlots += slot - previousSlot - 1;
    previousSlot = slot;
  }
  // Include fully elapsed empty slots at the tail when its endpoint is known.
  if (Number.isFinite(end))
    skippedSlots += Math.max(0, Math.floor((end - start) / 20) - previousSlot - 1);
  intervals.sort((a, b) => a - b);
  const percentile = (fraction) => intervals[Math.ceil(intervals.length * fraction) - 1] ?? null;
  return {
    intervalsMs: {
      count: intervals.length,
      min: intervals[0] ?? null,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: intervals.at(-1) ?? null,
    },
    skippedSlots,
    duplicateSlots,
  };
}
// A producer can die before the footer. Report the observed prefix only.
export async function partialCadence(directory) {
  let text;
  try {
    text = await readFile(path.join(directory, "rss.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const rows = [];
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  const start = rows.find((row) => row?.kind === "marker" && row.phase === "warmup");
  return sampleCadence(
    rows.filter((row) => row?.kind === "sample"),
    start?.at,
  );
}
function verifyOrdinaryRpc(rows) {
  const pending = new Map();
  for (const row of rows) {
    const m = row.message;
    if (!m || m.id === undefined) continue;
    const source = row.owner.processEpoch;
    const key = JSON.stringify([source, m.id]);
    if (row.direction === "plugin" && typeof m.method === "string") {
      assert.ok(!pending.has(key));
      pending.set(key, source);
      assert.ok(pending.size <= 32);
      assert.ok([...pending.values()].filter((v) => v === source).length <= 16);
    } else if (row.direction === "host" && !m.method) pending.delete(key);
  }
  assert.equal(pending.size, 0, "ordinary RPC remains pending");
}
export function verifyStageRetirements(p, rpc, worker) {
  const retirements = p.ui.retirements;
  assert.deepEqual(
    retirements.map((r) => r.pluginId).sort(),
    p.owners.map((o) => o.pluginId).sort(),
  );
  const changes = worker.filter(
    (r) =>
      r.kind === "request" &&
      ["evidence.saveRecovery", "evidence.removeRecovery"].includes(r.operation),
  );
  assert.deepEqual(changes, [], "Pressure retirement wrote recovery");
  for (const { pluginId, write, recoveryIds } of retirements) {
    assert.deepEqual(recoveryIds, []);
    const owner = p.owners.find((o) => o.pluginId === pluginId);
    const lastStage = p.steps.at(-1).phases.restoredStaging.find((r) => r.pluginId === pluginId);
    assert.equal(write, lastStage.result.write);
    const request = rpc.find(
      (r) =>
        r.direction === "plugin" &&
        r.owner.processEpoch === owner.processEpoch &&
        r.message.method === "storage/abortWrite" &&
        r.message.params.write === write,
    );
    assert.ok(request);
    const response = rpc.find(
      (r) =>
        r.direction === "host" &&
        r.owner.processEpoch === owner.processEpoch &&
        r.method === "storage/abortWrite" &&
        r.message.id === request.message.id &&
        r.at >= request.at,
    );
    assert.deepEqual(response?.message.result, { ok: true, value: { disposition: "aborted" } });
  }
}

function assertIdleQuota(quota) {
  for (const key of ["reservedCreates", "reservedBytes", "pinnedBytes", "temporaryBytes"])
    assert.equal(quota[key], 0, key);
  assert.equal(quota.writeSlotsAvailable, 2);
  assert.equal(quota.exportSlotsAvailable, 1);
}
export function isolateDiagnostics(rows, id, pid, markers) {
  assert.ok(rows.length > 1);
  const keys = ["heapUsed", "heapTotal", "external", "arrayBuffers"];
  const [start, baseline, work, , idle, end] = markers.map((m) => m.at);
  let prev = -Infinity;
  for (const r of rows) {
    assert.ok(Number.isFinite(r.at) && r.at > prev);
    if (r.at >= baseline && prev <= end && prev >= start)
      assert.ok(r.at - prev <= 1000, "missing isolate second");
    assert.equal(r.pid, pid);
    assert.equal(r.threadId, id);
    for (const k of keys) assert.ok(Number.isSafeInteger(r[k]) && r[k] >= 0);
    prev = r.at;
  }
  const segments = [
    rows.filter((r) => r.at >= baseline && r.at < work),
    rows.filter((r) => r.at >= work && r.at <= end),
    rows.filter((r) => r.at >= Math.max(idle, end - 5000) && r.at <= end),
  ];
  assert.ok(
    segments[0].length &&
      segments[0][0].at <= baseline + 1000 &&
      segments[2].length &&
      segments[2].at(-1).at >= end - 1000,
  );
  return Object.fromEntries(
    ["baseline", "peak", "retained"].map((s, i) => [
      s,
      Object.fromEntries(keys.map((k) => [k, Math.max(...segments[i].map((r) => r[k]))])),
    ]),
  );
}

export async function deriveTrial(directory, workload) {
  const hashes = {};
  async function bytes(name) {
    const b = await readFile(path.join(directory, name));
    hashes[name] = createHash("sha256").update(b).digest("hex");
    return b.toString("utf8");
  }
  const json = async (name) => JSON.parse(await bytes(name));
  const lines = async (name) => {
    const text = await bytes(name);
    assert.ok(text.endsWith("\n"), "truncated " + name);
    return text
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const launch = await json("launch.json"),
    identity = await json("identity.json");
  assert.equal(launch.workload, workload);
  assert.equal(identity.trial, launch.trial);
  assert.equal(identity.profile, launch.profile);
  assert.equal(identity.nodeEnv, "production");
  assert.deepEqual(identity.argv.slice(1), launch.command.slice(1));
  assert.equal(identity.arch, launch.arch);
  assert.equal(identity.platform, launch.platform);
  for (const key of ["node", "electron", "v8"]) assert.ok(identity.versions[key]);
  const raw = await lines("rss.jsonl");
  const header = raw.shift();
  assert.equal(header.kind, "header");
  assert.equal(header.trial, launch.trial);
  assert.equal(header.pid, identity.pid);
  assert.ok(
    Number.isSafeInteger(header.writerPid) &&
      header.writerPid > 0 &&
      header.writerPid !== header.pid,
  );
  assert.equal(header.periodMs, 20);
  const markers = raw.filter((r) => r.kind === "marker"),
    samples = raw.filter((r) => r.kind === "sample");
  const trailer = raw.at(-1);
  assert.equal(trailer.kind, "end");
  assert.equal(samples.length + markers.length + 1, raw.length);
  const memory = evaluateRss({ markers, samples, trailer });
  const result = {
    approval,
    workload,
    trial: launch.trial,
    profile: launch.profile,
    pid: identity.pid,
    platform: identity.platform,
    arch: identity.arch,
    host: launch.host.hostname,
    osBuild: launch.host.release,
    commit: launch.commit,
    memory,
    cadence:
      sampleCadence(samples, markers.find((m) => m.phase === "warmup")?.at, trailer.at) ?? null,
    hashes,
  };
  const problems = [];
  let diagnostics, latencies;
  try {
    assert.equal(samples[0].pid, identity.pid);
    const cold = await json("cold.json");
    assert.equal(cold.phase, "cold-start");
    assert.equal(cold.pid, identity.pid);
    assert.equal(cold.trial, identity.trial);
    assert.ok(
      cold.at > 0 && cold.at < markers[0].at && Number.isSafeInteger(cold.bytes) && cold.bytes > 0,
    );
    result.cold = cold;
    assert.deepEqual(await json("approval.json"), await approvedRecord());
    const host = launch.host;
    for (const key of ["hostname", "cpu", "filesystem", "power", "disk", "background", "os"])
      assert.ok(host[key]);
    assert.ok(host.localSSD === true, "unconfirmed local SSD");
    assert.ok(host.ram > 0 && host.cores > 0 && host.freeBytes > 0);
    const evidence = await json("workload.json");
    const r = workload === "rss-import" ? evidence : evidence.reports[0];
    verifyRunReceipt(r, {
      case: workload,
      pid: identity.pid,
      commit: launch.commit,
      runId: launch.trial,
      profileId: launch.profileId,
      artifactSha256: launch.artifactSha256,
    });
    assert.ok(
      r.observedDescendants.some((p) => p.pid === header.writerPid),
      "Unobserved trace writer",
    );
    assert.equal(r.environment.memoryMethod, approval.contract);
    assert.equal(r.environment.electron, identity.versions.electron);
    const worker = await lines("worker-diagnostics.jsonl");
    assert.ok(worker[0].threadId > 0);
    diagnostics = {
      main: isolateDiagnostics(await lines("main-diagnostics.jsonl"), 0, r.pid, markers),
      persistence: isolateDiagnostics(worker, worker[0].threadId, r.pid, markers),
    };
    if (workload === "storage-ui-pressure") {
      const p = r.evidence.pressure;
      const workerTrace = await lines("pressure-worker.jsonl");
      assert.equal(hashes["pressure-worker.jsonl"], p.workerTrace.sha256);
      assert.deepEqual(verifyPressureWorkerTrace(workerTrace, p.owners), p.worker);
      const rawRpc = await lines("pressure-rpc.jsonl");
      for (const row of rawRpc.filter(
        (row) =>
          row.kind === "rpc" &&
          row.direction === "plugin" &&
          /^(settings|storage)\//.test(row.message?.method),
      )) {
        const at = identity.hrtimeMs + row.at - identity.performanceMs;
        assert.ok(at >= markers[2].at && at <= markers[4].at, "pressure RPC outside work/cleanup");
      }
      verifyStageRetirements(p, rawRpc, workerTrace);
      verifyOrdinaryRpc(rawRpc);
      const rpc = verifyPressureRpcTrace(rawRpc, p.owners);
      assert.deepEqual(rpc.records, p.seeded.map((r) => r.id).sort());
      assert.equal(rpc.verifiedReads, p.transport.verifiedReads);
      const mainTrace = await lines("pressure-main.jsonl");
      for (const name of ["pressure-main.jsonl", "pressure-rpc.jsonl"])
        assert.equal(hashes[name], p.artifacts.find((a) => a.path.endsWith(name))?.sha256);
      for (const rows of [mainTrace, workerTrace]) {
        for (const row of rows) {
          if (row.observation) {
            assert.equal(row.observation.clock.pid, identity.pid);
            assert.equal(
              row.observation.clock.threadId,
              rows === mainTrace ? 0 : worker[0].threadId,
            );
            assert.equal(row.observation.faults, 0);
            assert.equal(row.observation.dropped, 0);
          }
          for (const event of row.events ?? []) {
            const c = event.counters;
            assert.ok(c && c.pending <= 32 && c.active <= 4 && c.bytes <= 8388608);
            assert.ok(c.sourceBytes.every(([, v]) => v <= 1048576));
            assert.ok(c.sourceCount.every(([, v]) => v <= 16));
          }
        }
        const last = rows.at(-1).observation;
        assert.ok(
          last.queues.every(
            (q) => q.counters.pending === 0 && q.counters.active === 0 && q.counters.bytes === 0,
          ),
        );
      }
      assert.deepEqual(p.ui.baselineCounters, p.ui.idleCounters);
      assert.equal(p.finalQuotas.length, 2);
      for (const row of p.finalQuotas) assertIdleQuota(row.result);
      assert.equal(p.ui.cycles, 1000);
      assert.deepEqual(p.ui.settingsProof.values, rssSettingsValues());
      assert.equal(Buffer.byteLength(JSON.stringify(p.ui.settingsProof.values)), 65536);
      assert.deepEqual(
        p.ui.settingsProof.fields,
        rssSettingsValues()
          .slice(0, 16)
          .map((v) => v.value),
      );
      latencies = { sdk: {} };
      for (const owner of p.owners) {
        const timings = rawRpc.filter(
          (r) => r.kind === "consumer-output" && r.owner.processEpoch === owner.processEpoch,
        );
        const source = {};
        for (const operation of ["list", "commit", "flush"]) {
          const times = timings
            .filter((r) => r.operation === operation)
            .map((r) => r.finishedAt - r.startedAt);
          assert.ok(times.length >= 30, operation + " samples missing");
          source[operation] = {
            firstUse: distribution(times.slice(0, 1)),
            warm: distribution(times.slice(1)),
          };
        }
        latencies.sdk[owner.sourceKey] = source;
      }
      for (const [name, limit] of [
        ["inventory", 200],
        ["commit", 10000],
        ["flush", 10000],
      ]) {
        // Both sources must meet the budget. Preserve paired raw command intervals.
        const summary = p.samples[name]
          .map((pair) =>
            Math.max(
              ...pair.map((r) => r.commandInterval.finishedAt - r.commandInterval.startedAt),
            ),
          )
          .sort((a, b) => a - b);
        assert.equal(summary.length, 30);
        latencies[name] = { p50: summary[14], p95: summary[28], max: summary[29] };
        assert.ok(
          (name === "inventory" ? summary[28] : summary[29]) <= limit,
          name + " budget exceeded",
        );
      }
    } else {
      assert.deepEqual(r.evidence.rssImport.quotas.map((q) => q.source).sort(), [
        "builtin:kobrixa.device-ev3",
        "builtin:test.preferences",
        "builtin:test.synthetic",
      ]);
      for (const row of r.evidence.rssImport.quotas) assertIdleQuota(row.quota);
      const rawRpc = await lines("import-rpc.jsonl");
      verifyOrdinaryRpc(rawRpc);
      assert.deepEqual(rawRpc, r.evidence.rssImport.wire);
      for (const row of rawRpc.filter(
        (row) => row.method || row.message?.method?.startsWith("storage/"),
      ))
        assert.ok(
          row.monotonicMs >= markers[2].at && row.monotonicMs <= markers[4].at,
          "import RPC outside work/cleanup",
        );
    }
  } catch (error) {
    problems.push(error.message);
  }
  const status = memory.status === "FAIL" ? "FAIL" : problems.length ? "INVALID" : memory.status;
  return {
    ...result,
    status,
    problems,
    ...(diagnostics ? { diagnostics } : {}),
    ...(latencies ? { latencies } : {}),
  };
}

export async function verifyCurrentLoad(report, reportFile) {
  verifyLoadWorkload(report);
  assert.equal(report.load.rssMethod, "b2-process-rss/v1");
  const relative = report.load.rssDirectory;
  assert.ok(
    typeof relative === "string" &&
      relative &&
      !path.isAbsolute(relative) &&
      !relative.split(/[/\\]/).includes(".."),
  );
  const trials = await verifySuite(path.resolve(path.dirname(reportFile), relative));
  for (const trial of trials) {
    assert.equal(trial.commit, report.load.environment.commit);
    assert.equal(trial.arch, report.load.environment.architecture);
    assert.equal(trial.osBuild, report.load.environment.os);
  }
}
export async function verifySuite(directory) {
  const results = [];
  const errors = [];
  for (const { folder, workload } of trials) {
    try {
      const dir = path.join(directory, folder);
      const derived = await deriveTrial(dir, workload);
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, "receipt.json"), "utf8")), derived);
      results.push(derived);
      assert.equal(
        derived.status,
        "PASS",
        JSON.stringify({ memory: derived.memory, problems: derived.problems }),
      );
    } catch (error) {
      errors.push(new Error(folder + ": " + error.message, { cause: error }));
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "B2 RSS trials failed: " + errors.map((e) => e.message).join("\n"),
    );
  for (const key of ["profile", "pid", "trial"])
    assert.equal(new Set(results.map((r) => r[key])).size, 6, key);
  for (const key of ["platform", "arch", "host", "commit"])
    assert.equal(new Set(results.map((r) => r[key])).size, 1, key);
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await verifySuite(process.argv[2]);
