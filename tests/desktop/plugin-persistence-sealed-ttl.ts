import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { LifecycleCaseInput, CaseEvidence } from "./plugin-persistence-main.js";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DrainOffer, DrainReport, Stage3ChannelContext } from "@kobrixa/plugin-runtime";
import type {
  PublicationTicket,
  StoredRecovery,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";

/** Controller handoff (native UNRUN). No new product/version API is required.
 * main.ts: replace ONLY its unavailable("sealed-ttl") entry in the later wiring
 * change, passing the existing LifecycleCaseInput and original recording channel.
 * run.mjs buildUiConsumerArtifacts: declare the ttl-* commands below in the
 * recording manifest. fixtures/plugin-persistence/consumer.ts: implement them on
 * its ORIGINAL ctx.storage / ctx.devices channel; do not return evidence DTOs.
 *
 * seed-sealed: reserve recording; create/chunk/seal/commit a <=256KiB checkpoint,
 * registerCheckpoint with that reservation; openRead/readChunk its whole bytes
 * and retain that read handle. Keep handles in the original process.
 * drain-sealed: release that reservation through the public device SDK, await
 * the existing endReservation -> participant.drain -> original peer dispatcher.
 * Its drain handler begins the same-record final with request.token, sends its
 * whole different payload, seals ONCE and commits with that SAME token; it
 * checks the injected I/O failure, then writeStatus (no second publication).
 * status: writeStatus on the original sealed write (no seal/chunk/renewal).
 * expired: readChunk on the original idle read pin, then commitWrite on the
 * original expired write. Keep both failure results; do not swallow the calls.
 * read-sealed: fresh openRead/readChunk/closeRead of the original checkpoint.
 * seed-incomplete: a second reservation/checkpoint as above, without a final yet.
 * drain-incomplete: public release; original drain callback begins a final with
 * request.token and sends only a nonempty prefix of a larger different payload;
 * returns checkpoint-only without sealing or manufacturing the missing bytes.
 * read-incomplete: fresh whole checkpoint read. cleanup: close reads, abort
 * noncommitted writes and release remaining reservations, even on partial setup.
 *
 * retry(id): main.ts's existing core recovery action bridge Retry path (see
 * disconnect-retry), await it. A forwarding participant.retry observer below
 * captures the actual action/result; the hook supplies neither. after-expiry
 * uses the original cached offer through participant.drain; it must NOT invoke
 * another SDK callback or renew a grant. No disable/restart: pin rejection must
 * be expiry, not revocation of the consumer's generation.
 *
 * Later outside wiring: harness.verifyRunReceipt and main.assertEvidence must
 * call assertSealedTtlEvidence(evidence, receipt.hostEpoch); outcomes must require
 * raw proof, not just ten booleans/numbers. Add this .test.mjs to the explicit
 * oracle script. Do not claim native acceptance from these pure tests.
 *
 * Duration: real idle-expiry wait >=30.1s after original successful read/seal;
 * 100s absolute work budget + 8s cleanup, per-operation cap 15s. superviseCase
 * currently defaults to 60s; wire a sealed-ttl-only outer timeout (e.g. 115s,
 * plus its existing 5s settle allowance) and retain a <=120s outer bound.
 * No fake worker clock advance. Native covers the 30s idle branch; a full 120s
 * total-age run plus setup cannot fit this bound and is NOT claimed here.
 * Public expiresAt is integer wall time; createdAt is recovered independently
 * from the original ticket's +120s deadline. lastProgressAt is the wall-expiry
 * projection constrained to the original seal call interval, NOT an exact
 * internal service timestamp. Worker retention is separately constrained to
 * that interval; host progress and worker progress are not the same sample.
 * Wall/monotonic jumps fail closed. Any exact-expiry drift is a native failure,
 * never normalized into a passing report.
 * cleanup must also let the controller use fresh core Discard actions for the
 * retained test recovery rows AFTER this observation snapshot, so the existing
 * all-zero close gate can finish. Do not fabricate a saved report to close.
 * SDK release returns before host aggregation; producer awaits observed drain
 * completion separately. The command signal must cancel controller waits.
 */
export type SealedTtlStep =
  | "seed-sealed"
  | "drain-sealed"
  | "status"
  | "expired"
  | "read-sealed"
  | "seed-incomplete"
  | "drain-incomplete"
  | "read-incomplete"
  | "cleanup";
export type SealedTtlInput = LifecycleCaseInput & {
  channel: Stage3ChannelContext;
  command(step: SealedTtlStep, signal: AbortSignal): Promise<void>;
  retry(recovery: string, signal: AbortSignal): Promise<void>;
  discard(recovery: string, signal: AbortSignal): Promise<void>;
};
// Raw heterogeneous public envelopes, not substitute services.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;
type Clock = { mono: number; wall: number; end: number; elapsed: number };
type Rpc = {
  phase: string;
  owner: ResourceOwner;
  method: string;
  params: Wire;
  result: Wire;
  start: Clock;
  end: Clock;
  ticket?: PublicationTicket;
};
type Trace = ReturnType<LifecycleCaseInput["fault"]["trace"]>;
type Drain = {
  phase: string;
  offer: DrainOffer;
  start: Clock;
  end: Clock;
  requests: { owner: ResourceOwner; request: Wire; result: Wire }[];
  report: DrainReport;
};
export type SealedTtlObservation = {
  owner: ResourceOwner;
  channelOwner: ResourceOwner;
  ownerAfter: ResourceOwner;
  started: Clock;
  ended: Clock;
  exits: unknown[];
  sdkDrains: { request: Wire; result: Wire }[];
  calls: Rpc[];
  drains: Drain[];
  retry: { id: string; action: Wire; start: Clock; end: Clock; report: DrainReport }[];
  discards: { id: string; action: Wire; start: Clock; end: Clock; report: DrainReport }[];
  publications: {
    ticket: PublicationTicket;
    pin: string;
    deadline: number;
    start: Clock;
    end: Clock;
    result: Wire;
  }[];
  retained: { ticket: PublicationTicket; pin: string; expiresMonotonicMs: number }[];
  recovery: { before: StoredRecovery; after: StoredRecovery; expired: StoredRecovery };
  payloads: { before: string; after: string };
  traces: { seed: Trace; failed: Trace; retried: Trace; expired: Trace; final: Trace };
};
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => {
  assert.equal(typeof s, "string");
  const b = Buffer.from(s, "base64");
  assert.equal(b.toString("base64"), s, "Noncanonical observed bytes");
  return b;
};
const ok = (r: Rpc) => {
  assert.equal(r.result.ok, true);
  return r.result.value as Wire;
};
const finite = (n: number) => assert.ok(Number.isFinite(n) && n >= 0);
const one = <T>(rows: T[], label: string): T => {
  assert.equal(rows.length, 1, `Expected one ${label}, got ${rows.length}`);
  return rows[0]!;
};
const rpc = (o: SealedTtlObservation, phase: string, method: string) =>
  one(
    o.calls.filter((r) => r.phase === phase && r.method === `storage/${method}`),
    `${phase}/${method}`,
  );
const offset = (o: SealedTtlObservation) => o.started.wall - o.started.mono;
const count = (t: Trace, point: string, id: string) =>
  t.filter((r) => r.point === point && r.ticket === id).length;
function clock(c: Clock, origin: Clock) {
  for (const n of [c.mono, c.wall, c.end, c.elapsed]) finite(n);
  assert.ok(c.end >= c.mono && c.end - c.mono <= 5, "Clock sample was not atomic enough");
  // Reject wall jumps and advanced host-only clocks; worker uses real performance.now().
  assert.ok(Math.abs(c.mono - origin.mono - (c.elapsed - origin.elapsed)) <= 5);
  assert.ok(Math.abs(c.wall - origin.wall - (c.mono - origin.mono)) <= 5);
}
function denied(r: Rpc, code: string) {
  assert.equal(r.result.ok, false);
  assert.equal(r.result.value, undefined);
  assert.equal(r.result.error?.code, code);
}
function record(t: PublicationTicket) {
  assert.equal(t.metadata.kind, "record");
  assert.equal(t.target.kind, "record");
  assert.ok(t.metadata.kind === "record" && t.target.kind === "record");
  assert.equal(t.metadata.deleted, false);
  assert.equal(t.target.id, t.metadata.record.id);
  return t.metadata.record;
}
function finalBegin(o: SealedTtlObservation, phase: string) {
  return one(
    o.calls.filter(
      (r) =>
        r.phase === phase &&
        r.method === "storage/beginWrite" &&
        r.params.target.mode === "replace",
    ),
    `${phase} replacement`,
  );
}
function checkpoint(o: SealedTtlObservation, phase: string, readPhase: string, complete: boolean) {
  const finalPhase = phase.replace("seed-", "drain-");
  const begin = finalBegin(o, finalPhase),
    t = begin.ticket!;
  assert.ok(t);
  const meta = record(t);
  assert.deepEqual(t.owner, o.owner);
  assert.equal(ok(begin).write, t.id);
  assert.equal(ok(begin).id, meta.id);
  assert.equal(meta.checkpoint, "final");
  assert.deepEqual(begin.params.target, {
    mode: "replace",
    id: meta.id,
    expectedRevision: t.target.kind === "record" ? t.target.expectedRevision : null,
  });
  for (const k of ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"])
    assert.equal(begin.params[k], meta[k as keyof typeof meta]);
  const committed = rpc(o, phase, "commitWrite"),
    old = ok(committed).record;
  const seed = one(
    o.calls.filter(
      (r) =>
        r.phase === phase && r.method === "storage/beginWrite" && r.params.target.mode === "create",
    ),
    "checkpoint create",
  );
  assert.ok(seed.ticket);
  assert.deepEqual(record(seed.ticket), old);
  assert.deepEqual(seed.ticket.owner, o.owner);
  assert.equal(ok(seed).write, seed.ticket.id);
  assert.equal(committed.params.write, seed.ticket.id);
  assert.equal(ok(committed).receipt.revision, old.revision);
  assert.match(ok(committed).receipt.commitId, /^[0-9a-f-]{36}$/);
  assert.equal(meta.id, old.id);
  assert.notEqual(meta.revision, old.revision);
  assert.equal(begin.params.target.expectedRevision, old.revision);
  const registration = rpc(o, phase, "registerCheckpoint");
  assert.equal(registration.params.id, old.id);
  assert.equal(registration.params.expectedRevision, old.revision);
  assert.equal(begin.params.checkpoint.handle, ok(registration).checkpoint);
  assert.equal(begin.params.checkpoint.phase, "final");
  const chunks = o.calls.filter(
    (r) => (r.phase === phase || r.phase === finalPhase) && r.method === "storage/writeChunk",
  );
  const sent = (id: string) => {
    const c = one(
      chunks.filter((r) => r.params.write === id),
      "original chunk",
    );
    assert.equal(c.params.offset, 0);
    const b = bytes(c.params.data);
    assert.equal(ok(c).receivedBytes, b.length);
    assert.ok(b.length > 0 && b.length <= 262144);
    return b;
  };
  const original = sent(seed.ticket.id),
    staged = sent(t.id);
  assert.equal(original.length, old.byteLength);
  assert.equal(hash(original), old.sha256);
  assert.notEqual(meta.sha256, old.sha256);
  const seals = o.calls.filter(
    (r) => (r.phase === phase || r.phase === finalPhase) && r.method === "storage/sealWrite",
  );
  assert.equal(seals.length, complete ? 2 : 1);
  assert.equal(
    ok(
      one(
        seals.filter((r) => r.params.write === seed.ticket!.id),
        "checkpoint seal",
      ),
    ).state,
    "sealed",
  );
  if (complete) {
    assert.equal(staged.length, meta.byteLength);
    assert.equal(hash(staged), meta.sha256);
    const seal = one(
      seals.filter((r) => r.params.write === t.id),
      "final seal",
    );
    assert.equal(ok(seal).state, "sealed");
    assert.equal(ok(seal).receivedBytes, staged.length);
    assert.equal(ok(seal).write, t.id);
    assert.equal(ok(seal).id, meta.id);
  } else {
    assert.ok(staged.length < meta.byteLength);
    assert.notEqual(hash(staged), meta.sha256);
  }
  const open = rpc(o, readPhase, "openRead"),
    read = rpc(o, readPhase, "readChunk");
  assert.deepEqual(open.params, {
    id: old.id,
    expectedRevision: old.revision,
    schemaVersion: old.schemaVersion,
  });
  assert.equal(ok(open).record.revision, old.revision);
  assert.equal(ok(open).record.sha256, old.sha256);
  assert.equal(read.params.read, ok(open).read);
  assert.equal(read.params.offset, 0);
  assert.ok(read.params.maxBytes >= original.length && read.params.maxBytes <= 262144);
  assert.equal(ok(read).offset, 0);
  assert.equal(ok(read).nextOffset, original.length);
  assert.equal(ok(read).eof, true);
  assert.deepEqual(bytes(ok(read).data), original);
  return { begin, t, meta, old, original, staged };
}

/** Pure consistency oracle. JSON cannot authenticate a native run. */
export function assertSealedTtlObservation(o: SealedTtlObservation): void {
  assert.ok(o && o.owner && Array.isArray(o.calls));
  assert.deepEqual(o.owner, o.channelOwner);
  assert.deepEqual(o.ownerAfter, o.owner);
  assert.deepEqual(o.exits, [], "Original consumer exited; expiry attribution invalid");
  clock(o.started, o.started);
  clock(o.ended, o.started);
  assert.ok(
    o.ended.elapsed - o.started.elapsed > 30000 && o.ended.elapsed - o.started.elapsed < 110000,
  );
  for (const row of [...o.calls, ...o.drains, ...o.retry, ...o.publications]) {
    clock(row.start, o.started);
    clock(row.end, o.started);
    assert.ok(row.end.mono >= row.start.mono);
    assert.ok(row.start.mono >= o.started.mono && row.end.mono <= o.ended.mono);
  }
  for (const r of o.calls) assert.deepEqual(r.owner, o.owner);
  const s = checkpoint(o, "seed-sealed", "read-sealed", true);
  const i = checkpoint(o, "seed-incomplete", "read-incomplete", false);
  assert.notEqual(s.meta.id, i.meta.id);
  assert.notEqual(s.t.id, i.t.id);
  const seal = one(
    o.calls.filter(
      (r) =>
        r.phase === "drain-sealed" && r.method === "storage/sealWrite" && r.params.write === s.t.id,
    ),
    "sealed status",
  );
  const created = s.t.deadlineMonotonicMs - 120000;
  assert.ok(created >= s.begin.start.mono && created <= s.begin.end.mono);
  // Public integer projection has <1ms rounding, plus bounded clock sample skew.
  const expiry = ok(seal).expiresAt - offset(o),
    progress = expiry - 30000;
  assert.ok(progress >= seal.start.mono - 6 && progress <= seal.end.mono + 6);
  assert.equal(expiry, Math.min(progress + 30000, created + 120000));
  assert.ok(ok(s.begin).expiresAt - offset(o) >= created + 30000 - 6);
  assert.ok(ok(s.begin).expiresAt - offset(o) <= created + 30000 + 6);
  const retained = one(
    o.retained.filter((r) => r.ticket.id === s.t.id),
    "original sealed pin",
  );
  assert.deepEqual(retained.ticket, s.t);
  assert.ok(retained.pin);
  assert.ok(retained.expiresMonotonicMs - 30000 >= seal.start.mono);
  assert.ok(retained.expiresMonotonicMs - 30000 <= seal.end.mono);
  const status = rpc(o, "status", "writeStatus");
  assert.deepEqual(status.params, { write: s.t.id });
  assert.equal(ok(status).state, "sealed");
  assert.equal(ok(status).write, s.t.id);
  // wallExpiry floors Date.now()+deadline-performance.now() for each response.
  // Integer wall sampling may shift by one tick without changing the deadline.
  // Durable retention expiry below must remain exactly equal across the retry.
  const statusExpiry = ok(status).expiresAt - status.start.wall + status.start.mono;
  assert.ok(
    Math.abs(statusExpiry - retained.expiresMonotonicMs) <= 6,
    "Failed retry changed projected TTL beyond bounded wall sampling",
  );
  const retry = one(o.retry, "actual core retry"),
    pub = one(o.publications, "actual recovery publication");
  assert.equal(retry.id, o.recovery.before.id);
  assert.match(retry.action.actionToken, /^[0-9a-f-]{36}$/);
  assert.equal(retry.action.scope.hostEpoch, o.owner.hostEpoch);
  assert.ok(retry.start.mono < pub.start.mono && pub.end.mono <= retry.end.mono);
  assert.ok(retry.end.mono < retained.expiresMonotonicMs);
  assert.ok(pub.deadline > pub.start.mono && pub.deadline <= pub.start.mono + 10000);
  assert.ok(pub.deadline <= retained.expiresMonotonicMs);
  assert.deepEqual(pub.ticket, s.t);
  assert.equal(pub.pin, retained.pin);
  if (pub.result.thrown) {
    if (pub.result.thrown.result) {
      assert.equal(pub.result.thrown.result.ok, false);
      assert.equal(pub.result.thrown.result.error?.code, "PLUGIN_E_STORAGE_IO");
    } else {
      // Worker RPC maps the controlled pre-publication I/O exception to this
      // bounded message; the exact ticket failpoint trace is checked below.
      assert.equal(pub.result.thrown.name, "Error");
      assert.equal(pub.result.thrown.message, "persistence-io");
    }
    assert.equal(retry.report.state, "uncertain");
  } else {
    assert.equal(pub.result.disposition, "not-committed");
    assert.equal(retry.report.state, "retryable");
  }
  assert.equal(retry.report.blocker, true);
  assert.ok(status.start.mono >= retry.end.mono);
  const stored = [o.recovery.before, o.recovery.after, o.recovery.expired];
  for (const r of stored) {
    assert.ok(r);
    assert.equal(r.id, retry.id);
    assert.deepEqual(r.owner, o.owner);
    assert.deepEqual(r.ticket, s.t);
    assert.equal(r.sealedPin, r === o.recovery.expired ? null : retained.pin);
    assert.equal(r.expiresAt, stored[0]!.expiresAt, "Recovery retry renewed original expiry");
    assert.ok(r.report.blocker);
    assert.notEqual(r.report.state, "saved");
  }
  assert.ok(Math.abs(o.recovery.before.expiresAt! - offset(o) - retained.expiresMonotonicMs) <= 6);
  // The real retry port refreshes lifecycle recovery after persisting its result.
  // A pre-dispatch exception can return uncertain while refresh proves retryable.
  assert.ok(["retryable", "uncertain"].includes(o.recovery.after.report.state));
  for (const r of [o.recovery.before, o.recovery.after]) {
    const rec = one(r.report.records, "retained recovery record");
    assert.equal(rec.id, s.meta.id);
    assert.equal(rec.committedRevision, s.old.revision);
    assert.equal(rec.final, false);
    assert.equal(rec.payload, "complete-staging");
    assert.ok(Math.abs(rec.expiresAt! - r.expiresAt!) <= 1);
  }
  const expiredRecovery = one(o.recovery.expired.report.records, "expired durable record");
  assert.equal(expiredRecovery.id, s.meta.id);
  assert.equal(expiredRecovery.payload, "checkpoint-only");
  assert.equal(expiredRecovery.committedRevision, s.old.revision);
  assert.deepEqual(bytes(o.payloads.before), s.staged);
  assert.equal(o.payloads.after, o.payloads.before);
  assert.deepEqual(
    o.drains.map((r) => r.phase),
    ["drain-sealed", "after-expiry", "drain-incomplete"],
  );
  assert.deepEqual(
    o.sdkDrains,
    o.drains.flatMap((d) =>
      d.requests.map((r) => ({
        request: { ...r.request, remainingMs: Math.floor(r.request.remainingMs) },
        result: r.result,
      })),
    ),
  );
  const [drain, expired, incomplete] = o.drains;
  for (const [d, staged, state] of [
    [drain!, s, "sealed"],
    [incomplete!, i, "receiving"],
  ] as const) {
    assert.deepEqual(d.offer.owner, o.owner);
    assert.ok(staged.begin.start.mono >= d.start.mono && staged.begin.end.mono <= d.end.mono);
    assert.ok(
      d.offer.deadlineMonotonicMs > d.start.mono &&
        d.offer.deadlineMonotonicMs <= d.start.mono + 10000,
    );
    assert.deepEqual(d.offer.writes, []);
    assert.equal(staged.begin.params.drainToken, d.offer.token);
    const cp = one([...d.offer.checkpoints], "original offered checkpoint");
    assert.equal(cp.record.id, staged.old.id);
    assert.equal(cp.record.revision, staged.old.revision);
    assert.equal(cp.checkpoint, staged.begin.params.checkpoint.handle);
    assert.ok(
      !d.offer.acceptedTickets.includes(staged.t.id),
      "Final was not yet admitted at offer capture",
    );
    const req = one(d.requests, "original SDK drain dispatch");
    assert.deepEqual(req.owner, o.owner);
    assert.deepEqual(req.request.writes, d.offer.writes);
    assert.deepEqual(req.request.checkpoints, d.offer.checkpoints);
    assert.equal(req.request.token, d.offer.token);
    assert.equal(req.result.ok, true);
    assert.equal(d.report.blocker, true);
    const r = one(d.report.records, "drain record");
    assert.equal(r.id, staged.meta.id);
    assert.equal(r.committedRevision, staged.old.revision);
    assert.equal(r.final, false);
    assert.equal(r.payload, state === "sealed" ? "complete-staging" : "checkpoint-only");
  }
  assert.equal(drain!.report.state, "retryable");
  assert.equal(incomplete!.report.state, "checkpoint-only");
  assert.equal(incomplete!.requests[0]!.result.value.status, "checkpoint-only");
  assert.deepEqual(incomplete!.requests[0]!.result.value.writes, []);
  assert.deepEqual(expired!.offer, drain!.offer);
  assert.deepEqual(expired!.requests, []);
  assert.ok(expired!.start.mono > Math.max(expiry + 6, retained.expiresMonotonicMs));
  assert.equal(expired!.report.state, "checkpoint-only");
  assert.equal(expired!.report.blocker, true);
  assert.equal(expired!.report.retryAction, undefined);
  const expiredRecord = one(expired!.report.records, "expired checkpoint");
  assert.equal(expiredRecord.id, s.meta.id);
  assert.equal(expiredRecord.committedRevision, s.old.revision);
  assert.equal(expiredRecord.payload, "checkpoint-only");
  assert.equal(expiredRecord.final, false);
  assert.equal(expiredRecord.expiresAt, undefined);
  const failed = rpc(o, "drain-sealed", "commitWrite");
  assert.equal(failed.params.write, s.t.id);
  assert.equal(failed.params.drainToken, drain!.offer.token);
  denied(failed, "PLUGIN_E_STORAGE_IO");
  const opened = rpc(o, "seed-sealed", "openRead"),
    early = rpc(o, "seed-sealed", "readChunk");
  assert.equal(opened.params.id, s.old.id);
  assert.equal(opened.params.expectedRevision, s.old.revision);
  assert.equal(early.params.read, ok(opened).read);
  assert.deepEqual(bytes(ok(early).data), s.original);
  const late = rpc(o, "expired", "readChunk");
  assert.equal(late.params.read, ok(opened).read);
  assert.equal(late.params.offset, 0);
  assert.ok(late.params.maxBytes > 0 && late.params.maxBytes <= 262144);
  assert.ok(late.start.mono > early.end.mono + 30000);
  assert.ok(late.start.mono > ok(opened).expiresAt - offset(o) + 6);
  denied(late, "PLUGIN_E_STALE_RESOURCE");
  assert.equal(
    o.calls.filter((r) => r.method === "storage/readChunk" && r.params.read === late.params.read)
      .length,
    2,
  );
  const lateCommit = rpc(o, "expired", "commitWrite");
  assert.equal(lateCommit.params.write, s.t.id);
  assert.ok(lateCommit.start.mono >= expired!.start.mono);
  denied(lateCommit, "PLUGIN_E_STALE_RESOURCE");
  assert.equal(
    o.calls.filter(
      (r) =>
        r.method === "storage/closeRead" &&
        r.params.read === late.params.read &&
        r.start.mono < late.start.mono,
    ).length,
    0,
    "Early read closure invalidates expiry attribution",
  );
  assert.equal(
    o.calls.filter(
      (r) =>
        r.method === "storage/abortWrite" &&
        r.params.write === s.t.id &&
        r.start.mono < lateCommit.start.mono,
    ).length,
    0,
    "Early write abort invalidates expiry attribution",
  );
  const discard = one(o.discards, "explicit post-expiry recovery discard");
  clock(discard.start, o.started);
  clock(discard.end, o.started);
  assert.equal(discard.id, o.recovery.expired.id);
  assert.match(discard.action.actionToken, /^[0-9a-f-]{36}$/);
  assert.equal(discard.action.scope.hostEpoch, o.owner.hostEpoch);
  assert.ok(["saved", "checkpoint-only"].includes(discard.report.state));
  assert.equal(discard.report.blocker, false);
  assert.ok(discard.start.mono >= rpc(o, "read-sealed", "readChunk").end.mono);
  assert.ok(discard.end.mono <= rpc(o, "seed-incomplete", "commitWrite").start.mono);

  // Reject a hidden reseal/chunk or extra commit even if all correlated summaries agree.
  assert.equal(o.calls.filter((r) => r.method === "storage/commitWrite").length, 4);
  assert.equal(o.calls.filter((r) => r.method === "storage/sealWrite").length, 3);
  assert.equal(o.calls.filter((r) => r.method === "storage/writeChunk").length, 4);
  const stages = Object.values(o.traces);
  for (let n = 0; n < stages.length; n++) {
    const t = stages[n]!;
    if (n) assert.deepEqual(t.slice(0, stages[n - 1]!.length), stages[n - 1]);
    for (let k = 0; k < t.length; k++) {
      finite(t[k]!.time);
      if (k) assert.ok(t[k]!.time >= t[k - 1]!.time);
    }
    assert.equal(count(t, "before-publish", s.t.id), n === 0 ? 0 : n === 1 ? 1 : 2);
    assert.equal(count(t, "after-publish", s.t.id), 0);
    assert.equal(count(t, "receipt-send", s.t.id), 0);
    assert.equal(count(t, "reserve", s.t.id), n === 0 ? 0 : 1);
    assert.equal(count(t, "open-temp", s.t.id), n === 0 ? 0 : 1);
    for (const point of ["before-publish", "after-publish", "receipt-send"])
      assert.equal(count(t, point, i.t.id), 0);
  }
  const attempts = o.traces.final.filter(
    (r) => r.point === "before-publish" && r.ticket === s.t.id,
  );
  for (const [row, call] of [
    [attempts[0]!, failed],
    [attempts[1]!, pub],
  ] as const)
    assert.ok(
      row.time >= call.start.mono && row.time <= call.end.mono,
      "Failpoint belongs to another operation",
    );
  assert.equal(
    o.traces.final.filter(
      (r) => r.ticket === s.t.id && r.point === "before-publish" && r.time >= expired!.start.mono,
    ).length,
    0,
  );
}

export function sealedTtlSummary(o: SealedTtlObservation): CaseEvidence["checks"] {
  const b = finalBegin(o, "drain-sealed"),
    id = b.ticket!.id;
  const expiry = o.recovery.before.expiresAt! - offset(o);
  const expired = o.drains[1]!;
  return {
    createdAt: b.ticket!.deadlineMonotonicMs - 120000,
    lastProgressAt: expiry - 30000,
    observedExpiry: expiry,
    expiryAfterFailedRetry: o.recovery.after.expiresAt! - offset(o),
    afterExpiry: expired.report.state,
    latePublishCalls: o.traces.final.filter(
      (r) => r.point === "before-publish" && r.ticket === id && r.time >= expired.start.mono,
    ).length,
    unresolvedEvidenceDeleted: !o.recovery.after?.ticket || !o.recovery.after?.sealedPin,
    originalExpiryPreserved:
      o.recovery.before.expiresAt === o.recovery.after.expiresAt &&
      o.recovery.after.expiresAt === o.recovery.expired.expiresAt,
    expiredPinRejected:
      rpc(o, "expired", "readChunk").result.error?.code === "PLUGIN_E_STALE_RESOURCE",
    checkpointOnlyNoInventedBytes:
      o.drains[2]!.report.state === "checkpoint-only" &&
      hash(bytes(ok(rpc(o, "read-incomplete", "readChunk")).data)) ===
        ok(rpc(o, "seed-incomplete", "commitWrite")).record.sha256,
  };
}
export function assertSealedTtlEvidence(
  e: { sealedTtl?: SealedTtlObservation; checks: CaseEvidence["checks"] },
  hostEpoch?: string,
): void {
  assert.ok(e.sealedTtl, "Missing sealed-ttl raw observations");
  assertSealedTtlObservation(e.sealedTtl);
  if (hostEpoch !== undefined)
    assert.equal(e.sealedTtl.owner.hostEpoch, hostEpoch, "Proof belongs to another composition");
  assert.deepEqual(e.checks, sealedTtlSummary(e.sealedTtl));
}

/** Uses only the supplied composition; never starts a worker, Electron or hardware. */
export async function produceSealedTtl(
  input: SealedTtlInput,
): Promise<CaseEvidence & { sealedTtl: SealedTtlObservation }> {
  assert.equal(
    typeof input.command,
    "function",
    "Controller must wire original ttl-* SDK commands",
  );
  assert.equal(typeof input.retry, "function", "Controller must wire original core Retry action");
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin") throw new Error("Missing original consumer");
  const owner = principal.owner;
  assert.deepEqual(input.channel.owner, owner);
  const sample = (): Clock => {
    const mono = input.now(),
      wall = Date.now();
    return { mono, wall, end: input.now(), elapsed: performance.now() };
  };
  const started = sample(),
    abort = new AbortController(),
    restores: (() => void)[] = [];
  let phase = "setup";
  const calls: Rpc[] = [],
    drains: Drain[] = [],
    retry: SealedTtlObservation["retry"] = [],
    publications: SealedTtlObservation["publications"] = [],
    discards: SealedTtlObservation["discards"] = [],
    retained: SealedTtlObservation["retained"] = [],
    exits: unknown[] = [];
  const sdkDrains: SealedTtlObservation["sdkDrains"] = [];
  const pending = new Set<Promise<unknown>>();
  // One absolute real-time budget, including waits; timeout aborts controller work.
  async function bounded<T>(work: Promise<T>, cleanup = false): Promise<T> {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          const ms = cleanup
            ? 8000
            : Math.min(15000, 100000 - (performance.now() - started.elapsed));
          timer = setTimeout(
            () => {
              abort.abort();
              reject(new Error("sealed-ttl bounded operation expired; native evidence incomplete"));
            },
            Math.max(1, ms),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const traceStart = input.fault.trace().length,
    trace = () => structuredClone(input.fault.trace().slice(traceStart));
  const tickets = () =>
    input.backend.evidence.tickets(
      input.backend.evidence.capture({ kind: "namespace", owner }, input.now() + 10000),
    );
  const retain = input.backend.evidence.retainSealed,
    publish = input.backend.engine.publishRecovery;
  assert.ok(retain, "Missing real worker retainSealed port");
  assert.ok(publish, "Missing real worker publishRecovery port");
  const original = input.host.request;
  input.host.request = async function (this: typeof input.host, ...args) {
    const observe = args[0].kind === "plugin" && isDeepStrictEqual(args[0].owner, owner);
    const start = sample(),
      before = observe && args[1] === "storage/beginWrite" ? tickets().map((t) => t.id) : [];
    if (observe && phase === "drain-sealed" && args[1] === "storage/commitWrite")
      input.fault.arm("before-publish", "fail");
    const result = await original.apply(this, args);
    if (observe) {
      const row: Rpc = {
        phase,
        owner: structuredClone(owner),
        method: args[1],
        params: structuredClone(args[2]),
        result: structuredClone(result),
        start,
        end: sample(),
      };
      if (args[1] === "storage/beginWrite" && result.ok)
        row.ticket = structuredClone(
          one(
            [...tickets()].filter((t) => !before.includes(t.id)),
            "actual admitted ticket",
          ),
        );
      calls.push(row);
    }
    return result;
  } as typeof original;
  restores.push(() => {
    input.host.request = original;
  });
  input.backend.evidence.retainSealed = async function (ticket) {
    const pin = await retain.call(this, ticket);
    if (isDeepStrictEqual(ticket.owner, owner))
      retained.push({ ticket: structuredClone(ticket), ...pin });
    return pin;
  };
  restores.push(() => {
    input.backend.evidence.retainSealed = retain;
  });
  const peer = input.channel.peer,
    peerRequest = peer.request;
  peer.request = async function (this: typeof peer, ...args) {
    const result = await peerRequest.apply(this, args);
    if (args[0] === "storage/drain")
      sdkDrains.push({
        request: structuredClone(args[1]) as Wire,
        result: structuredClone(result) as Wire,
      });
    return result;
  } as typeof peerRequest;
  restores.push(() => {
    peer.request = peerRequest;
  });
  const participant = input.host.participant,
    drain = participant.drain;
  participant.drain = async function (offer, dispatch) {
    const row: Drain = {
      phase,
      offer: structuredClone(offer),
      start: sample(),
      end: sample(),
      requests: [],
      report: undefined!,
    };
    const report = await drain.call(this, offer, async (o, request, signal) => {
      const result = await dispatch(o, request, signal);
      row.requests.push({
        owner: structuredClone(o),
        request: structuredClone(request),
        result: structuredClone(result),
      });
      return result;
    });
    row.report = structuredClone(report);
    row.end = sample();
    drains.push(row);
    return report;
  };
  restores.push(() => {
    participant.drain = drain;
  });
  const discardPort = participant.discard;
  participant.discard = async function (id, action) {
    const start = sample();
    const report = await discardPort.call(this, id, action);
    discards.push({
      id,
      action: structuredClone(action),
      start,
      end: sample(),
      report: structuredClone(report),
    });
    return report;
  };
  restores.push(() => {
    participant.discard = discardPort;
  });
  const retryPort = participant.retry;
  participant.retry = async function (id, action) {
    const start = sample(),
      report = await retryPort.call(this, id, action);
    retry.push({
      id,
      action: structuredClone(action),
      start,
      end: sample(),
      report: structuredClone(report),
    });
    return report;
  };
  restores.push(() => {
    participant.retry = retryPort;
  });
  input.backend.engine.publishRecovery = async function (ticket, pin, deadline) {
    const start = sample();
    try {
      const result = await publish.call(this, ticket, pin, deadline);
      publications.push({
        ticket: structuredClone(ticket),
        pin,
        deadline,
        start,
        end: sample(),
        result: structuredClone(result),
      });
      return result;
    } catch (error) {
      const e = error as Error & { result?: Wire };
      publications.push({
        ticket: structuredClone(ticket),
        pin,
        deadline,
        start,
        end: sample(),
        result: {
          thrown: {
            name: e.name,
            message: e.message,
            ...(e.result ? { result: structuredClone(e.result) } : {}),
          },
        },
      });
      throw error;
    }
  };
  restores.push(() => {
    input.backend.engine.publishRecovery = publish;
  });
  restores.push(input.recording.child.onExit((e) => exits.push(e)));
  const command = async (step: SealedTtlStep) => {
    phase = step;
    await bounded(input.command(step, abort.signal));
  };
  const waitForDrain = async (expected: number) =>
    bounded(
      (async () => {
        while (drains.length < expected) {
          abort.signal.throwIfAborted();
          await new Promise<void>((done) => setTimeout(done, 5));
        }
        assert.equal(drains.length, expected, "Unexpected extra host drain");
      })(),
    );
  let observation: SealedTtlObservation | undefined, failure: unknown;
  try {
    await command("seed-sealed");
    const seed = trace();
    const reached = input.fault.reached("before-publish");
    await command("drain-sealed");
    await bounded(reached);
    await waitForDrain(1);
    const admitted = one(
      calls.filter(
        (r) =>
          r.phase === "drain-sealed" &&
          r.method === "storage/beginWrite" &&
          r.params.target.mode === "replace",
      ),
      "sealed final",
    );
    const t = admitted.ticket!,
      pin = one(
        retained.filter((r) => r.ticket.id === t.id),
        "sealed pin",
      );
    const failed = trace(),
      report = one(drains, "first drain").report;
    assert.ok(report.recovery, "Original drain did not retain recovery");
    const before = await bounded(input.backend.evidence.loadRecovery(report.recovery));
    assert.ok(before?.ticket && before.sealedPin && before.expiresAt !== null);
    const beforeBytes = await bounded(input.backend.reads.read(owner, before.sealedPin, 0, 262144));
    phase = "retry";
    const retryReached = input.fault.reached("before-publish");
    input.fault.arm("before-publish", "fail");
    await bounded(input.retry(before.id, abort.signal));
    await bounded(retryReached);
    const after = await bounded(input.backend.evidence.loadRecovery(before.id));
    assert.ok(after);
    const afterBytes = await bounded(input.backend.reads.read(owner, before.sealedPin, 0, 262144));
    const retried = trace();
    await command("status");
    const seal = one(
      calls.filter((r) => r.method === "storage/sealWrite" && r.params.write === t.id),
      "seal",
    );
    const earlyRead = one(
      calls.filter((r) => r.phase === "seed-sealed" && r.method === "storage/readChunk"),
      "idle read pin",
    );
    const target =
      Math.max(
        pin.expiresMonotonicMs,
        ok(seal).expiresAt - (started.wall - started.mono),
        earlyRead.end.mono + 30000,
      ) + 100;
    assert.ok(target - input.now() < 35000, "Unexpected renewed TTL; refusing extended wait");
    while (input.now() < target) {
      assert.ok(performance.now() - started.elapsed < 95000, "No real monotonic progress");
      await bounded(
        new Promise<void>((done) => setTimeout(done, Math.min(250, target - input.now()))),
      );
    }
    phase = "after-expiry";
    await bounded(
      participant.drain(drains[0]!.offer, async () => {
        throw new Error("Expired offer redispatched SDK drain");
      }),
    );
    await command("expired");
    const expiredRecovery = await bounded(input.backend.evidence.loadRecovery(before.id));
    assert.ok(expiredRecovery);
    const expired = trace();
    await command("read-sealed");
    // The expired unresolved group retains its original deadline. Explicit core
    // discard after the preservation proof ends it before admitting another group.
    phase = "discard-expired";
    await bounded(input.discard(before.id, abort.signal));
    await command("seed-incomplete");
    await command("drain-incomplete");
    await waitForDrain(3);
    await command("read-incomplete");
    const afterPrincipal = input.recording.principal();
    assert.equal(afterPrincipal.kind, "plugin");
    if (afterPrincipal.kind !== "plugin") throw new Error("Original consumer lost");
    observation = {
      owner,
      channelOwner: structuredClone(input.channel.owner),
      ownerAfter: afterPrincipal.owner,
      started,
      ended: sample(),
      exits: structuredClone(exits),
      sdkDrains: structuredClone(sdkDrains),
      calls: structuredClone(calls),
      drains: structuredClone(drains),
      retry,
      publications,
      discards: structuredClone(discards),
      retained,
      recovery: { before, after, expired: expiredRecovery },
      payloads: {
        before: Buffer.from(beforeBytes).toString("base64"),
        after: Buffer.from(afterBytes).toString("base64"),
      },
      traces: { seed, failed, retried, expired, final: trace() },
    };
    assertSealedTtlObservation(observation);
  } catch (error) {
    failure = error;
  }
  // Always attempt all cleanup, including timeout paths. Never turn cleanup failure into PASS.
  const errors: unknown[] = [];
  const clean = async (task: () => unknown | Promise<unknown>) => {
    try {
      await task();
    } catch (e) {
      errors.push(e);
    }
  };
  await clean(() => input.fault.release("before-publish"));
  // Resolve fixture-only checkpoint blockers using the same trusted UI bridge,
  // after capturing all TTL evidence. Cleanup never supplies an acceptance result.
  for (const report of drains.map((d) => d.report))
    if (report.recovery)
      await clean(async () => {
        if (input.host.recovery.snapshot().items.some((row) => row.id === report.recovery))
          await bounded(input.discard(report.recovery!, AbortSignal.timeout(7000)), true);
      });
  abort.abort();
  phase = "cleanup";
  // One 8s cleanup allowance shared by settlement and public consumer cleanup.
  await clean(() =>
    bounded(
      (async () => {
        await Promise.allSettled([...pending]);
        await input.command("cleanup", AbortSignal.timeout(7000));
      })(),
      true,
    ),
  );
  for (const restore of restores.reverse()) await clean(restore);
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "sealed-ttl producer failed (native acceptance not established)",
      {
        cause: observation ?? {
          calls,
          drains,
          retry,
          publications,
          retained,
          sdkDrains,
          traces: trace(),
          exits,
        },
      },
    );
  assert.ok(observation);
  return { sealedTtl: observation, checks: sealedTtlSummary(observation), events: [], samples: {} };
}
