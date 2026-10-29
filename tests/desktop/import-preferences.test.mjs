import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  PREFERENCE_CUTS,
  preferencePhases,
  armPreferenceCut,
  assertPreferenceTransition,
  assertCaptureIpc,
  assertPreferenceSequence,
  assertPreferenceStorage,
  nonceDocument,
} from "./import-preferences.ts";
import { preferenceCapture, ORIGINAL_PREFERENCE } from "./import-preferences-renderer.ts";
import {
  snapshotDigest,
  snapshotBytes,
} from "../../apps/desktop/src/main/plugins/persistence/import-sources.ts";
function documents() {
  const owner = {
    sourceKey: "builtin:test.preferences",
    pluginId: "test.preferences",
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
    generation: 1,
  };
  const nonce = randomUUID(),
    scope = { hostEpoch: owner.hostEpoch, workbenchInstance: randomUUID() };
  const ticket = () => ({
    id: randomUUID(),
    owner,
    deadlineMonotonicMs: 10000,
    target: { kind: "import", key: "nonce/" + nonce },
    metadata: { kind: "import", key: "nonce/" + nonce },
  });
  const originalTicket = ticket();
  const issued = {
    formatVersion: 1,
    kind: "nonce",
    descriptorId: "test.synthetic-preferences",
    sourceKey: owner.sourceKey,
    nonce,
    scope,
    allowlist: ["test.preference"],
    state: "issued",
    raw: null,
    digest: null,
    originalTicket,
    ticket: originalTicket,
  };
  const snapshot = {
    nonce,
    scope,
    entries: [{ key: "test.preference", raw: ORIGINAL_PREFERENCE }],
  };
  const raw = {
    ...issued,
    raw: snapshot,
    digest: snapshotDigest(snapshot, issued.allowlist),
    ticket: ticket(),
  };
  const consumed = { ...raw, state: "consumed", ticket: ticket() };
  return { owner, issued, raw, consumed };
}
function backendFixture() {
  const buffers = new Map(),
    calls = [];
  let durable = null;
  const outcome = {
    disposition: "committed",
    receipt: {
      commitId: randomUUID(),
      revision: "r_" + randomUUID().replaceAll("-", ""),
      durability: "file-and-directory-sync",
    },
  };
  const backend = {
    engine: {
      async append(ticket, offset, bytes) {
        const old = buffers.get(ticket.id) ?? Buffer.alloc(0);
        assert.equal(offset, old.length);
        buffers.set(ticket.id, Buffer.concat([old, bytes]));
        return offset + bytes.length;
      },
      async publish(ticket) {
        calls.push(ticket.id);
        durable = JSON.parse(buffers.get(ticket.id).toString());
        return structuredClone(outcome);
      },
    },
    imports: {
      async reconcile() {
        return structuredClone(outcome);
      },
    },
    evidence: {
      async auxiliary() {
        return durable ? Buffer.from(JSON.stringify(durable)) : null;
      },
    },
  };
  return {
    backend,
    calls,
    outcome,
    durable: () => durable,
    async write(d) {
      const bytes = Buffer.from(JSON.stringify(d));
      const middle = Math.floor(bytes.length / 2);
      await backend.engine.append(d.ticket, 0, bytes.subarray(0, middle));
      await backend.engine.append(d.ticket, middle, bytes.subarray(middle));
      return backend.engine.publish(d.ticket);
    },
  };
}
for (const cut of PREFERENCE_CUTS)
  test(`actual forwarding ${cut}: challenge excluded, exact durable transition`, async () => {
    const d = documents(),
      f = backendFixture();
    let observed;
    const stop = armPreferenceCut({
      backend: f.backend,
      cut,
      pause: async (e) => {
        observed = e;
        throw Error("external kill wait");
      },
    });
    await f.write(d.issued);
    assert.equal(observed, undefined);
    if (cut.endsWith("consumption")) await f.write(d.raw);
    const target = cut.endsWith("raw") ? d.raw : d.consumed;
    await assert.rejects(() => f.write(target), /external kill wait/);
    assertPreferenceTransition(observed);
    assert.equal(f.calls.includes(target.ticket.id), cut.startsWith("after"));
    assert.deepEqual(
      f.durable(),
      cut.startsWith("after") ? target : cut.endsWith("raw") ? d.issued : d.raw,
    );
    for (const mutate of [
      (e) => (e.document.raw.entries[0].raw = "changed"),
      (e) => (e.document.originalTicket.id = randomUUID()),
      (e) => (e.readback = null),
      (e) => (e.outcome = { disposition: "unknown" }),
    ]) {
      const bad = structuredClone(observed);
      mutate(bad);
      assert.throws(() => assertPreferenceTransition(bad));
    }
    stop();
  });
