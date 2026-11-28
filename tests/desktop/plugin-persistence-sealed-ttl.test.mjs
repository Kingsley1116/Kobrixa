import { sealedTtlOracle as specimen } from "./fixtures/plugin-persistence/sealed-ttl-oracle.mjs";
import assert from "node:assert/strict";
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
const offset = 1700000000000;
const clock = (mono) => ({ mono, wall: offset + mono, end: mono, elapsed: mono });
const copy = structuredClone;
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
  "write stayed sealed after expiry": (o) => {
    get(o, "expired", "writeStatus").result.value.state = "sealed";
  },
  "write state belongs to another handle": (o) => {
    get(o, "expired", "writeStatus").result.value.write = id(99);
  },
  "stale commit after discard": (o) => {
    get(o, "expired", "commitWrite").end = clock(30219);
  },
  "stale read after discard": (o) => {
    get(o, "expired", "readChunk").end = clock(30219);
  },
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
