import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SEMANTIC_IMPORT_BOUNDARIES,
  armSemanticImport,
  assertSemanticPause,
  resumeTrustedSkip,
  observeImportWriter,
  TRUSTED_SKIP_REASON,
  assertSemanticSequence,
} from "./import-boundaries.ts";
function fixture(boundary) {
  const owner = {
    sourceKey: "builtin:test.synthetic",
    pluginId: "test.synthetic",
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
    generation: 1,
  };
  const identity = {
    sourceKey: owner.sourceKey,
    descriptorId: "test.synthetic",
    planId: "import/test",
    barrierKey: "barrier/test",
  };
  const plan = {
    id: identity.planId,
    descriptorId: identity.descriptorId,
    targetSourceKey: identity.sourceKey,
    items: Array.from({ length: 50 }, (_, i) => ({
      key: String(i),
      byteLength: 8388608,
      ticket: {
        id: randomUUID(),
        owner,
        target: { kind: "record", id: randomUUID(), expectedRevision: null },
      },
    })),
  };
  let journal =
    boundary.endsWith("plan") || boundary.endsWith("barrier")
      ? null
      : {
          plan,
          items: plan.items.map((i) => ({
            key: i.key,
            state: "pending",
            receipt: null,
            publicationTicket: null,
            skipReason: null,
          })),
          complete: false,
        };
  const calls = [],
    buffers = new Map();
  let persisted = null;
  const receipt = {
    commitId: randomUUID(),
    revision: "r_" + randomUUID().replaceAll("-", ""),
    durability: "file-and-directory-sync",
  };
  const backend = {
    imports: {
      async reconcile() {
        return { disposition: "committed", receipt };
      },
      async load() {
        return structuredClone(journal);
      },
      async plan(o, p) {
        calls.push("plan");
        assert.deepEqual(o, owner);
        journal = {
          plan: structuredClone(p),
          items: p.items.map((i) => ({
            key: i.key,
            state: "pending",
            receipt: null,
            publicationTicket: null,
            skipReason: null,
          })),
          complete: false,
        };
      },
      async admit(o, id, key) {
        calls.push("admit");
        assert.equal(id, identity.planId);
        const item = journal.items.find((i) => i.key === key);
        const ticket = {
          ...plan.items.find((i) => i.key === key).ticket,
          id: randomUUID(),
          owner: o,
        };
        item.publicationTicket = ticket;
        return ticket;
      },
      async record(o, id, e) {
        calls.push("record");
        assert.deepEqual(o, owner);
        assert.equal(id, identity.planId);
        journal.items[journal.items.findIndex((i) => i.key === e.key)] = structuredClone(e);
      },
    },
    evidence: {
      async auxiliary() {
        return persisted === null ? null : Buffer.from(JSON.stringify(persisted));
      },
    },
    engine: {
      async append(t, offset, b) {
        calls.push("append");
        const old = buffers.get(t.id) ?? Buffer.alloc(0);
        assert.equal(offset, old.length);
        buffers.set(t.id, Buffer.concat([old, b]));
        return offset + b.length;
      },
      async publish(t) {
        calls.push("publish");
        persisted = JSON.parse(buffers.get(t.id).toString());
        return { disposition: "committed", receipt };
      },
    },
  };
  const barrierTicket = {
    id: randomUUID(),
    owner,
    target: { kind: "import", key: identity.barrierKey },
    metadata: { kind: "import", key: identity.barrierKey },
  };
  const barrier = {
    formatVersion: 1,
    kind: "barrier",
    sourceKey: identity.sourceKey,
    descriptorId: identity.descriptorId,
    barrier: randomUUID(),
    state: "active",
    ticket: barrierTicket,
    originalTicket: barrierTicket,
  };
  return {
    owner,
    identity,
    plan,
    backend,
    calls,
    barrier,
    barrierTicket,
    get journal() {
      return journal;
    },
  };
}
for (const boundary of SEMANTIC_IMPORT_BOUNDARIES)
  test(`semantic ${boundary}: forwards only the exact real port edge`, async () => {
    const f = fixture(boundary),
      stopped = new Error("paused-for-external-kill");
    let evidence;
    const originals = {
      plan: f.backend.imports.plan,
      admit: f.backend.imports.admit,
      append: f.backend.engine.append,
      publish: f.backend.engine.publish,
    };
    const restore = armSemanticImport({
      backend: f.backend,
      identity: f.identity,
      boundary,
      pause: async (e) => {
        evidence = {
          ...e,
          slice: boundary,
          phase: "kill",
          rf5Complete: false,
          hostEpoch: f.owner.hostEpoch,
          originals: Array.from({ length: 50 }, () => ({ bytes: 8388608 })),
        };
        assertSemanticPause(evidence);
        throw stopped;
      },
    });
    try {
      if (boundary.endsWith("barrier")) {
        const bytes = Buffer.from(JSON.stringify(f.barrier));
        await f.backend.engine.append(f.barrierTicket, 0, bytes.subarray(0, 17));
        await f.backend.engine.append(f.barrierTicket, 17, bytes.subarray(17));
      }
      await assert.rejects(
        boundary.endsWith("plan")
          ? f.backend.imports.plan(f.owner, f.plan)
          : boundary.endsWith("barrier")
            ? f.backend.engine.publish(f.barrierTicket)
            : f.backend.imports.admit(f.owner, f.identity.planId, "0"),
        (e) => e === stopped,
      );
      assert.ok(evidence);
      assert.equal(f.calls.filter((c) => c === "plan").length, boundary === "after-plan" ? 1 : 0);
      assert.equal(
        f.calls.filter((c) => c === "admit").length,
        boundary === "after-attempt" ? 1 : 0,
      );
      assert.equal(f.calls.filter((c) => c === "record").length, boundary === "after-skip" ? 1 : 0);
      assert.equal(
        f.calls.filter((c) => c === "publish").length,
        boundary === "after-barrier" ? 1 : 0,
      );
      assert.throws(() => assertSemanticPause({ ...evidence, ticket: { id: "invented" } }));
      if (boundary === "after-attempt")
        assert.throws(() => assertSemanticPause({ ...evidence, attempt: null }));
      if (boundary === "after-plan")
        assert.throws(() => assertSemanticPause({ ...evidence, journal: null }));
      if (boundary === "after-barrier")
        assert.throws(() => assertSemanticPause({ ...evidence, barrierReadback: null }));
      if (boundary === "after-skip") {
        const bad = structuredClone(evidence);
        bad.journal.items[0].skipReason = "made-up";
        assert.throws(() => assertSemanticPause(bad));
      }
    } finally {
      restore();
    }
    for (const [name, fn] of Object.entries(originals))
      assert.equal(
        (name === "plan" || name === "admit" ? f.backend.imports : f.backend.engine)[name],
        fn,
      );
  });
