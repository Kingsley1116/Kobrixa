import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSealedTtlObservation,
  assertSealedTtlEvidence,
  sealedTtlSummary,
} from "./plugin-persistence-sealed-ttl.ts";

// PURE ORACLE SPECIMEN ONLY: generated envelopes exercise rejection logic.
// This is not a mock native producer, run receipt, or native success report.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (b) => createHash("sha256").update(b).digest("hex");
const offset = 1700000000000;
const clock = (mono) => ({ mono, wall: offset + mono, end: mono, elapsed: mono });
const copy = structuredClone;
function specimen() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  };
  const calls = [],
    retained = [];
  function row(phase, method, params, value, start, extra = {}) {
    const r = {
      phase,
      method: `storage/${method}`,
      owner: copy(owner),
      params: copy(params),
      result: { ok: true, value: copy(value) },
      start: clock(start),
      end: clock(start + 1),
      ...copy(extra),
    };
    calls.push(r);
    return r;
  }
  const bad = (phase, method, params, code, start) => {
    const r = row(phase, method, params, {}, start);
    r.result = { ok: false, error: { code } };
    return r;
  };
  function seed(n, at, phase, complete) {
    const oldBytes = Buffer.from(`checkpoint ${n}`),
      finalBytes = Buffer.from(`complete final payload ${n}`);
    const meta = (bytes, revision, checkpoint) => ({
      id: id(n),
      revision,
      kind: "test.registration-end",
      schemaVersion: 1,
      label: "TTL",
      mediaType: "application/octet-stream",
      byteLength: bytes.length,
      sha256: digest(bytes),
      createdAt: offset + at,
      updatedAt: offset + at,
      checkpoint,
      interrupted: false,
    });
    const old = meta(oldBytes, `r_${String(n).padStart(32, "0")}`, "none"),
      next = meta(finalBytes, `r_${String(n + 1).padStart(32, "0")}`, "final");
    const ticket = (record, handle, created, expectedRevision) => ({
      id: id(handle),
      owner: copy(owner),
      deadlineMonotonicMs: created + 120000,
      metadata: { kind: "record", record: copy(record), deleted: false },
      target: { kind: "record", id: record.id, expectedRevision },
    });
    const oldTicket = ticket(old, n + 2, at, null),
      finalTicket = ticket(next, n + 3, at + 10, old.revision);
    const params = (r) =>
      Object.fromEntries(
        ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"].map((k) => [
          k,
          r[k],
        ]),
      );
    row(
      phase,
      "beginWrite",
      { ...params(old), target: { mode: "create" } },
      { write: oldTicket.id, id: old.id, expiresAt: offset + at + 30000 },
      at,
      { ticket: oldTicket },
    );
    row(
      phase,
      "writeChunk",
      { write: oldTicket.id, offset: 0, data: oldBytes.toString("base64") },
      { receivedBytes: oldBytes.length },
      at + 2,
    );
    row(phase, "sealWrite", { write: oldTicket.id }, { state: "sealed" }, at + 4);
    row(
      phase,
      "commitWrite",
      { write: oldTicket.id },
      { record: old, receipt: { commitId: id(n + 4), revision: old.revision } },
      at + 6,
    );
    row(
      phase,
      "registerCheckpoint",
      { id: old.id, expectedRevision: old.revision, reservation: id(n + 5) },
      { checkpoint: id(n + 6) },
      at + 8,
    );
    row(
      phase,
      "beginWrite",
      {
        ...params(next),
        target: { mode: "replace", id: old.id, expectedRevision: old.revision },
        checkpoint: { handle: id(n + 6), phase: "final" },
      },
      { write: finalTicket.id, id: old.id, expiresAt: offset + at + 30010 },
      at + 10,
      { ticket: finalTicket },
    );
    const sent = complete ? finalBytes : finalBytes.subarray(0, 4);
    row(
      phase,
      "writeChunk",
      { write: finalTicket.id, offset: 0, data: sent.toString("base64") },
      { receivedBytes: sent.length },
      at + 12,
    );
    if (complete) {
      row(
        phase,
        "sealWrite",
        { write: finalTicket.id },
        {
          write: finalTicket.id,
          id: next.id,
          receivedBytes: finalBytes.length,
          state: "sealed",
          expiresAt: offset + at + 30015,
        },
        at + 14,
      );
      retained.push({ ticket: copy(finalTicket), pin: id(n + 7), expiresMonotonicMs: at + 30014 });
    }
    return { old, next, oldBytes, finalBytes, finalTicket, oldTicket, at, n };
  }
  function read(s, phase, at, handle) {
    row(
      phase,
      "openRead",
      { id: s.old.id, expectedRevision: s.old.revision, schemaVersion: 1 },
      { read: id(handle), record: s.old, expiresAt: offset + at + 30000 },
      at,
    );
    row(
      phase,
      "readChunk",
      { read: id(handle), offset: 0, maxBytes: 262144 },
      { offset: 0, data: s.oldBytes.toString("base64"), nextOffset: s.oldBytes.length, eof: true },
      at + 2,
    );
  }
  const s = seed(10, 10, "seed-sealed", true);
  read(s, "seed-sealed", 28, 50);
  const drain = (s, phase, at, complete) => {
    const offer = {
      owner: copy(owner),
      reason: "reservation-ended",
      deadlineMonotonicMs: at + 10000,
      token: id(s.n + 8),
      checkpoints: [{ checkpoint: id(s.n + 6), record: copy(s.old) }],
      writes: [{ write: s.finalTicket.id, id: s.old.id, state: complete ? "sealed" : "receiving" }],
      acceptedTickets: [s.finalTicket.id],
    };
    const report = {
      state: complete ? "retryable" : "checkpoint-only",
      blocker: true,
      pendingSettings: false,
      recovery: id(s.n + 9),
      records: [
        {
          id: s.old.id,
          committedRevision: s.old.revision,
          final: false,
          payload: complete ? "complete-staging" : "checkpoint-only",
          ...(complete ? { expiresAt: offset + 30024 } : {}),
        },
      ],
      errors: [],
    };
    return {
      phase,
      offer,
      start: clock(at),
      end: clock(at + 10),
      requests: [
        {
          owner: copy(owner),
          request: {
            token: offer.token,
            remainingMs: 9999,
            reason: "reservation-ended",
            writes: copy(offer.writes),
            checkpoints: copy(offer.checkpoints),
          },
          result: {
            ok: true,
            value: { status: complete ? "submitted" : "checkpoint-only", writes: [] },
          },
        },
      ],
      report,
    };
  };
  const d = drain(s, "drain-sealed", 19, true);
  bad(
    "drain-sealed",
    "commitWrite",
    { write: s.finalTicket.id, drainToken: d.offer.token },
    "PLUGIN_E_STORAGE_IO",
    42,
  );
  d.end = clock(50);
  const recovery = {
    id: d.report.recovery,
    owner: copy(owner),
    report: copy(d.report),
    ticket: copy(s.finalTicket),
    sealedPin: retained[0].pin,
    expiresAt: offset + 30024,
  };
  const retry = {
    id: recovery.id,
    action: {
      actionToken: id(60),
      scope: { hostEpoch: owner.hostEpoch, workbenchInstance: id(61) },
    },
    start: clock(60),
    end: clock(70),
    report: copy(d.report),
  };
  row(
    "status",
    "writeStatus",
    { write: s.finalTicket.id },
    { write: s.finalTicket.id, state: "sealed", expiresAt: offset + 30025 },
    72,
  );
  const expired = {
    phase: "after-expiry",
    offer: copy(d.offer),
    start: clock(30200),
    end: clock(30201),
    requests: [],
    report: {
      ...copy(d.report),
      state: "checkpoint-only",
      records: [
        {
          id: s.old.id,
          committedRevision: s.old.revision,
          final: false,
          payload: "checkpoint-only",
        },
      ],
    },
  };
  bad(
    "expired",
    "readChunk",
    { read: id(50), offset: 0, maxBytes: 262144 },
    "PLUGIN_E_STALE_RESOURCE",
    30202,
  );
  bad("expired", "commitWrite", { write: s.finalTicket.id }, "PLUGIN_E_STALE_RESOURCE", 30204);
  read(s, "read-sealed", 30206, 51);
  const i = seed(30, 30220, "seed-incomplete", false),
    di = drain(i, "drain-incomplete", 30229, false);
  read(i, "read-incomplete", 30252, 52);
  const seedTrace = [
    { point: "reserve", ticket: s.finalTicket.id, time: 20 },
    { point: "open-temp", ticket: s.finalTicket.id, time: 20.5 },
  ];
  const failed = [...seedTrace, { point: "before-publish", ticket: s.finalTicket.id, time: 42.5 }];
  const retried = [...failed, { point: "before-publish", ticket: s.finalTicket.id, time: 63 }];
  for (const r of calls) {
    if (
      (r.phase === "seed-sealed" || r.phase === "seed-incomplete") &&
      ((r.method === "storage/beginWrite" && r.params.target.mode === "replace") ||
        (["storage/writeChunk", "storage/sealWrite"].includes(r.method) &&
          [s.finalTicket.id, i.finalTicket.id].includes(r.params.write)))
    ) {
      r.phase = r.phase.replace("seed-", "drain-");
      if (r.method === "storage/beginWrite")
        r.params.drainToken = r.phase === "drain-sealed" ? d.offer.token : di.offer.token;
    }
  }
  for (const entry of [d, expired, di]) {
    entry.offer.writes = [];
    entry.offer.acceptedTickets = [];
    for (const req of entry.requests) req.request.writes = [];
  }
  return copy({
    owner,
    channelOwner: owner,
    ownerAfter: owner,
    started: clock(0),
    ended: clock(30260),
    exits: [],
    sdkDrains: [d, di].flatMap((d) =>
      d.requests.map((r) => ({ request: copy(r.request), result: copy(r.result) })),
    ),
    calls,
    drains: [d, expired, di],
    retry: [retry],
    discards: [
      {
        id: recovery.id,
        action: { ...copy(retry.action), actionToken: id(77) },
        start: clock(30210),
        end: clock(30211),
        report: { ...copy(expired.report), state: "saved", blocker: false },
      },
    ],
    publications: [
      {
        ticket: s.finalTicket,
        pin: retained[0].pin,
        deadline: 10060,
        start: clock(62),
        end: clock(64),
        result: { disposition: "not-committed" },
      },
    ],
    retained,
    recovery: {
      before: copy(recovery),
      after: copy(recovery),
      expired: { ...copy(recovery), sealedPin: null, report: copy(expired.report) },
    },
    payloads: { before: s.finalBytes.toString("base64"), after: s.finalBytes.toString("base64") },
    traces: { seed: [], failed, retried, expired: copy(retried), final: copy(retried) },
  });
}
const get = (o, phase, method) =>
  o.calls.find((r) => r.phase === phase && r.method === `storage/${method}`);
