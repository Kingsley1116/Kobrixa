import test from "node:test";
import assert from "node:assert/strict";
import { readEvidence, verifyImports } from "./plugin-persistence-harness.mjs";
test("B2-RF5: actual import kill/reopen repeats preserve IDs, bytes and originals", async () => {
  const report = await readEvidence();
  verifyImports(report);
  const required = [
    "before-plan",
    "after-plan",
    "before-attempt",
    "after-attempt",
    "before-head",
    "after-head",
    "before-receipt",
    "after-receipt",
    "before-skip",
    "after-skip",
    "before-raw",
    "after-raw",
    "before-consumption",
    "after-consumption",
    "before-marker",
    "after-marker",
    "before-barrier",
    "after-barrier",
  ];
  const trials = report.imports.restartDetails;
  assert.deepEqual([...new Set(trials.map((t) => t.boundary))].sort(), required.slice().sort());
  for (const trial of trials) {
    assert.equal(trial.actualProcessDeath, true);
    assert.ok(trial.signal === "SIGKILL" || trial.platformTermination === "taskkill-/T-/F");
    assert.ok(trial.reopens.length >= 3);
    assert.equal(
      new Set([trial.hostEpoch, ...trial.reopens.map((r) => r.hostEpoch)]).size,
      trial.reopens.length + 1,
    );
    for (const reopen of trial.reopens) {
      assert.notEqual(reopen.pid, trial.pid);
      assert.deepEqual(reopen.ids, trial.expectedIds);
      assert.deepEqual(reopen.hashes, trial.expectedHashes);
      assert.deepEqual(reopen.originalHashes, trial.originalHashes);
      assert.equal(reopen.committedDestinations, new Set(reopen.ids).size);
      assert.deepEqual(reopen.skipReasons, trial.skipReasons);
      assert.equal(reopen.completedItems, reopen.committedItems + reopen.skippedItems);
      assert.ok(reopen.barrierRestoredAt <= reopen.writerStartAttemptAt);
      assert.equal(reopen.writerAdmitted, false);
      assert.equal(reopen.publishesWhileUnknown, 0);
      assert.equal(reopen.deletedRecordResurrected, false);
      assert.equal(reopen.rendererPresent, false);
      assert.equal(reopen.preferenceSourceHash, trial.persistedPreferenceDigest);
      assert.equal(reopen.preferenceMappedHash, trial.expectedPreferenceMappedHash);
      assert.equal(reopen.oldWindowSubmitAccepted, false);
    }
  }
});

import { verifyRestartDetails, IMPORT_BOUNDARIES } from "./plugin-persistence-harness.mjs";
test("verifier negatives: import boundaries and death observations are mandatory", () => {
  assert.equal(IMPORT_BOUNDARIES.length, 18);
  assert.throws(() => verifyRestartDetails([]), /boundaries/);
  assert.throws(
    () =>
      verifyRestartDetails(
        IMPORT_BOUNDARIES.map((boundary) => ({ boundary, actualProcessDeath: false })),
      ),
    /./,
  );
  assert.throws(() => verifyImports({ level: "unit", imports: { trials: [] } }), /real-process/);
});

import {
  assertImportPhase,
  assertImportSlice,
  importObserver,
  IMPORT_SLICE,
} from "./plugin-persistence-import.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
function sliceOracle(phase = "reopen1") {
  const digest = "a".repeat(64),
    hostEpoch = randomUUID(),
    wire = [];
  const originals = Array.from({ length: 50 }, (_, n) => ({
    name: `${n}.json`,
    bytes: 8388608,
    sha256: digest,
    chunks: Array.from({ length: 32 }, (_, i) => ({
      offset: i * 262144,
      bytes: 262144,
      sha256: digest,
    })),
  }));
  const records = Array.from({ length: phase === "deleted" ? 49 : 50 }, (_, n) => ({
    id: `record-${n}`,
    revision: `revision-${n}`,
    byteLength: 8388608,
    sha256: digest,
  }));
  const owner = {
    sourceKey: "builtin:test.synthetic",
    pluginId: "test.synthetic",
    generation: 1,
    hostEpoch,
    processEpoch: randomUUID(),
  };
  let seq = 0;
  const rpc = (method, params, result, chunk) => {
    const id = ++seq;
    wire.push({ sequence: ++seq, direction: "plugin", owner, message: { id, method, params } });
    wire.push({
      sequence: ++seq,
      direction: "host",
      owner,
      method,
      params,
      requestId: id,
      message: { id, result },
      ...(chunk ? { chunk } : {}),
    });
  };
  rpc("storage/list", { limit: 64 }, { entries: records });
  for (const r of records) {
    rpc(
      "storage/openRead",
      { id: r.id, expectedRevision: r.revision, schemaVersion: 1 },
      { read: r.id, record: r },
    );
    for (let i = 0; i < 32; i++)
      rpc(
        "storage/readChunk",
        { read: r.id, offset: i * 262144, maxBytes: 262144 },
        { eof: i === 31 },
        {
          recordId: r.id,
          offset: i * 262144,
          bytes: 262144,
          sha256: digest,
          eof: i === 31,
          ...(i === 31 ? { recordSha256: digest } : {}),
        },
      );
    rpc("storage/closeRead", { read: r.id }, { closed: true });
  }
  if (phase === "reopen3")
    rpc(
      "storage/delete",
      { id: records[0].id, expectedRevision: records[0].revision },
      { deleted: true },
    );
  return {
    slice: IMPORT_SLICE,
    phase,
    rf5Complete: false,
    hostEpoch,
    originals,
    processes: [{ kind: "boot", pid: 101, owner }],
    pid: 100,
    reconciliation: { disposition: "committed" },
    progress: { state: "complete" },
    wire,
  };
}
test("slice oracle accepts bounded complete chunk observations (synthetic oracle input only)", () =>
  assertImportPhase(sliceOracle()));