test("trusted skip resumes through the host record port without returning a placeholder attempt", async () => {
  const f = fixture("before-skip"),
    original = f.backend.imports.admit;
  const stop = resumeTrustedSkip(f.backend, { identity: f.identity, key: "0" });
  await assert.rejects(
    f.backend.imports.admit(f.owner, f.identity.planId, "0"),
    /Trusted host skip persisted/,
  );
  assert.deepEqual(f.calls, ["record"]);
  assert.equal(f.journal.items[0].state, "skipped");
  assert.equal(f.journal.items[0].skipReason, TRUSTED_SKIP_REASON);
  assert.equal(f.journal.items[0].publicationTicket, null);
  const next = await f.backend.imports.admit(f.owner, f.identity.planId, "1");
  assert.ok(next.id);
  assert.deepEqual(f.calls, ["record", "admit"]);
  stop();
  assert.equal(f.backend.imports.admit, original);
});
test("writer witness forwards composition callbacks and never manufactures restore", async () => {
  const calls = [];
  const witness = observeImportWriter({
    sourceKey: "builtin:test.synthetic",
    freezeAdmission() {
      calls.push("freeze");
    },
    async settled() {
      calls.push("settled");
    },
  });
  assert.deepEqual(witness.events, []);
  witness.writer.freezeAdmission();
  witness.composed();
  await witness.writer.settled();
  assert.deepEqual(calls, ["freeze", "settled"]);
  assert.deepEqual(
    witness.events.map((e) => e.kind),
    ["freeze", "composition-returned", "settled"],
  );
  assert.equal(witness.restore, undefined);
});
test("barrier collection is bounded and rejects non-contiguous bytes", async () => {
  for (const mode of ["oversize", "gap"]) {
    const f = fixture("before-barrier");
    const stop = armSemanticImport({
      backend: f.backend,
      identity: f.identity,
      boundary: "before-barrier",
      pause: async () => {
        throw Error("unexpected pause");
      },
    });
    try {
      await assert.rejects(
        f.backend.engine.append(
          f.barrierTicket,
          mode === "gap" ? 2 : 0,
          Buffer.alloc(mode === "oversize" ? 16385 : 2),
        ),
      );
    } finally {
      stop();
    }
  }
});
test("semantic sequence rejects missing actual hosts", async () => {
  await assert.rejects(assertSemanticSequence([]));
});