const final = (o) =>
  o.calls.find(
    (r) =>
      r.phase === "drain-sealed" &&
      r.method === "storage/beginWrite" &&
      r.params.target.mode === "replace",
  );
const seal = (o) =>
  o.calls.find((r) => r.method === "storage/sealWrite" && r.params.write === final(o).ticket.id);
const evidence = (o) => ({ sealedTtl: o, checks: sealedTtlSummary(o) });

test("pure correlated specimen validates; never executes a native producer", () => {
  const o = specimen();
  assertSealedTtlObservation(o);
  assertSealedTtlEvidence(evidence(o), o.owner.hostEpoch);
  assert.equal(Object.keys(sealedTtlSummary(o)).length, 10);
});
const mutations = {
  "discard before preservation probe": (o) => {
    o.discards[0].start = clock(30200);
  },
  "foreign discard recovery": (o) => {
    o.discards[0].id = id(99);
  },
  "discard still blocked": (o) => {
    o.discards[0].report.blocker = true;
  },
  "early read handle closure": (o) => {
    const r = structuredClone(get(o, "seed-sealed", "readChunk"));
    r.method = "storage/closeRead";
    r.params = { read: r.params.read };
    r.result = { ok: true, value: {} };
    o.calls.push(r);
  },
  "early sealed write abort": (o) => {
    const r = structuredClone(get(o, "status", "writeStatus"));
    r.method = "storage/abortWrite";
    r.result = { ok: true, value: { disposition: "aborted" } };
    o.calls.push(r);
  },
  "original peer never dispatched": (o) => {
    o.sdkDrains = [];
  },
  "channel owner": (o) => o.channelOwner.generation++,
  "changed generation after wait": (o) => (o.ownerAfter.processEpoch = id(99)),
  "consumer exit": (o) => o.exits.push({ code: 0 }),
  "request owner": (o) => (o.calls[0].owner.sourceKey = "foreign"),
  "missing creation ticket": (o) => delete final(o).ticket,
  "creation outside original admission": (o) => final(o).ticket.deadlineMonotonicMs++,
  "changed target CAS": (o) => (final(o).params.target.expectedRevision = "other"),
  "invented write handle": (o) => (final(o).result.value.write = id(99)),
  "wrong metadata hash": (o) => (final(o).params.sha256 = "0".repeat(64)),
  "foreign retained ticket": (o) => o.retained[0].ticket.owner.generation++,
  "missing retained pin": (o) => (o.retained = []),
  "renewed worker retention": (o) => (o.retained[0].expiresMonotonicMs += 30000),
  "missing seal": (o) => o.calls.splice(o.calls.indexOf(seal(o)), 1),
  "incomplete seal bytes": (o) => seal(o).result.value.receivedBytes--,
  "false sealed state": (o) => (seal(o).result.value.state = "receiving"),
  "renewed public expiry": (o) => (get(o, "status", "writeStatus").result.value.expiresAt += 100),
  "progress outside seal interval": (o) => (seal(o).result.value.expiresAt += 100),
  "wall clock jump": (o) => (o.retry[0].start.wall += 100),
  "host only clock advancement": (o) => (o.drains[1].start.elapsed -= 30000),
  "nonfinite clock": (o) => (o.started.mono = NaN),
  "wide clock bracket": (o) => (o.started.end = 100),
  "over budget": (o) => (o.ended = clock(120000)),
  "no real wait": (o) => (o.ended = clock(1000)),
  "failed retry absent": (o) => (o.retry = []),
  "retry succeeded": (o) => (o.retry[0].report.state = "saved"),
  "retry wrong recovery": (o) => (o.retry[0].id = id(99)),
  "retry foreign action": (o) => (o.retry[0].action.scope.hostEpoch = id(99)),
  "retry without action": (o) => delete o.retry[0].action.actionToken,
  "retry on another ticket": (o) => (o.publications[0].ticket.id = id(99)),
  "retry on another pin": (o) => (o.publications[0].pin = id(99)),
  "retry renews work deadline": (o) =>
    (o.publications[0].deadline = o.publications[0].start.mono + 10001),
  "no actual recovery publication": (o) => (o.publications = []),
  "unknown mistaken for safe failure": (o) => (o.publications[0].result.disposition = "unknown"),
  "published retry": (o) => (o.publications[0].result.disposition = "committed"),
  "evidence deleted": (o) => (o.recovery.after = null),
  "evidence ticket deleted": (o) => (o.recovery.after.ticket = null),
  "evidence pin deleted": (o) => (o.recovery.after.sealedPin = null),
  "renewed durable expiry": (o) => o.recovery.after.expiresAt++,
  "expiry not from seal": (o) => {
    for (const r of Object.values(o.recovery)) r.expiresAt += 100;
  },
  "expired pin still authorized": (o) => {
    o.recovery.expired.sealedPin = o.recovery.before.sealedPin;
  },
  "expired evidence removed": (o) => (o.recovery.expired = null),
  "unresolved blocker cleared": (o) => (o.recovery.after.report.blocker = false),
  "staged bytes truncated": (o) => (o.payloads.after = "YQ=="),
  "staged bytes not original source": (o) => (o.payloads.before = o.payloads.after = "YQ=="),
  "drain missing": (o) => o.drains.splice(0, 1),
  "original offer replaced": (o) => (o.drains[1].offer.token = id(99)),
  "offered final not actual write": (o) => o.drains[0].offer.writes.push({ write: id(99) }),
  "drain wrong owner": (o) => o.drains[0].offer.owner.generation++,
  "SDK callback missing": (o) => (o.drains[0].requests = []),
  "SDK callback wrong token": (o) => (o.drains[0].requests[0].request.token = id(99)),
  "SDK callback changed checkpoint": (o) => (o.drains[0].requests[0].request.checkpoints = []),
  "wrong failure cause": (o) =>
    (get(o, "drain-sealed", "commitWrite").result.error.code = "PLUGIN_E_PERMISSION_DENIED"),
  "initial failure succeeded": (o) =>
    (get(o, "drain-sealed", "commitWrite").result = { ok: true, value: {} }),
  "expired offer redispatch": (o) => (o.drains[1].requests = copy(o.drains[0].requests)),
  "before expiry report": (o) => (o.drains[1].start = clock(200)),
  "after expiry still retryable": (o) => (o.drains[1].report.state = "retryable"),
  "after expiry claims complete payload": (o) =>
    (o.drains[1].report.records[0].payload = "complete-staging"),
  "after expiry advertises retry": (o) => (o.drains[1].report.retryAction = id(99)),
  "after expiry claims saved final": (o) => (o.drains[1].report.records[0].final = true),
  "expired pin read succeeds": (o) =>
    (get(o, "expired", "readChunk").result = { ok: true, value: { data: "" } }),
  "pin denial due permissions": (o) =>
    (get(o, "expired", "readChunk").result.error.code = "PLUGIN_E_PERMISSION_DENIED"),
  "never opened original read": (o) =>
    (get(o, "seed-sealed", "openRead").result.value.read = id(99)),
  "never read original bytes": (o) =>
    (get(o, "seed-sealed", "readChunk").result.value.data = "YQ=="),
  "read wrong late handle": (o) => (get(o, "expired", "readChunk").params.read = id(99)),
  "read wrong late offset": (o) => (get(o, "expired", "readChunk").params.offset = 999),
  "read pin renewed secretly": (o) => o.calls.push(copy(get(o, "seed-sealed", "readChunk"))),
  "late commit admitted": (o) =>
    (get(o, "expired", "commitWrite").result = { ok: true, value: {} }),
  "incomplete drain pretends submitted": (o) =>
    (o.drains[2].requests[0].result.value.status = "submitted"),
  "incomplete staging declared final": (o) => (o.drains[2].report.records[0].final = true),
  "incomplete staging declared complete": (o) =>
    (o.drains[2].report.records[0].payload = "complete-staging"),
  "incomplete checkpoint changed revision": (o) =>
    (o.drains[2].report.records[0].committedRevision = "other"),
  "checkpoint read uses different pin": (o) =>
    (get(o, "read-incomplete", "readChunk").params.read = id(99)),
  "checkpoint data invented": (o) =>
    (get(o, "read-incomplete", "readChunk").result.value.data = "YQ=="),
  "checkpoint partial read": (o) =>
    (get(o, "read-incomplete", "readChunk").result.value.eof = false),
  "sealed checkpoint changed": (o) =>
    (get(o, "read-sealed", "openRead").result.value.record.sha256 = "bad"),
  "extra seal renews idle": (o) => o.calls.push(copy(seal(o))),
  "extra chunk renews idle": (o) => o.calls.push(copy(get(o, "seed-sealed", "writeChunk"))),
  "extra publication RPC": (o) => o.calls.push(copy(get(o, "expired", "commitWrite"))),
  "trace missing first fault": (o) => o.traces.failed.pop(),
  "trace rewrites history": (o) => o.traces.expired[0].time++,
  "trace invalid time": (o) => (o.traces.final[0].time = NaN),
  "fault outside failed call": (o) => {
    for (const k of ["failed", "retried", "expired", "final"]) o.traces[k][2].time = 41;
  },
  "retry fault outside retry call": (o) => {
    for (const k of ["retried", "expired", "final"]) o.traces[k][3].time = 66;
  },
  "late publication": (o) =>
    o.traces.final.push({ point: "before-publish", ticket: final(o).ticket.id, time: 30205 }),
  "hidden successful publication": (o) =>
    o.traces.final.push({ point: "after-publish", ticket: final(o).ticket.id, time: 30205 }),
  "hidden receipt": (o) =>
    o.traces.final.push({ point: "receipt-send", ticket: final(o).ticket.id, time: 30205 }),
  "incomplete payload published": (o) =>
    o.traces.final.push({
      point: "before-publish",
      ticket: id(33),
      time: 30245,
    }),
};
for (const [name, mutate] of Object.entries(mutations))
  test(`raw proof rejects ${name}`, () => {
    const o = specimen();
    assertSealedTtlObservation(o);
    mutate(o);
    assert.throws(() => assertSealedTtlObservation(o));
    // Recomputing summaries must not make corrupt raw proof admissible.
    assert.throws(() => assertSealedTtlEvidence(evidence(o)));
  });