test("after publication unknown cannot become a claimed commit", async () => {
  const d = documents(),
    f = backendFixture();
  await f.write(d.issued);
  f.backend.engine.publish = async () => ({ disposition: "unknown" });
  f.backend.imports.reconcile = async () => ({ disposition: "unknown" });
  armPreferenceCut({
    backend: f.backend,
    cut: "after-raw",
    pause: async () => {
      throw Error("must not pause");
    },
  });
  await assert.rejects(() => f.write(d.raw), /committed/);
});
test("append buffering rejects gaps and bounded auxiliary overflow", async () => {
  const d = documents(),
    f = backendFixture();
  armPreferenceCut({
    backend: f.backend,
    cut: "before-raw",
    pause: async () => {
      throw Error("pause");
    },
  });
  await assert.rejects(() => f.backend.engine.append(d.raw.ticket, 1, Buffer.from("x")));
  await assert.rejects(() => f.backend.engine.append(d.raw.ticket, 0, Buffer.alloc(2097153)));
});
test("before-raw has pending+fresh capture before three headless reopens", () => {
  assert.deepEqual(preferencePhases("before-raw"), [
    "kill",
    "pending",
    "capture",
    "reopen1",
    "reopen2",
    "reopen3",
    "deleted",
  ]);
  assert.equal(preferencePhases("after-raw").length, 5);
  assert.throws(() => preferencePhases("all"));
  assert.throws(() => assertPreferenceSequence([]));
});
function captureFixture(overrides = {}) {
  const { raw } = documents();
  let reads = 0,
    submits = [];
  let rawValue = ORIGINAL_PREFERENCE;
  const api = {
    async challenge() {
      return {
        nonce: raw.nonce,
        scope: raw.scope,
        descriptorId: raw.descriptorId,
        keys: raw.allowlist,
      };
    },
    async submit(s) {
      submits.push(structuredClone(s));
      return { state: "accepted" };
    },
    ...overrides,
  };
  const storage = {
    getItem() {
      reads++;
      return rawValue;
    },
    setItem(k, v) {
      assert.equal(k, "test.preference");
      rawValue = v;
    },
  };
  return {
    raw,
    api,
    storage,
    submits,
    reads: () => reads,
    set: (v) => {
      rawValue = v;
    },
  };
}
test("renderer validates allowlist before reading storage", async () => {
  const f = captureFixture({
    async challenge() {
      return { keys: ["other"], descriptorId: "test.synthetic-preferences" };
    },
  });
  await assert.rejects(() => preferenceCapture(f.api, f.storage).capture(), /allowlist/);
  assert.equal(f.reads(), 0);
});
test("storage exceptions never submit fabricated empty bytes", async () => {
  const f = captureFixture();
  f.storage.getItem = () => {
    throw Error("storage unavailable");
  };
  await assert.rejects(() => preferenceCapture(f.api, f.storage).capture(), /storage unavailable/);
  assert.equal(f.submits.length, 0);
});
test("coalesced capture retains original snapshot after pending retry", async () => {
  const f = captureFixture();
  let release;
  f.api.submit = async (s) => {
    f.submits.push(structuredClone(s));
    if (f.submits.length === 1) await new Promise((r) => (release = r));
    return { state: "pending" };
  };
  const c = preferenceCapture(f.api, f.storage),
    a = c.capture(),
    b = c.capture();
  assert.equal(a, b);
  await new Promise((r) => setImmediate(r));
  release();
  await a;
  f.set("changed after capture");
  await c.capture();
  assert.equal(f.submits.length, 2);
  assert.deepEqual(f.submits[0], f.submits[1]);
});
test("fresh document rejects actual old snapshot before issuing new challenge", async () => {
  const f = captureFixture(),
    old = documents().raw.raw,
    calls = [];
  const issue = f.api.challenge;
  f.api.challenge = async () => {
    calls.push("challenge");
    return issue();
  };
  f.api.submit = async (s) => {
    calls.push(s.nonce === old.nonce ? "old" : "new");
    if (s.nonce === old.nonce) throw Error("stale");
    return { state: "accepted" };
  };
  await preferenceCapture(f.api, f.storage).capture(old);
  assert.deepEqual(calls, ["old", "challenge", "new"]);
  f.api.submit = async () => ({ state: "accepted" });
  await assert.rejects(
    () => preferenceCapture(f.api, f.storage).capture(old),
    /unexpectedly accepted/,
  );
});
test("retired renderer suppresses late challenge and preserves existing seed", async () => {
  const f = captureFixture();
  let release;
  f.api.challenge = () => new Promise((r) => (release = r));
  const c = preferenceCapture(f.api, f.storage),
    p = c.capture();
  c.dispose();
  release({});
  await assert.rejects(() => p, /retired/);
  assert.equal(f.submits.length, 0);
  const other = captureFixture();
  other.set("changed");
  assert.throws(() => preferenceCapture(other.api, other.storage).seed(), /changed/);
});
function ipc(d, stale = false) {
  const rows = [],
    scope = d.scope,
    common = { scope, senderId: 10, frame: "11:12" };
  if (stale) {
    const old = documents().raw.raw;
    rows.push(
      {
        ...common,
        requestId: "old",
        channel: "persistence:legacy-preferences-submit",
        args: [old],
        stage: "request",
        at: 1,
      },
      {
        ...common,
        requestId: "old",
        channel: "persistence:legacy-preferences-submit",
        stage: "error",
        error: "Error: stale",
        at: 2,
      },
    );
  }
  rows.push(
    {
      ...common,
      requestId: "issue",
      channel: "persistence:legacy-preferences-challenge",
      args: [d.descriptorId],
      stage: "request",
      at: 3,
    },
    {
      ...common,
      requestId: "issue",
      channel: "persistence:legacy-preferences-challenge",
      stage: "reply",
      at: 4,
      result: { descriptorId: d.descriptorId, keys: d.allowlist, nonce: d.nonce, scope: d.scope },
    },
    {
      ...common,
      requestId: "submit",
      channel: "persistence:legacy-preferences-submit",
      args: [d.raw],
      stage: "request",
      at: 5,
    },
  );
  return rows;
}
test("IPC proof requires correlated real challenge and stale rejection, not renderer Boolean", () => {
  const d = documents().raw,
    rows = ipc(d, true);
  assertCaptureIpc(rows, d, true);
  for (const mutate of [
    (r) => r.splice(1, 1),
    (r) => (r.at(-1).args[0].entries[0].raw = "fake"),
    (r) => (r.at(-1).scope.workbenchInstance = randomUUID()),
    (r) => (r.at(-2).requestId = "foreign"),
  ]) {
    const bad = structuredClone(rows);
    mutate(bad);
    assert.throws(() => assertCaptureIpc(bad, d, true));
  }
});
function storageProof() {
  const d = documents().consumed,
    bytes = snapshotBytes(d.raw, d.allowlist),
    owner = d.ticket.owner;
  const record = {
    id: randomUUID(),
    revision: "r_" + randomUUID().replaceAll("-", ""),
    kind: "test.preferences",
    schemaVersion: 1,
    label: "fixture",
    mediaType: "application/json",
    byteLength: bytes.length,
    sha256: d.digest,
  };
  const wire = [];
  let sequence = 0;
  function rpc(method, params, value, chunk) {
    const id = randomUUID();
    wire.push({
      owner,
      direction: "plugin",
      sequence: ++sequence,
      message: { id, method, params },
    });
    wire.push({
      owner,
      direction: "host",
      sequence: ++sequence,
      requestId: id,
      method,
      params,
      message: { id, result: { ok: true, value } },
      ...(chunk ? { chunk } : {}),
    });
  }
  rpc("storage/list", { kind: "test.preferences", limit: 64 }, { entries: [record] });
  rpc(
    "storage/openRead",
    { id: record.id, expectedRevision: record.revision, schemaVersion: 1 },
    { record, read: "pin" },
  );
  for (let offset = 0; offset < bytes.length;) {
    const n = Math.min(17, bytes.length - offset),
      eof = offset + n === bytes.length;
    rpc(
      "storage/readChunk",
      { read: "pin", offset, maxBytes: 17 },
      { offset, nextOffset: offset + n, eof },
      {
        recordId: record.id,
        offset,
        bytes: n,
        sha256: createHash("sha256")
          .update(bytes.subarray(offset, offset + n))
          .digest("hex"),
        eof,
        ...(eof ? { recordSha256: d.digest } : {}),
      },
    );
    offset += n;
  }
  rpc("storage/closeRead", { read: "pin" }, {});
  return {
    d,
    o: {
      pid: 100,
      hostEpoch: owner.hostEpoch,
      processes: [{ kind: "boot", pid: 101, owner }],
      wire,
    },
    journal: {
      plan: { items: [{ ticket: { target: { id: record.id } } }] },
      items: [
        { publicationTicket: { metadata: { record } }, receipt: { revision: record.revision } },
      ],
    },
  };
}
test("preference public proof validates actual short chunks against exact snapshot bytes", () => {
  const f = storageProof();
  assertPreferenceStorage(f.o, f.d, f.journal);
  for (const mutate of [
    (o) => (o.wire.find((r) => r.chunk).chunk.sha256 = "0".repeat(64)),
    (o) => o.wire.find((r) => r.chunk).params.offset++,
    (o) => (o.wire.find((r) => r.method === "storage/list").message.result.ok = false),
    (o) => (o.wire.find((r) => r.method === "storage/openRead").params.expectedRevision = "wrong"),
    (o) => (o.wire.find((r) => r.chunk).owner.hostEpoch = randomUUID()),
  ]) {
    const bad = structuredClone(f.o);
    mutate(bad);
    assert.throws(() => assertPreferenceStorage(bad, f.d, f.journal));
  }
});
test("existing production document validator retains 64KiB and exact digest contract", () => {
  const d = documents().raw;
  nonceDocument(d);
  d.raw.entries[0].raw = "x".repeat(65536);
  assert.throws(() => nonceDocument(d));
});
test("explicit selectors and full foundation guard retain partial status", async () => {
  const { selectImportTrials } = await import("./plugin-persistence-run.mjs");
  const { verifyFoundationReports, verifyRunReceipt } =
    await import("./plugin-persistence-harness.mjs");
  assert.deepEqual(selectImportTrials("preferences-four"), [...PREFERENCE_CUTS]);
  for (const cut of PREFERENCE_CUTS) assert.deepEqual(selectImportTrials(cut), [cut]);
  assert.equal(selectImportTrials("publication-six").length, 6);
  assert.equal(selectImportTrials("semantic-eight").length, 8);
  const receipt = { case: "import-restart", evidence: { importPreferences: {} } };
  assert.throws(() => verifyRunReceipt(receipt));
  assert.throws(() => verifyFoundationReports([receipt], ["import-restart"]), /partial/);
});