import { assertSemanticPhase } from "./import-boundaries.ts";
// Synthetic oracle inputs only; transport byte observations are exercised by the existing observer tests.
async function phaseFixture(boundary) {
  const f = fixture(boundary),
    digest = "a".repeat(64),
    stop = new Error("pause");
  let prior;
  for (const [i, item] of f.plan.items.entries())
    item.ticket.metadata = {
      kind: "record",
      record: {
        id: item.ticket.target.id,
        revision: `r_${String(i + 1).padStart(32, "0")}`,
        byteLength: 8388608,
        sha256: digest,
      },
    };
  const originals = Array.from({ length: 50 }, (_, i) => ({
    name: String(i),
    bytes: 8388608,
    sha256: digest,
    chunks: Array.from({ length: 32 }, (_, j) => ({
      offset: j * 262144,
      bytes: 262144,
      sha256: digest,
    })),
  }));
  const restore = armSemanticImport({
    backend: f.backend,
    identity: f.identity,
    boundary,
    pause: async (e) => {
      prior = {
        ...e,
        slice: boundary,
        phase: "kill",
        rf5Complete: false,
        hostEpoch: f.owner.hostEpoch,
        originals,
      };
      throw stop;
    },
  });
  try {
    if (boundary.endsWith("barrier"))
      await f.backend.engine.append(f.barrierTicket, 0, Buffer.from(JSON.stringify(f.barrier)));
    await assert.rejects(
      boundary.endsWith("plan")
        ? f.backend.imports.plan(f.owner, f.plan)
        : boundary.endsWith("barrier")
          ? f.backend.engine.publish(f.barrierTicket)
          : f.backend.imports.admit(f.owner, f.identity.planId, "0"),
      (e) => e === stop,
    );
  } finally {
    restore();
  }
  const hostEpoch = randomUUID(),
    owner = { ...f.owner, hostEpoch },
    skip = boundary.endsWith("skip");
  const finalJournal = {
    plan: structuredClone(f.plan),
    complete: true,
    items: f.plan.items.map((item, i) => {
      if (skip && i === 0)
        return {
          key: item.key,
          state: "skipped",
          receipt: null,
          publicationTicket: null,
          skipReason: TRUSTED_SKIP_REASON,
        };
      const publicationTicket = { ...structuredClone(item.ticket), id: randomUUID(), owner };
      return {
        key: item.key,
        state: "committed",
        skipReason: null,
        publicationTicket,
        receipt: {
          commitId: publicationTicket.id,
          revision: publicationTicket.metadata.record.revision,
        },
      };
    }),
  };
  const records = finalJournal.items
      .filter((i) => i.state === "committed")
      .map((i) => i.publicationTicket.metadata.record),
    wire = [];
  let seq = 0;
  const rpc = (method, params, value, chunk) => {
    const id = ++seq;
    wire.push({
      sequence: ++seq,
      direction: "plugin",
      owner,
      message: { jsonrpc: "2.0", id, method, params },
    });
    wire.push({
      sequence: ++seq,
      direction: "host",
      owner,
      method,
      params,
      requestId: id,
      message: { jsonrpc: "2.0", id, result: { ok: true, value } },
      ...(chunk ? { chunk } : {}),
    });
  };
  rpc("storage/list", { limit: 64 }, { entries: records });
  for (const r of records) {
    rpc(
      "storage/openRead",
      { id: r.id, expectedRevision: r.revision, schemaVersion: 1 },
      { read: r.id, record: r, expiresAt: 10000 },
    );
    for (let j = 0; j < 32; j++)
      rpc(
        "storage/readChunk",
        { read: r.id, offset: j * 262144, maxBytes: 262144 },
        { offset: j * 262144, nextOffset: (j + 1) * 262144, eof: j === 31 },
        {
          recordId: r.id,
          offset: j * 262144,
          bytes: 262144,
          sha256: digest,
          eof: j === 31,
          ...(j === 31 ? { recordSha256: digest } : {}),
        },
      );
    rpc("storage/closeRead", { read: r.id }, {});
  }
  return {
    slice: boundary,
    boundary,
    phase: "reopen1",
    rf5Complete: false,
    identity: f.identity,
    prior,
    originals,
    hostEpoch,
    pid: 100,
    processes: [{ kind: "boot", owner, pid: 101 }],
    wire,
    progress: { state: "complete" },
    initial: {
      owner,
      at: 3,
      journal: structuredClone(prior.journal),
      barrier: boundary === "before-barrier" ? null : f.barrier,
    },
    writerEvents: [
      { kind: "freeze", sourceKey: owner.sourceKey, at: 1 },
      { kind: "composition-returned", at: 2 },
    ],
    finalJournal,
    finalBarrier: {
      ...f.barrier,
      state: "complete",
      ticket: { ...f.barrierTicket, id: randomUUID(), owner },
    },
    expectedTargets: skip ? 49 : 50,
    reconciliations:
      boundary === "after-attempt"
        ? [{ ticket: f.plan.items[0].ticket, result: { disposition: "not-committed" } }]
        : [],
  };
}
for (const boundary of SEMANTIC_IMPORT_BOUNDARIES)
  test(`semantic oracle ${boundary}: full source load and honest target count`, async () => {
    const o = await phaseFixture(boundary);
    await assertSemanticPhase(o);
    for (const mutate of [
      (v) => {
        v.writerEvents = [];
      },
      (v) => {
        v.initial.owner.hostEpoch = "old";
      },
      (v) => {
        v.finalBarrier.state = "active";
      },
      (v) => {
        v.expectedTargets++;
      },
      (v) => {
        v.originals.pop();
      },
    ]) {
      const bad = structuredClone(o);
      mutate(bad);
      assert.throws(() => assertSemanticPhase(bad));
    }
    if (boundary.endsWith("skip")) {
      const bad = structuredClone(o);
      bad.finalJournal.items[0].skipReason = "fake";
      assert.throws(() => assertSemanticPhase(bad));
    }
    if (boundary === "after-attempt") {
      const bad = structuredClone(o);
      bad.reconciliations = [];
      assert.throws(() => assertSemanticPhase(bad));
    }
  });