const sliceNegatives = {
  "summary without RPC": (o) => (o.wire = []),
  "missing chunk": (o) => o.wire.splice(3, 1),
  "forged chunk hash": (o) => (o.wire.find((r) => r.chunk).chunk.sha256 = "b".repeat(64)),
  "wrong request": (o) => (o.wire.find((r) => r.chunk).requestId = "other"),
  "foreign owner": (o) =>
    (o.wire.find((r) => r.chunk).owner = { ...o.wire[0].owner, hostEpoch: randomUUID() }),
  "payload retained": (o) => (o.wire.find((r) => r.chunk).message.result.data = "payload"),
  "source count substitution": (o) => o.originals.pop(),
  "false full closure": (o) => (o.rf5Complete = true),
  "unknown reconciliation": (o) => (o.reconciliation.disposition = "unknown"),
  "bad CAS": (o) =>
    (o.wire.find((r) => r.method === "storage/delete").params.expectedRevision = "wrong"),
};
for (const [name, breakIt] of Object.entries(sliceNegatives))
  test(`slice oracle rejects ${name}`, () => {
    const o = sliceOracle("reopen3");
    breakIt(o);
    assert.throws(() => assertImportPhase(o));
  });
test("slice aggregate rejects missing trial/reopens and fake death", () => {
  assert.throws(() => assertImportSlice([]));
  const reports = ["kill", "reopen1", "reopen2", "reopen3", "deleted"].map((phase) => ({
    evidence: { importSlice: { phase } },
  }));
  assert.throws(() => assertImportSlice(reports));
});
test("slice observer hashes actual response bytes and discards payload from memory/disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "import-observer-"));
  try {
    let receive;
    const sent = [];
    const child = {
      onMessage(fn) {
        receive = fn;
        return () => {};
      },
      onExit() {
        return () => {};
      },
      send(text) {
        sent.push(text);
      },
    };
    const file = path.join(dir, "trace.jsonl"),
      observer = importObserver(file),
      owner = {
        sourceKey: "builtin:test.synthetic",
        pluginId: "test.synthetic",
        generation: 1,
        hostEpoch: randomUUID(),
        processEpoch: randomUUID(),
      };
    const wrapped = observer.attach(owner, child);
    receive(
      JSON.stringify({
        id: 1,
        method: "storage/openRead",
        params: { id: "record", expectedRevision: "r", schemaVersion: 1 },
      }),
    );
    wrapped.send(JSON.stringify({ id: 1, result: { read: "read", record: { id: "record" } } }));
    receive(
      JSON.stringify({
        id: 2,
        method: "storage/readChunk",
        params: { read: "read", offset: 0, maxBytes: 262144 },
      }),
    );
    const bytes = Buffer.from("actual public response bytes"),
      message = JSON.stringify({ id: 2, result: { data: bytes.toString("base64"), eof: true } });
    wrapped.send(message);
    assert.equal(sent.at(-1), message);
    const row = observer.rows.at(-1);
    assert.equal(row.chunk.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(row.chunk.recordSha256, row.chunk.sha256);
    assert.equal(row.message.result.data, undefined);
    assert.equal((await readFile(file, "utf8")).includes(bytes.toString("base64")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("slice cannot satisfy full foundation acceptance", async () => {
  const { verifyFoundationReports } = await import("./plugin-persistence-harness.mjs");
  assert.throws(
    () =>
      verifyFoundationReports(
        [{ case: "import-restart", evidence: { importSlice: sliceOracle() } }],
        ["import-restart"],
      ),
    /partial/,
  );
});

test("slice supervisor kills only after correlated pause and observes SIGKILL cleanup", async () => {
  const { superviseCase } = await import("./plugin-persistence-run.mjs");
  let clock = 0,
    exit,
    live = true,
    kills = 0;
  const config = {
    case: "import-restart",
    importPhase: "kill",
    runId: "unit-run",
    profileId: "unit-profile",
  };
  const candidate = {
    status: "paused-import",
    runId: config.runId,
    profileId: config.profileId,
    pid: 100,
    evidence: {
      importSlice: {
        phase: "kill",
        slice: IMPORT_SLICE,
        ticket: { id: "ticket" },
        trace: [{ point: "after-publish", ticket: "ticket" }],
      },
    },
  };
  const io = {
    now: () => clock,
    start: async () => ({ pid: 100, exit: () => exit }),
    processes: async () => (live ? [{ pid: 100, ppid: 1, pgid: 100, start: "birth" }] : []),
    sleep: async (ms) => {
      clock += ms;
    },
    killGroup: async () => {
      kills++;
      live = false;
      exit = { code: null, signal: "SIGKILL", at: clock };
    },
    killProcess: async () => {
      throw Error("unexpected escaped child");
    },
    readCandidate: async () => ({ candidate }),
    writeFailure: async () => {},
    reportFailure: () => {},
  };
  const r = await superviseCase(config, io, { timeoutMs: 10, pollMs: 1, settleMs: 1 });
  assert.equal(kills, 1);
  assert.equal(r.status, "killed-import");
  assert.equal(r.signal, "SIGKILL");
  assert.equal(r.cleanup.children, 0);
});
test("slice supervisor rejects code71 as external death", async () => {
  const { superviseCase } = await import("./plugin-persistence-run.mjs");
  let clock = 0;
  const io = {
    now: () => clock,
    start: async () => ({ pid: 100, exit: () => ({ code: 71, signal: null, at: 0 }) }),
    processes: async () => [],
    sleep: async (ms) => {
      clock += ms;
    },
    killGroup: async () => {},
    killProcess: async () => {},
    readCandidate: async () => ({}),
    writeFailure: async () => {},
    reportFailure: () => {},
  };
  await assert.rejects(
    superviseCase({ case: "import-restart", importPhase: "kill" }, io, {
      timeoutMs: 10,
      pollMs: 1,
      settleMs: 1,
    }),
    /71/,
  );
});
test("slice selector requires explicit partial trial before preflight/build", async () => {
  const { runFoundationEvidence } = await import("./plugin-persistence-run.mjs");
  await assert.rejects(runFoundationEvidence({ caseId: "import-restart" }), /RF5 incomplete/);
});

test("slice storage terminal page uses omitted optional cursor; continuation/null are rejected", () => {
  const o = sliceOracle();
  const page = o.wire.find((r) => r.method === "storage/list").message.result;
  assert.equal(Object.hasOwn(page, "nextCursor"), false);
  assertImportPhase(o);
  page.nextCursor = "next-page";
  assert.throws(() => assertImportPhase(o));
  page.nextCursor = null;
  assert.throws(() => assertImportPhase(o));
});

test("slice producer observation assembly retains real observer boot and late close exit", async () => {
  const { captureImportObservation } = await import("./plugin-persistence-import.ts");
  const directory = await mkdtemp(path.join(tmpdir(), "import-process-observation-"));
  try {
    const observer = importObserver(path.join(directory, "wire.jsonl"));
    const owner = {
      sourceKey: "builtin:test.synthetic",
      pluginId: "test.synthetic",
      generation: 1,
      hostEpoch: randomUUID(),
      processEpoch: randomUUID(),
    };
    let exit;
    const child = {
      onMessage() {
        return () => {};
      },
      onExit(callback) {
        exit = callback;
        return () => {};
      },
      send() {},
    };
    observer.attach(owner, child);
    observer.output(
      owner,
      `IMPORT_BOOT:${JSON.stringify({ pid: 12345, pluginId: owner.pluginId })}`,
    );
    // This is the same assembly function called immediately before the producer's
    // assertion/return, with the real observer rather than hand-made process rows.
    const observed = captureImportObservation({ phase: "reopen1" }, observer, []);
    assert.equal(observed.processes, observer.processes);
    assert.equal(observed.wire, observer.rows);
    assert.deepEqual(
      observed.processes.map((p) => p.kind),
      ["boot"],
    );
    // runReferenceEntry closes the composition after runCase returns, before JSON.
    exit({ code: 0, signal: null });
    const serialized = JSON.parse(JSON.stringify({ importSlice: observed }));
    assert.deepEqual(
      serialized.importSlice.processes.map((p) => p.kind),
      ["boot", "exit"],
    );
    assert.deepEqual(serialized.importSlice.processes[1].owner, owner);
    assert.equal(serialized.importSlice.processes[1].exit.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("slice paused report publication exposes only complete JSON to a concurrent poll", async () => {
  const { publishImportPause } = await import("./plugin-persistence-import.ts");
  const directory = await mkdtemp(path.join(tmpdir(), "import-pause-publication-"));
  try {
    const file = path.join(directory, "candidate.json"),
      report = { status: "paused-import", proof: "x".repeat(1024 * 1024) };
    const publishing = publishImportPause(file, report);
    // A missing candidate is normal until rename; malformed JSON is never tolerated.
    const observations = [];
    for (let i = 0; i < 8; i++) {
      try {
        observations.push(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
    }
    await publishing;
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), report);
    for (const observed of observations) assert.deepEqual(observed, report);
    await assert.rejects(readFile(`${file}.tmp`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