function fileEvidence(hostEpoch, phase = "reopen1") {
  const owner = {
    sourceKey: "builtin:test.synthetic",
    pluginId: "test.synthetic",
    hostEpoch,
    processEpoch: randomUUID(),
    generation: 1,
  };
  const block = Buffer.alloc(262144, 65),
    chunkHash = createHash("sha256").update(block).digest("hex");
  const hash = createHash("sha256");
  for (let i = 0; i < 32; i++) hash.update(block);
  const sha256 = hash.digest("hex");
  const originals = Array.from({ length: 50 }, (_, i) => ({
    name: `${i}.json`,
    bytes: 8388608,
    sha256,
    chunks: Array.from({ length: 32 }, (_, j) => ({
      offset: j * 262144,
      bytes: 262144,
      sha256: chunkHash,
    })),
  }));
  const records = Array.from({ length: phase === "deleted" ? 49 : 50 }, (_, i) => ({
    id: `file-${i}`,
    revision: "r_file",
    byteLength: 8388608,
    sha256,
  }));
  const wire = [];
  let sequence = 0;
  function rpc(method, params, value, chunk) {
    const id = randomUUID();
    wire.push({
      owner,
      direction: "plugin",
      sequence: ++sequence,
      message: { id, method, params },
    });
    wire.push({
      owner,
      direction: "host",
      sequence: ++sequence,
      requestId: id,
      method,
      params,
      message: { id, result: { ok: true, value } },
      ...(chunk ? { chunk } : {}),
    });
  }
  rpc("storage/list", { kind: "test.synthetic", limit: 64 }, { entries: records });
  for (const record of records) {
    const read = "read-" + record.id;
    rpc("storage/openRead", { id: record.id, expectedRevision: record.revision }, { record, read });
    for (let i = 0; i < 32; i++) {
      const offset = i * 262144,
        eof = i === 31;
      rpc(
        "storage/readChunk",
        { read, offset, maxBytes: 262144 },
        { offset, nextOffset: offset + 262144, eof },
        {
          recordId: record.id,
          offset,
          bytes: 262144,
          sha256: chunkHash,
          eof,
          ...(eof ? { recordSha256: sha256 } : {}),
        },
      );
    }
    rpc("storage/closeRead", { read }, {});
  }
  return { originals, wire, processes: [{ kind: "boot", pid: 101, owner }] };
}
async function phaseEvidence(cut, phase = "reopen1") {
  const f = storageProof(),
    old = documents();
  const beforeRaw = cut === "before-raw";
  const source = beforeRaw
    ? old
    : {
        issued: { ...f.d, state: "issued", raw: null, digest: null, ticket: f.d.originalTicket },
        raw: { ...f.d, state: "issued", ticket: { ...f.d.ticket, id: randomUUID() } },
        consumed: f.d,
      };
  const document = cut.endsWith("raw") ? source.raw : source.consumed;
  const previous = cut.endsWith("raw") ? source.issued : source.raw;
  const after = cut.startsWith("after");
  const outcome = after ? { disposition: "committed", receipt: { commitId: randomUUID() } } : null;
  const transition = {
    cut,
    document,
    previous,
    outcome,
    reconciled: outcome,
    readback: after ? document : previous,
  };
  const file = fileEvidence(f.o.hostEpoch, phase);
  const prior = {
    slice: cut,
    cut,
    phase: "kill",
    rf5Complete: false,
    hostEpoch: document.ticket.owner.hostEpoch,
    originals: file.originals,
    transition,
    ipc: ipc(document),
  };
  const observed = {
    ...f.o,
    ...file,
    pid: 100,
    cut,
    slice: cut,
    phase,
    rf5Complete: false,
    prior,
    ipc: [],
    headless: true,
    capture: null,
    captured: beforeRaw ? f.d : null,
    preferences: {
      owner: f.d.ticket.owner,
      progress: { state: "complete" },
      documents: [
        ...(beforeRaw ? [{ document: source.issued, outcome: { disposition: "committed" } }] : []),
        { document: f.d, outcome: { disposition: "committed" } },
      ],
      journal: {
        ...f.journal,
        complete: true,
        plan: { ...f.journal.plan, preferencesEvidence: { nonce: f.d.nonce, digest: f.d.digest } },
        items: [{ ...f.journal.items[0], state: "committed" }],
      },
    },
  };
  if (phase === "pending") {
    observed.preferences = {
      owner: f.d.ticket.owner,
      progress: { state: "pending" },
      journal: null,
      documents: [{ document: source.issued, outcome: { disposition: "committed" } }],
    };
    observed.captured = null;
  } else {
    observed.wire = [...file.wire, ...f.o.wire];
    observed.processes = [...file.processes, ...f.o.processes.map((p) => ({ ...p, pid: 102 }))];
    if (phase === "capture") {
      observed.headless = false;
      observed.captured = null;
      observed.ipc = ipc(f.d, true);
      observed.ipc[0].args = [source.raw.raw];
      observed.ipc.push({
        ...observed.ipc.at(-1),
        stage: "reply",
        at: 6,
        result: { state: "accepted" },
      });
      observed.capture = {
        snapshot: f.d.raw,
        result: { state: "accepted" },
        original: ORIGINAL_PREFERENCE,
      };
    }
  }
  return observed;
}
for (const cut of PREFERENCE_CUTS)
  test(`paired-load phase oracle ${cut}: independent file and preference proofs`, async () => {
    const { assertPreferencePhase } = await import("./import-preferences.ts");
    const o = await phaseEvidence(cut);
    assertPreferencePhase(o);
    for (const mutate of [
      (v) =>
        (v.preferences.documents.find((r) => r.document.raw).document.raw.entries[0].raw = "wrong"),
      (v) => v.originals.pop(),
      (v) => (v.preferences.journal.plan.preferencesEvidence.nonce = randomUUID()),
      (v) => (v.headless = false),
    ]) {
      const bad = structuredClone(o);
      mutate(bad);
      assert.throws(() => assertPreferencePhase(bad));
    }
  });