test("semantic selector is explicit and keeps the six publication modes unchanged", async () => {
  const { selectImportTrials } = await import("./plugin-persistence-run.mjs");
  assert.deepEqual(selectImportTrials("semantic-eight"), [...SEMANTIC_IMPORT_BOUNDARIES]);
  assert.equal(selectImportTrials("publication-six").length, 6);
  for (const name of SEMANTIC_IMPORT_BOUNDARIES) assert.deepEqual(selectImportTrials(name), [name]);
  for (const name of [undefined, "before-raw-invalid", "after-consumption-invalid", "all"])
    assert.throws(() => selectImportTrials(name), /RF5 incomplete/);
});
test("semantic supervisor accepts a pre-plan pause with no record attempt and still requires external SIGKILL", async () => {
  const { superviseCase } = await import("./plugin-persistence-run.mjs");
  const o = await phaseFixture("before-plan"),
    prior = o.prior;
  let clock = 0,
    exit,
    live = true,
    kills = 0;
  const config = {
    case: "import-restart",
    importTrial: "before-plan",
    importPhase: "kill",
    runId: "semantic-run",
    profileId: "semantic-profile",
  };
  const candidate = {
    status: "paused-import",
    runId: config.runId,
    profileId: config.profileId,
    pid: 100,
    evidence: { importSlice: prior },
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
      throw Error("unexpected child");
    },
    readCandidate: async () => ({ candidate }),
    writeFailure: async () => {},
    reportFailure: () => {},
  };
  const receipt = await superviseCase(config, io, { timeoutMs: 10, pollMs: 1, settleMs: 1 });
  assert.equal(prior.attempt, null);
  assert.equal(prior.ticket, undefined);
  assert.equal(kills, 1);
  assert.equal(receipt.status, "killed-import");
  assert.equal(receipt.cleanup.children, 0);
});
test("semantic partial reports cannot satisfy full foundation acceptance", async () => {
  const { verifyFoundationReports } = await import("./plugin-persistence-harness.mjs");
  const o = await phaseFixture("after-skip");
  assert.throws(
    () =>
      verifyFoundationReports(
        [{ case: "import-restart", evidence: { importSlice: o } }],
        ["import-restart"],
      ),
    /partial/,
  );
});