test("every ledger summary is bound to raw observations", () => {
  for (const key of Object.keys(evidence(specimen()).checks)) {
    const e = evidence(specimen());
    e.checks[key] = "invented";
    assert.throws(() => assertSealedTtlEvidence(e), key);
  }
  assert.throws(() => assertSealedTtlEvidence({ checks: {} }), /Missing sealed-ttl/);
  assert.throws(() => assertSealedTtlEvidence(evidence(specimen()), id(99)), /another composition/);
});
test("controller handoff remains explicit and no native run is faked", async () => {
  const source = await readFile(
    new URL("./plugin-persistence-sealed-ttl.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /native UNRUN/);
  assert.match(source, /input\.fault\.arm\("before-publish", "fail"\)/);
  assert.doesNotMatch(
    source,
    /new AtomicStore|startPersistenceWorker\(|composeDesktopMain\(|new Worker\(/,
  );
  assert.match(source, /await input\.command\("cleanup"/);
  assert.match(source, /assertSealedTtlEvidence/);
});

test("real prepublication worker exception is retained without calling it a successful retry", () => {
  const o = specimen();
  o.publications[0].result = {
    thrown: {
      name: "Error",
      message: "Persistence request could not be completed.",
      result: { ok: false, error: { code: "PLUGIN_E_STORAGE_IO" } },
    },
  };
  o.retry[0].report.state = "uncertain";
  o.recovery.after.report = copy(o.retry[0].report);
  assertSealedTtlObservation(o);
  o.publications[0].result.thrown.result.error.code = "PLUGIN_E_STALE_RESOURCE";
  assert.throws(() => assertSealedTtlObservation(o));
});

test("producer waits for host aggregation after asynchronous SDK release", async () => {
  const source = await readFile(
    new URL("./plugin-persistence-sealed-ttl.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /await command\("drain-sealed"\);[\s\S]*?await waitForDrain\(1\);[\s\S]*?one\(drains, "first drain"\)/,
  );
  assert.match(source, /await command\("drain-incomplete"\);\s*await waitForDrain\(3\);/);
  assert.match(source, /while \(drains.length < expected\)/);
});

test("public integer wall projection may differ by one tick while durable expiry stays exact", () => {
  const o = specimen();
  get(o, "status", "writeStatus").result.value.expiresAt++;
  assertSealedTtlEvidence(evidence(o));
  o.recovery.after.expiresAt++;
  assert.throws(() => assertSealedTtlEvidence(evidence(o)));
});
test("wire drain remaining time is floored without moving the original offer deadline", () => {
  const o = specimen();
  for (const d of o.drains) for (const r of d.requests) r.request.remainingMs += 0.75;
  assertSealedTtlEvidence(evidence(o));
  o.sdkDrains[0].request.remainingMs++;
  assert.throws(() => assertSealedTtlEvidence(evidence(o)));
});
test("worker mapped I/O exception still requires exact original failed-publication evidence", () => {
  const o = specimen();
  o.publications[0].result = { thrown: { name: "Error", message: "persistence-io" } };
  o.retry[0].report.state = "uncertain";
  o.recovery.after.report.state = "uncertain";
  assertSealedTtlEvidence(evidence(o));
  o.publications[0].result.thrown.message = "unrelated failure";
  assert.throws(() => assertSealedTtlEvidence(evidence(o)));
});