test("pending cannot complete empty; fresh capture requires old-nonce IPC error and accepted reply", async () => {
  const { assertPreferencePhase } = await import("./import-preferences.ts");
  const pending = await phaseEvidence("before-raw", "pending");
  assertPreferencePhase(pending);
  pending.preferences.progress.state = "complete-empty";
  assert.throws(() => assertPreferencePhase(pending));
  const capture = await phaseEvidence("before-raw", "capture");
  assertPreferencePhase(capture);
  for (const mutate of [
    (o) => (o.ipc = o.ipc.filter((r) => r.stage !== "error")),
    (o) => o.ipc.pop(),
    (o) => (o.capture.result.state = "pending"),
    (o) => (o.capture.original = "changed"),
  ]) {
    const bad = structuredClone(capture);
    mutate(bad);
    assert.throws(() => assertPreferencePhase(bad));
  }
});

for (const cut of PREFERENCE_CUTS)
  test(`supervisor ${cut} validates preference pause before external SIGKILL`, async () => {
    const { superviseCase } = await import("./plugin-persistence-run.mjs");
    const o = await phaseEvidence(cut),
      prior = o.prior;
    let clock = 0,
      exit,
      live = true,
      kills = 0;
    const config = {
      case: "import-restart",
      importTrial: cut,
      importPhase: "kill",
      runId: "run",
      profileId: "profile",
    };
    const candidate = {
      status: "paused-import",
      runId: "run",
      profileId: "profile",
      pid: 100,
      evidence: { importPreferences: prior },
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
    assert.equal(kills, 1);
    assert.equal(receipt.status, "killed-import");
    assert.equal(receipt.cleanup.children, 0);
  });
test("complete preference sequence requires three distinct headless hosts and no resurrection", async () => {
  const base = await phaseEvidence("after-consumption"),
    prior = base.prior;
  const metadata = {
    profileId: "profile",
    commit: "a".repeat(40),
    bundleSha256: "b".repeat(64),
    artifactSha256: "c".repeat(64),
  };
  const receipts = [
    {
      ...metadata,
      pid: 1,
      hostEpoch: prior.hostEpoch,
      status: "killed-import",
      signal: "SIGKILL",
      evidence: { importPreferences: prior },
    },
  ];
  for (const [index, phase] of ["reopen1", "reopen2", "reopen3", "deleted"].entries()) {
    const o = structuredClone(base),
      hostEpoch = randomUUID();
    o.phase = phase;
    o.hostEpoch = hostEpoch;
    o.pid = index + 2;
    o.preferences.owner = { ...o.preferences.owner, hostEpoch };
    for (const r of o.wire) r.owner = { ...r.owner, hostEpoch };
    for (const [j, p] of o.processes.entries()) {
      p.owner = { ...p.owner, hostEpoch };
      p.pid = 100 + index * 2 + j;
    }
    if (phase === "reopen3") {
      const request = {
        id: "delete",
        method: "storage/delete",
        params: { id: "file-49", expectedRevision: "r_file" },
      };
      const owner = o.processes[0].owner;
      o.wire.push(
        { owner, direction: "plugin", sequence: 10000, message: request },
        {
          owner,
          direction: "host",
          sequence: 10001,
          requestId: "delete",
          method: request.method,
          params: request.params,
          message: { id: "delete", result: { ok: true, value: { deleted: true } } },
        },
      );
    }
    if (phase === "deleted") {
      o.wire = o.wire.filter(
        (r) =>
          r.chunk?.recordId !== "file-49" &&
          r.message?.params?.id !== "file-49" &&
          r.params?.id !== "file-49" &&
          r.params?.read !== "read-file-49" &&
          r.message?.params?.read !== "read-file-49",
      );
      o.wire
        .find((r) => r.method === "storage/list" && r.owner.sourceKey === "builtin:test.synthetic")
        .message.result.value.entries.pop();
    }
    const boots = [...o.processes];
    o.processes.push(...boots.map((p) => ({ ...p, kind: "exit" })));
    receipts.push({
      ...metadata,
      pid: o.pid,
      hostEpoch,
      exitCode: 0,
      signal: null,
      cleanup: { children: 0, workers: 0, listeners: 0, errors: [] },
      observedDescendants: boots.map((p) => ({ pid: p.pid })),
      evidence: { importPreferences: o },
    });
  }
  assertPreferenceSequence(receipts);
  for (const mutate of [
    (r) => r.splice(2, 1),
    (r) => (r[2].pid = r[1].pid),
    (r) => (r[1].cleanup.children = 1),
    (r) =>
      (r[2].evidence.importPreferences.preferences.journal.plan.items[0].ticket.target.id =
        "new-record"),
  ]) {
    const bad = structuredClone(receipts);
    mutate(bad);
    assert.throws(() => assertPreferenceSequence(bad));
  }
});

for (const message of [
  "stale",
  "Invalid preference scope",
  "Error invoking remote method 'persistence:legacy-preferences-submit': Error: Invalid preference scope",
  "Error invoking remote method 'persistence:legacy-preferences-submit': Error: stale",
])
  test(`old-scope capture accepts only the expected guard: ${message}`, async () => {
    const f = captureFixture(),
      old = documents().raw.raw,
      calls = [];
    const issue = f.api.challenge;
    f.api.challenge = async () => {
      calls.push("challenge");
      return issue();
    };
    f.api.submit = async (snapshot) => {
      calls.push(snapshot.nonce === old.nonce ? "old" : "new");
      if (snapshot.nonce === old.nonce) throw new Error(message);
      return { state: "accepted" };
    };
    await preferenceCapture(f.api, f.storage).capture(old);
    assert.deepEqual(calls, ["old", "challenge", "new"]);
    const rows = ipc(f.raw, true);
    rows[1].error = String(new Error(message));
    assertCaptureIpc(rows, f.raw, true);
  });
for (const message of [
  "I/O error",
  "transport closed",
  "stale transport failure",
  "Invalid preference scope: backend unavailable",
  "Error invoking remote method 'other-channel': Error: Invalid preference scope",
  "Error invoking remote method 'persistence:legacy-preferences-submit': Error: EIO",
])
  test(`unrelated old-submit failure is not accepted: ${message}`, async () => {
    const f = captureFixture(),
      old = documents().raw.raw,
      error = new Error(message);
    let challenges = 0,
      submissions = 0;
    f.api.challenge = async () => {
      challenges++;
      throw Error("must not challenge");
    };
    f.api.submit = async () => {
      submissions++;
      throw error;
    };
    await assert.rejects(
      () => preferenceCapture(f.api, f.storage).capture(old),
      (e) => e === error,
    );
    assert.equal(submissions, 1);
    assert.equal(challenges, 0);
    assert.equal(f.reads(), 0);
    const rows = ipc(f.raw, true);
    rows[1].error = String(error);
    assert.throws(() => assertCaptureIpc(rows, f.raw, true));
  });