test("receipt dispatcher validates all semantic cuts without promoting foundation acceptance", async () => {
  const { verifyRunReceipt, verifyFoundationReports } =
    await import("./plugin-persistence-harness.mjs");
  for (const boundary of SEMANTIC_IMPORT_BOUNDARIES) {
    const o = await phaseFixture(boundary);
    const receipt = {
      level: "real-process",
      status: "passed",
      case: "import-restart",
      runId: "semantic-dispatch",
      profileId: "semantic-profile",
      commit: "a".repeat(40),
      bundleSha256: "b".repeat(64),
      artifactSha256: "c".repeat(64),
      hostEpoch: o.hostEpoch,
      pid: o.pid,
      evidence: { importSlice: o },
      exitCode: 0,
      signal: null,
      closedAt: 1,
      exitedAt: 2,
      reportedAt: 3,
      cleanup: { workers: 0, listeners: 0, children: 0, errors: [] },
      workerTrace: [
        { kind: "start", count: 1, pid: o.pid },
        { kind: "exit", count: 0, pid: o.pid },
      ],
    };
    verifyRunReceipt(receipt);
    assert.throws(() => verifyFoundationReports([receipt], ["import-restart"]), /partial/);
    const forged = structuredClone(receipt);
    forged.evidence.importSlice.writerEvents = [];
    assert.throws(() => verifyRunReceipt(forged));
  }
});

test("W12: restored admission blocks an attempted disk write, including the side effect", async () => {
  const { createImportWriter, assertImportWriter } = await import("./import-boundaries.ts");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(tmpdir(), "w12-writer-"));
  try {
    const destination = path.join(directory, "legacy.txt");
    await writeFile(destination, "original");
    const positive = createImportWriter("builtin:test.synthetic", destination);
    await positive.start();
    assert.equal(await readFile(destination, "utf8"), "unexpected legacy write");
    await writeFile(destination, "original");
    const guarded = createImportWriter("builtin:test.synthetic", destination);
    guarded.writer.freezeAdmission();
    guarded.composed();
    const proof = await guarded.attempt();
    assertImportWriter(proof);
    assert.equal(await readFile(destination, "utf8"), "original");
    for (const mutate of [
      (p) => {
        p.events = [];
      },
      (p) => {
        p.error = null;
      },
      (p) => {
        p.admitted = true;
      },
      (p) => {
        p.after = "0".repeat(64);
      },
    ]) {
      const bad = structuredClone(proof);
      mutate(bad);
      assert.throws(() => assertImportWriter(bad));
    }
    const noop = createImportWriter("builtin:test.synthetic", destination);
    noop.composed();
    await assert.rejects(noop.attempt());
    assert.equal(await readFile(destination, "utf8"), "unexpected legacy write");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
