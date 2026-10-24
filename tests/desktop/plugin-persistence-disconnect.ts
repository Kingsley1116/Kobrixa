import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { LifecycleCaseInput, CaseEvidence } from "./plugin-persistence-main.js";
import type { ContentionCheckpoint } from "./plugin-persistence-contention.js";
import type { LifecycleCoordinator } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type { CoreActionLedger } from "../../apps/desktop/src/main/plugins/core-recovery.js";
import type { BuiltinDeviceProvider } from "../../apps/desktop/src/main/device-broker/provider.js";
import type { FakeProviderControl } from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import type { JournalPort } from "../../apps/desktop/src/main/device-broker/journal-port.js";
import type {
  PublicationTicket,
  StoredRecovery,
  PersistenceBarrierEvidence,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type {
  CoreActionReference,
  CoreActionTarget,
  CoreWindowScope,
  DrainOffer,
  DrainReport,
  ReservationEnded,
  Stage3ChannelContext,
} from "@kobrixa/plugin-runtime";
import type {
  DrainRequest,
  ReservationSnapshot,
  StorageRequestMap,
  MotionSnapshot,
  RecordMeta,
} from "@kobrixa/plugin-protocol";

/** Host-adapter acceptance on the original composition; never a native-click receipt. */
export type DisconnectCaseInput = LifecycleCaseInput & {
  lifecycle: LifecycleCoordinator;
  channel: Stage3ChannelContext;
  actions: CoreActionLedger;
  provider: BuiltinDeviceProvider;
  providerControl: FakeProviderControl;
  journal: JournalPort;
  scope(): CoreWindowScope;
  reserveRecording(): Promise<ReservationSnapshot>;
  checkpoint(reservation: ReservationSnapshot): Promise<ContentionCheckpoint>;
  disconnect(sessionId: string): Promise<void>;
  retry(recovery: string): Promise<void>;
};
type Publication = {
  ticket: PublicationTicket;
  at: number;
  result: Awaited<ReturnType<LifecycleCaseInput["backend"]["engine"]["publish"]>>;
  retryDeadline?: number;
  retryPin?: string;
};
export type DisconnectObservation = {
  ended: ReservationEnded[];
  sdkDrains: { request: DrainRequest; result: unknown }[];
  finalAdmissions: {
    ticket: PublicationTicket;
    params: StorageRequestMap["storage/beginWrite"]["params"];
    result: StorageRequestMap["storage/beginWrite"]["result"];
    at: number;
  }[];
  offers: DrainOffer[];
  scope: "host-adapter";
  reservations: ReservationSnapshot[];
  checkpoints: ContentionCheckpoint[];
  staged: {
    reservationId: string;
    sessionId: string;
    checkpoint: string;
    id: string;
    write: string;
    token: string;
    at: number;
  }[];
  retryDrain: { offer: DrainOffer; report: DrainReport; at: number; callbacks: number };
  grantProbes: {
    params: StorageRequestMap["storage/beginWrite"]["params"];
    result: unknown;
    at: number;
    ended: number;
    recordAfter: RecordMeta;
    ticketsBefore: PublicationTicket[];
    ticketsAfter: PublicationTicket[];
  }[];
  retryDispatches: {
    recovery: string;
    action: CoreActionReference;
    at: number;
    wall: number;
    report: DrainReport;
  }[];
  motion: {
    operationId: string;
    sessionId: string;
    atDisconnect: MotionSnapshot;
  };
  requests: { request: DrainRequest; at: number }[];
  reports: DrainReport[];
  publications: Publication[];
  fault: ReturnType<LifecycleCaseInput["fault"]["trace"]>;
  failed: StoredRecovery;
  recovered: StoredRecovery;
  snapshot: ReturnType<LifecycleCaseInput["host"]["recovery"]["snapshot"]>;
  retry: { at: number; wall: number; action: CoreActionReference; report: DrainReport };
  actions: {
    kind: "mint" | "claim";
    action: CoreActionReference;
    target: CoreActionTarget;
    accepted: boolean;
    at: number;
  }[];
  flushes: { at: number; result: PersistenceBarrierEvidence; tickets: PublicationTicket[] }[];
  disconnects: number[];
  events: CaseEvidence["events"];
  providerTrace: ReturnType<FakeProviderControl["trace"]>;
  exits: unknown[];
  ownerBefore: unknown;
  ownerAfter: unknown;
  oldReservationResults: { ok: boolean }[];
  blocked: boolean;
  journalCommits: { at: number; document: unknown }[];
  stops: { at: number; result: Awaited<ReturnType<BuiltinDeviceProvider["stopAndReadback"]>> }[];
  coordinatorCalls: { kind: "disconnect" | "reconcile"; args: unknown[] }[];
};

/** Pure validation is necessary but cannot authenticate a serialized native receipt. */
export function assertDisconnectObservation(o: DisconnectObservation): void {
  assert.equal(o.coordinatorCalls.filter((r) => r.kind === "disconnect").length, 2);
  assert.ok(
    o.coordinatorCalls.some(
      (r) =>
        r.kind === "reconcile" &&
        r.args[0] === o.failed.id &&
        JSON.stringify(r.args[1]) === JSON.stringify(o.retry.report),
    ),
    "Missing original coordinator recovery reconciliation",
  );
  assert.ok(
    o.stops.some(
      (r) =>
        r.result.stopConfirmation === "confirmed" &&
        r.result.error === null &&
        r.result.value?.programStopped === true,
    ),
    "Missing actual provider stop/readback",
  );
  assert.ok(o.journalCommits.length, "Missing actual journal completion");
  for (const step of ["stop", "readback"])
    assert.ok(
      o.providerTrace.some((row) => row.step === step && row.dispatch === "sent"),
      `Missing provider ${step} dispatch`,
    );
  assert.equal(o.blocked, true, "Initial core Disconnect did not block");
  assert.ok(Array.isArray(o.providerTrace), "Missing provider trace interval");
  assert.ok(
    o.reports.some((r) => r.blocker && r.state === "retryable"),
    "Missing actual failed drain report",
  );
  const requestedTargets = new Set(
    o.requests.flatMap(({ request }) => request.writes.map((w) => w.id)),
  );
  assert.equal(
    requestedTargets.size,
    2,
    "OWNER HANDOFF: real prior/current host-held finals must occur in original DrainRequest.writes; checkpoint lists/publication counts cannot substitute",
  );
  assert.equal(o.ended.length, 2);
  assert.equal(o.sdkDrains.length, o.requests.length);
  for (const [index, dispatched] of o.sdkDrains.entries()) {
    const { remainingMs: actual, ...wire } = dispatched.request;
    const { remainingMs: offered, ...original } = o.requests[index]!.request;
    assert.deepEqual(wire, original);
    // The real supervisor subtracts dispatch time and floors its wire budget.
    // It may shorten the offer but must never renew it or change its contents.
    assert.ok(Number.isFinite(actual) && actual > 0 && actual <= offered);
  }
  assert.equal(o.finalAdmissions.length, 2);
  assert.equal(new Set(o.finalAdmissions.map((row) => row.ticket.id)).size, 2);
  for (const admission of o.finalAdmissions) {
    const staged = o.staged.find((row) => row.write === admission.ticket.id)!;
    assert.ok(staged);
    const offer = o.offers.find((row) => row.checkpoints.some((cp) => cp.record.id === staged.id))!;
    assert.ok(offer);
    assert.equal(admission.params.drainToken, offer.token);
    assert.equal(admission.params.target.mode, "replace");
    assert.equal((admission.params.target as { id: string }).id, staged.id);
    assert.deepEqual(admission.params.checkpoint, { handle: staged.checkpoint, phase: "final" });
    assert.equal(admission.result.ok, true);
    if (admission.result.ok) {
      assert.equal(admission.result.value.write, staged.write);
      assert.equal(admission.result.value.id, staged.id);
    }
    assert.deepEqual(admission.ticket.owner, o.ownerBefore);
    assert.equal(admission.ticket.metadata.kind, "record");
    assert.equal(admission.ticket.target.kind, "record");
    if (admission.ticket.target.kind === "record") {
      assert.equal(admission.ticket.target.id, staged.id);
      assert.equal(
        admission.ticket.target.expectedRevision,
        (admission.params.target as { expectedRevision: string }).expectedRevision,
      );
    }
    if (admission.ticket.metadata.kind === "record") {
      const record = admission.ticket.metadata.record;
      assert.equal(record.id, staged.id);
      assert.equal(record.checkpoint, "final");
      for (const key of [
        "kind",
        "schemaVersion",
        "label",
        "mediaType",
        "byteLength",
        "sha256",
      ] as const)
        assert.equal(record[key], admission.params[key]);
    }
    assert.ok(admission.at <= staged.at && staged.at < offer.deadlineMonotonicMs);
    assert.ok(admission.at < o.retry.at);
  }
  assert.equal(new Set(o.ended.map((r) => r.reservationId)).size, 2);
  assert.equal(o.offers.length, 2);
  assert.equal(o.scope, "host-adapter");
  assert.equal(o.reservations.length, 2);
  assert.notEqual(
    o.reservations[0]!.sessionId,
    o.reservations[1]!.sessionId,
    "Prior session was relabelled",
  );
  assert.deepEqual(o.retryDrain.offer, o.offers[0]);
  assert.equal(o.retryDrain.report.state, "saved");
  assert.equal(o.retryDrain.report.blocker, false);
  assert.equal(o.retryDrain.callbacks, 0, "Retry reauthorized SDK callback");
  assert.ok(o.retryDrain.at >= o.retry.at);
  assert.equal(o.staged.length, 2);
  for (const [i, reservation] of o.reservations.entries()) {
    const end = o.ended[i]!,
      cp = o.checkpoints[i]!;
    assert.deepEqual(end.owner, o.ownerBefore);
    assert.ok(end.drain, "Missing original device grant");
    assert.deepEqual(end.drain.owner, end.owner);
    assert.equal(end.drain.reservationId, end.reservationId);
    assert.ok(Number.isFinite(end.drain.expiresMonotonicMs));
    assert.ok(
      o.offers[i]!.deadlineMonotonicMs <= end.drain.expiresMonotonicMs,
      "Offer extended original device grant",
    );
    assert.deepEqual(o.offers[i]!.owner, o.ownerBefore);
    assert.deepEqual(cp.document.binding?.owner, o.ownerBefore);
    assert.equal(cp.document.record.id, cp.record.id);
    assert.equal(end.sessionId, reservation.sessionId);
    assert.equal(end.reservationId, reservation.reservationId);
    assert.equal(cp.document.binding?.sessionId, reservation.sessionId);
    assert.equal(cp.document.binding?.reservationId, reservation.reservationId);
    const staged = o.staged.find((row) => row.reservationId === reservation.reservationId)!;
    assert.ok(staged);
    assert.equal(staged.sessionId, reservation.sessionId);
    assert.equal(staged.id, cp.record.id);
    assert.equal(staged.checkpoint, cp.checkpoint);
    assert.equal(staged.token, o.offers[i]!.token);
    assert.ok(
      o.requests.some(
        ({ request, at }) =>
          at >= staged.at &&
          request.token === staged.token &&
          request.writes.some(
            (w) => w.id === staged.id && w.write === staged.write && w.state === "sealed",
          ) &&
          request.checkpoints.some(
            (c) =>
              c.record.id === staged.id &&
              c.checkpoint === staged.checkpoint &&
              c.reservationEnd?.reservationId === reservation.reservationId,
          ),
      ),
    );
  }
  assert.equal(o.grantProbes.length, 2);
  for (const [i, probe] of o.grantProbes.entries()) {
    assert.ok(
      probe.at >= o.retryDrain.at && probe.ended < o.offers[i]!.deadlineMonotonicMs,
      "Expiry obscures original grant denial",
    );
    assert.equal(probe.params.drainToken, o.offers[i]!.token);
    assert.deepEqual(probe.params.checkpoint, {
      handle: o.checkpoints[i]!.checkpoint,
      phase: "final",
    });
    assert.equal(probe.params.target.mode, "replace");
    assert.equal((probe.params.target as { id: string }).id, o.checkpoints[i]!.record.id);
    assert.equal((probe.result as { ok: boolean }).ok, false);
    assert.equal(
      (probe.result as { error: { code: string } }).error.code,
      "PLUGIN_E_STALE_RESOURCE",
    );
    const publication = o.publications.find(
      (row) =>
        row.ticket.target.kind === "record" &&
        row.ticket.target.id === o.checkpoints[i]!.record.id &&
        row.result.disposition === "committed",
    )!;
    assert.ok(publication && publication.ticket.metadata.kind === "record");
    if (publication.ticket.metadata.kind === "record") {
      assert.deepEqual(probe.recordAfter, publication.ticket.metadata.record);
      for (const key of [
        "kind",
        "schemaVersion",
        "label",
        "mediaType",
        "byteLength",
        "sha256",
      ] as const)
        assert.equal(probe.params[key], publication.ticket.metadata.record[key]);
      assert.equal(
        (probe.params.target as { expectedRevision: string }).expectedRevision,
        publication.ticket.metadata.record.revision,
      );
    }
    assert.deepEqual(probe.ticketsAfter, probe.ticketsBefore, "Denied grant admitted work");
  }
  assert.equal(o.retryDispatches.length, 1);
  assert.deepEqual(o.retryDispatches[0], { recovery: o.failed.id, ...o.retry });
  assert.equal(o.motion.sessionId, o.reservations[1]!.sessionId);
  assert.equal(o.motion.atDisconnect.operationId, o.motion.operationId);
  assert.equal(o.motion.atDisconnect.sessionId, o.motion.sessionId);
  assert.equal(o.motion.atDisconnect.startAccepted, true);
  assert.notEqual(o.motion.atDisconnect.stage, "terminal");
  assert.equal(o.motion.atDisconnect.stopRequested, false);
  for (const offer of o.offers) {
    assert.ok(Number.isFinite(offer.deadlineMonotonicMs));
    assert.ok(o.retry.at < offer.deadlineMonotonicMs, "Retry exceeded original drain deadline");
    assert.ok(
      o.requests.some(({ request }) => request.token === offer.token),
      "Missing SDK dispatch",
    );
  }
  for (const end of o.ended) {
    assert.ok(end.drain, "Missing actual device grant");
    assert.ok(
      o.requests.some(({ request }) =>
        request.checkpoints.some((c) => c.reservationEnd?.reservationId === end.reservationId),
      ),
      "Missing prior/current checkpoint in actual SDK request",
    );
  }
  assert.ok(o.failed.ticket && o.failed.sealedPin && o.failed.expiresAt !== null);
  assert.equal(o.failed.report.blocker, true);
  assert.equal(o.failed.report.state, "retryable");
  assert.ok(o.snapshot.items.some((r) => r.id === o.failed.id && r.state === "retryable"));
  const failedAdmission = o.finalAdmissions.find((row) => row.ticket.id === o.failed.ticket!.id);
  assert.ok(failedAdmission, "Recovery has no original admission");
  assert.deepEqual(o.failed.ticket, failedAdmission.ticket, "Recovery changed admitted ticket");
  assert.equal(o.recovered.id, o.failed.id);
  assert.deepEqual(o.recovered.ticket, o.failed.ticket);
  assert.equal(o.recovered.sealedPin, null, "Saved recovery retained its staging pin");
  assert.ok(
    o.recovered.expiresAt !== null && o.recovered.expiresAt <= o.failed.expiresAt,
    "Recovery TTL renewed",
  );
  assert.ok(o.retry.wall < o.failed.expiresAt);
  assert.equal(o.retry.report.state, "saved");
  assert.equal(o.retry.report.blocker, false);
  assert.equal(o.recovered.report.state, "saved");
  const retryMints = o.actions.filter(
    (r) => r.kind === "mint" && r.target.kind === "persistence-retry",
  );
  assert.equal(retryMints.length, 1);
  assert.deepEqual(retryMints[0]!.action, o.retry.action);
  assert.ok(
    o.actions.some(
      (r) =>
        r.kind === "claim" &&
        r.accepted &&
        r.target.kind === "persistence-retry" &&
        r.target.recovery === o.failed.id &&
        r.action.actionToken === o.retry.action.actionToken,
    ),
  );
  const minted = o.actions.filter((r) => r.kind === "mint");
  assert.equal(minted.length, 3);
  assert.equal(new Set(minted.map((r) => r.action.actionToken)).size, 3, "Reused action");
  const finals = o.publications.filter(
    (r) => r.ticket.metadata.kind === "record" && r.ticket.metadata.record.checkpoint === "final",
  );
  for (const publication of o.publications) {
    const admission = o.finalAdmissions.find((row) => row.ticket.id === publication.ticket.id);
    assert.ok(admission, "Publication has no original admission");
    assert.deepEqual(publication.ticket, admission.ticket, "Publication changed admitted ticket");
    assert.ok(publication.at >= admission.at);
    if (publication.result.disposition === "committed") {
      assert.ok(publication.result.receipt);
      assert.ok(publication.ticket.metadata.kind === "record");
      assert.equal(
        publication.result.receipt.revision,
        publication.ticket.metadata.record.revision,
        "Publication receipt differs from admitted metadata",
      );
    }
  }
  const committed = finals.filter((r) => r.result.disposition === "committed");
  assert.equal(
    new Set(
      committed.map((r) => (r.ticket.target.kind === "record" ? r.ticket.target.id : undefined)),
    ).size,
    2,
  );
  assert.equal(committed.length, 2, "Duplicate final publication");
  assert.ok(
    finals.some(
      (r) => r.ticket.id === o.failed.ticket!.id && r.result.disposition === "not-committed",
    ),
  );
  assert.ok(
    committed.some((r) => r.ticket.id === o.failed.ticket!.id && r.retryDeadline !== undefined),
  );
  for (const publication of finals.filter((row) => row.retryDeadline !== undefined)) {
    assert.equal(publication.retryPin, o.failed.sealedPin);
    assert.ok(publication.retryDeadline! > o.retry.at);
    assert.ok(
      publication.retryDeadline! <= publication.at + 10000,
      "Recovery work budget extended",
    );
    assert.ok(
      publication.retryDeadline! <= publication.at + (o.failed.expiresAt! - o.retry.wall) + 1,
      "Recovery payload TTL extended",
    );
  }
  for (const publication of committed) {
    assert.ok(
      publication.ticket.target.kind === "record" &&
        requestedTargets.has(publication.ticket.target.id),
      "Unrelated final target",
    );
    assert.ok(
      o.fault.some((r) => r.point === "after-publish" && r.ticket === publication.ticket.id),
    );
    assert.ok(
      o.flushes.some(
        (f) =>
          f.result.state === "saved" &&
          f.result.accepted.includes(publication.ticket.id) &&
          f.at >= publication.at &&
          f.at <= o.events.find((row) => row.kind === "save-confirmed")!.time &&
          f.at <= o.disconnects[0]! &&
          f.tickets.some((ticket) => {
            if (ticket.id !== publication.ticket.id) return false;
            assert.deepEqual(ticket, publication.ticket, "Flush changed admitted ticket");
            return true;
          }),
      ),
      "Final ticket lacks successful flush",
    );
  }
  assert.ok(o.fault.some((r) => r.point === "before-publish" && r.ticket === o.failed.ticket!.id));
  assert.equal(o.disconnects.length, 1);
  const time = (kind: string) => {
    const rows = o.events.filter((r) => r.kind === kind);
    assert.ok(rows.length, `Missing ${kind}`);
    assert.ok(rows.every((r) => Number.isFinite(r.time)));
    return rows[0]!.time;
  };
  assert.ok(time("quiesce") <= time("save-failed"));
  assert.ok(time("save-failed") <= time("save-confirmed"));
  for (const kind of ["stop-confirmed", "save-confirmed", "journal-confirmed"]) {
    assert.ok(time("quiesce") <= time(kind));
    assert.ok(time(kind) <= o.disconnects[0]!);
  }
  assert.equal(time("disconnect"), o.disconnects[0]);
  assert.ok(
    o.stops.some((row) => row.at <= time("stop-confirmed")),
    "Stop event has no provider outcome",
  );
  assert.ok(
    o.journalCommits.some((row) => row.at <= time("journal-confirmed")),
    "Journal event has no durable commit",
  );
  assert.equal(o.exits.length, 0);
  assert.deepEqual(o.ownerAfter, o.ownerBefore);
  assert.equal(o.oldReservationResults.length, 2);
  assert.ok(
    o.oldReservationResults.every((r) => !r.ok),
    "Old reservation rights revived",
  );
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Missing disconnect observation (15s)")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Used by the producer itself; all cleanup runs even if an earlier release throws. */
export async function cleanupDisconnect(
  resources: (() => unknown | Promise<unknown>)[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const release of resources.reverse()) {
    try {
      await bounded(Promise.resolve().then(release));
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) throw new Error("Live disconnect operation failed");
  return r.value;
}

export async function produceDisconnectRetry(
  input: DisconnectCaseInput,
): Promise<CaseEvidence & { disconnect: DisconnectObservation }> {
  assert.equal(
    typeof input.disconnect,
    "function",
    "Missing original trusted core Disconnect route",
  );
  assert.equal(input.stage3.persistence, input.host.participant);
  assert.equal(input.stage3.device, input.broker.resources);
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin") throw new Error("Missing original source channel");
  assert.ok(principal.authorityContext);
  const contextRef = principal.authorityContext.ref;
  const owner = structuredClone(principal.owner);
  const resources: (() => unknown | Promise<unknown>)[] = [],
    pending: Promise<unknown>[] = [];
  const events: CaseEvidence["events"] = [],
    offers: DrainOffer[] = [],
    originalOffers: DrainOffer[] = [];
  const sdkDrains: DisconnectObservation["sdkDrains"] = [],
    finalAdmissions: DisconnectObservation["finalAdmissions"] = [];
  const checkpoints: ContentionCheckpoint[] = [],
    staged: DisconnectObservation["staged"] = [],
    retryDispatches: DisconnectObservation["retryDispatches"] = [];
  const ended: ReservationEnded[] = [],
    requests: DisconnectObservation["requests"] = [],
    reports: DrainReport[] = [];
  const publications: Publication[] = [],
    flushes: DisconnectObservation["flushes"] = [],
    actions: DisconnectObservation["actions"] = [];
  const journalCommits: DisconnectObservation["journalCommits"] = [],
    stops: DisconnectObservation["stops"] = [],
    coordinatorCalls: DisconnectObservation["coordinatorCalls"] = [];
  const exits: unknown[] = [],
    disconnects: number[] = [],
    reservations: ReservationSnapshot[] = [];
  const abort = new AbortController();
  let turn = 0,
    queued = false,
    failNextFinal = false,
    held = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstRequest!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    firstRequest = resolve;
  });
  const record = (kind: string, time = input.now()) => {
    events.push({ kind, time, turn });
    if (!queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        turn++;
      });
    }
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.push(work);
    void work.catch(() => {});
    return work;
  };
  let observation: DisconnectObservation | undefined, failure: unknown;
  let motionScope: string | undefined, operationId: string | undefined;
  let pulse: ReturnType<typeof setInterval> | undefined,
    motionBlocked = false;
  const stageFinal = async (offer: DrainOffer) => {
    for (const cp of offer.checkpoints) {
      if (staged.some((row) => row.id === cp.record.id)) continue;
      const reservation = reservations.find(
        (r) => r.reservationId === cp.reservationEnd?.reservationId,
      )!;
      assert.ok(reservation);
      const bytes = Buffer.from(`Synthetic final checkpoint ${cp.record.id}\n`);
      const params: StorageRequestMap["storage/beginWrite"]["params"] = {
        target: { mode: "replace", id: cp.record.id, expectedRevision: cp.record.revision },
        kind: cp.record.kind,
        schemaVersion: cp.record.schemaVersion,
        label: cp.record.label,
        mediaType: cp.record.mediaType,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        checkpoint: { handle: cp.checkpoint, phase: "final" },
        drainToken: offer.token,
      };
      const result: StorageRequestMap["storage/beginWrite"]["result"] = await input.host.request(
        principal,
        "storage/beginWrite",
        params,
        abort.signal,
      );
      const write: { write: string; id: string } = value(result);
      const barrier = input.backend.evidence.capture(
        { kind: "target", owner, recordId: write.id },
        offer.deadlineMonotonicMs,
      );
      const ticket: PublicationTicket | undefined = input.backend.evidence
        .tickets(barrier)
        .find((ticket) => ticket.id === write.write);
      assert.ok(ticket, "Missing actual worker admission");
      finalAdmissions.push({
        ticket: structuredClone(ticket),
        params: structuredClone(params),
        result: structuredClone(result),
        at: input.now(),
      });
      value(
        await input.host.request(
          principal,
          "storage/writeChunk",
          { write: write.write, offset: 0, data: bytes.toString("base64") },
          abort.signal,
        ),
      );
      value(
        await input.host.request(
          principal,
          "storage/sealWrite",
          { write: write.write },
          abort.signal,
        ),
      );
      staged.push({
        reservationId: reservation.reservationId,
        sessionId: reservation.sessionId,
        checkpoint: cp.checkpoint,
        id: write.id,
        write: write.write,
        token: offer.token,
        at: input.now(),
      });
    }
  };
  // Serialize staging across joined offers; the original SDK drain commits the
  // real sealed host payloads named by the original request.writes snapshot.
  let staging: Promise<void> = Promise.resolve();
  try {
    resources.push(input.recording.child.onExit((exit) => exits.push(exit)));
    assert.deepEqual(input.channel.owner, owner);
    const peer = input.channel.peer,
      peerRequest = peer.request;
    peer.request = async function (this: typeof peer, ...args) {
      const row =
        args[0] === "storage/drain"
          ? { request: structuredClone(args[1]) as DrainRequest, result: undefined as unknown }
          : undefined;
      if (row) sdkDrains.push(row);
      try {
        const result = await peerRequest.apply(this, args);
        if (row) row.result = structuredClone(result);
        return result;
      } catch (error) {
        if (row) row.result = { rejected: String(error) };
        throw error;
      }
    } as typeof peerRequest;
    resources.push(() => {
      peer.request = peerRequest;
    });
    const participant = input.host.participant,
      engine = input.backend.engine;
    const end = participant.endReservation;
    participant.endReservation = function (...args) {
      const offer = end.apply(this, args);
      if (args[0].owner.sourceKey === owner.sourceKey) {
        assert.ok(offer);
        ended.push(structuredClone(args[0]));
        offers.push(offer);
        originalOffers.push(structuredClone(offer));
      }
      return offer;
    };
    resources.push(() => {
      participant.endReservation = end;
    });
    const drain = participant.drain;
    participant.drain = function (offer, dispatch) {
      assert.ok(dispatch, "Missing original SDK dispatcher");
      const ready = (staging = staging.then(() => stageFinal(offer)));
      return track(
        ready
          .then(() =>
            drain.call(this, offer, async (...args) => {
              requests.push({ request: structuredClone(args[1]), at: input.now() });
              firstRequest();
              if (held) await gate;
              return dispatch(...args);
            }),
          )
          .then((report) => {
            reports.push(structuredClone(report));
            if (report.blocker) record("save-failed");
            return report;
          }),
      );
    };
    resources.push(() => {
      participant.drain = drain;
    });
    const retry = participant.retry;
    participant.retry = async function (recovery, action) {
      const at = input.now(),
        wall = Date.now();
      const report = await retry.call(this, recovery, action);
      retryDispatches.push({
        recovery,
        action: structuredClone(action),
        at,
        wall,
        report: structuredClone(report),
      });
      return report;
    };
    resources.push(() => {
      participant.retry = retry;
    });
    // The record service captures engine methods at construction. Observe its
    // original host commit route, then read the actual worker ticket outcome;
    // replacing backend.engine.publish now would miss SDK record publications.
    const hostRequest: LifecycleCaseInput["host"]["request"] = input.host.request;
    input.host.request = async function (this: typeof input.host, ...args) {
      const write =
        args[1] === "storage/commitWrite"
          ? (args[2] as StorageRequestMap["storage/commitWrite"]["params"]).write
          : undefined;
      const admission = finalAdmissions.find((row) => row.ticket.id === write);
      if (admission && failNextFinal) {
        failNextFinal = false;
        input.fault.arm("before-publish", "fail");
      }
      const result = await hostRequest.apply(this, args);
      if (admission)
        publications.push({
          ticket: structuredClone(admission.ticket),
          at: input.now(),
          result: structuredClone(await engine.reconcile(admission.ticket)),
        });
      return result;
    } as typeof hostRequest;
    resources.push(() => {
      input.host.request = hostRequest;
    });
    const publishRecovery = engine.publishRecovery;
    assert.ok(publishRecovery, "Missing real worker recovery publication port");
    engine.publishRecovery = async function (ticket, pin, deadline) {
      const result = await publishRecovery.call(this, ticket, pin, deadline);
      publications.push({
        ticket: structuredClone(ticket),
        at: input.now(),
        result: structuredClone(result),
        retryDeadline: deadline,
        retryPin: pin,
      });
      return result;
    };
    resources.push(() => {
      engine.publishRecovery = publishRecovery;
    });
    const flush = input.backend.evidence.flush;
    input.backend.evidence.flush = async function (barrier) {
      const tickets = structuredClone([...this.tickets(barrier)]);
      const result = await flush.call(this, barrier);
      flushes.push({ at: input.now(), result: structuredClone(result), tickets });
      return result;
    };
    resources.push(() => {
      input.backend.evidence.flush = flush;
    });
    const mint = input.actions.mint,
      claim = input.actions.claim;
    input.actions.mint = function (scope, target) {
      const action = mint.call(this, scope, target);
      actions.push({
        kind: "mint",
        action: structuredClone(action),
        target: structuredClone(target),
        accepted: true,
        at: input.now(),
      });
      resources.push(() => input.actions.complete(action));
      return action;
    };
    input.actions.claim = function (action, target) {
      const accepted = claim.call(this, action, target);
      actions.push({
        kind: "claim",
        action: structuredClone(action),
        target: structuredClone(target),
        accepted,
        at: input.now(),
      });
      return accepted;
    };
    resources.push(() => {
      input.actions.mint = mint;
      input.actions.claim = claim;
    });
    const lifecycleDisconnect = input.lifecycle.disconnect,
      reconcile = input.lifecycle.reconcileRecovery;
    input.lifecycle.disconnect = function (...args) {
      coordinatorCalls.push({ kind: "disconnect", args: structuredClone(args) });
      return lifecycleDisconnect.apply(this, args);
    };
    input.lifecycle.reconcileRecovery = function (...args) {
      coordinatorCalls.push({ kind: "reconcile", args: structuredClone(args) });
      return reconcile.apply(this, args);
    };
    resources.push(() => {
      input.lifecycle.disconnect = lifecycleDisconnect;
      input.lifecycle.reconcileRecovery = reconcile;
    });
    const stop = input.provider.stopAndReadback;
    input.provider.stopAndReadback = async function (...args) {
      const result = await stop.apply(this, args);
      stops.push({ at: input.now(), result: structuredClone(result) });
      if (
        result.stopConfirmation === "confirmed" &&
        result.error === null &&
        result.value?.programStopped === true
      )
        record("stop-confirmed");
      return result;
    };
    resources.push(() => {
      input.provider.stopAndReadback = stop;
    });
    const commit = input.journal.commit;
    input.journal.commit = async function (document) {
      await commit.call(this, document);
      journalCommits.push({ at: input.now(), document: structuredClone(document) });
      if (
        document.entries.some(
          (entry) =>
            entry.operationId === operationId &&
            entry.state === "resolved" &&
            entry.stopConfirmation === "confirmed",
        )
      )
        record("journal-confirmed");
    };
    resources.push(() => {
      input.journal.commit = commit;
    });
    const quiesce = input.broker.sessions.quiesce;
    input.broker.sessions.quiesce = function (...args) {
      record("quiesce");
      const receipt = quiesce.apply(this, args);
      track(
        receipt.settled.then((d) => {
          assert.ok(d.stopConfirmed && d.journalCommitted, "Unconfirmed real device disposition");
        }),
      );
      return receipt;
    };
    resources.push(() => {
      input.broker.sessions.quiesce = quiesce;
    });
    const disconnect = input.provider.disconnect;
    input.provider.disconnect = function (...args) {
      const at = input.now();
      disconnects.push(at);
      record("disconnect", at);
      return disconnect.apply(this, args);
    };
    resources.push(() => {
      input.provider.disconnect = disconnect;
    });
    // Release the dispatcher before settling any pending work, including setup failures.
    resources.push(async () => {
      held = false;
      release();
      clearInterval(pulse);
      const cleanupErrors = await cleanupDisconnect([
        () => abort.abort(),
        () => bounded(Promise.allSettled(pending)),
        async () => {
          if (operationId)
            await input.broker.request(
              principal,
              "devices/motion/stop",
              { operationId, stopMode: "brake" },
              abort.signal,
            );
        },
        () => {
          if (motionScope) input.broker.intent.revokeScope(motionScope, "closed");
        },
        () => {
          if (motionBlocked) {
            input.providerControl.release("after-exchange", "motion-pulse");
            motionBlocked = false;
          }
        },
        ...reservations.map(
          (reservation) => () =>
            input.broker.request(
              principal,
              "devices/recording/release",
              { reservationId: reservation.reservationId },
              abort.signal,
            ),
        ),
        () => input.fault.release("before-publish"),
      ]);
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, "Reservation/worker cleanup failed");
    });
    const prior = await bounded(input.reserveRecording());
    reservations.push(prior);
    checkpoints.push(await bounded(input.checkpoint(prior)));
    input.providerControl.lose();
    await bounded(dispatched);
    assert.equal(ended[0]!.reason, "disconnected");
    const current = await bounded(input.reserveRecording());
    reservations.push(current);
    assert.notEqual(current.sessionId, prior.sessionId);
    assert.notEqual(current.reservationId, prior.reservationId);
    checkpoints.push(await bounded(input.checkpoint(current)));
    // Recording and motion are mutually exclusive. End current recording while
    // its final remains held, then admit real safety work on the later session.
    value(
      await input.broker.request(
        principal,
        "devices/recording/release",
        { reservationId: current.reservationId },
        abort.signal,
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await bounded(staging);
    const session = value(
      await input.broker.request(
        principal,
        "devices/session",
        { sessionId: current.sessionId },
        abort.signal,
      ),
    );
    const actuator = session.sources.actuators.find((row) => row.state === "ready");
    assert.ok(actuator);
    motionScope = input.broker.intent.bindMotionScope({
      owner,
      contextRef: contextRef,
      panelInstance: randomUUID(),
      uiResourceGeneration: 0,
      workbenchInstance: input.scope().workbenchInstance,
    });
    let sequence = 0;
    input.broker.intent.pulsePanel(motionScope, ++sequence);
    const gesture = input.broker.intent.beginGesture(motionScope, ++sequence);
    pulse = setInterval(() => {
      input.broker.intent.pulsePanel(motionScope!, ++sequence);
      input.broker.intent.pulseGesture(gesture, ++sequence);
    }, 100);
    operationId = value(
      await input.broker.request(
        principal,
        "devices/motion/prepare",
        {
          sessionId: current.sessionId,
          contextRef: contextRef,
          motionScopeRef: motionScope,
          motion: {
            actuatorId: actuator.actuatorId,
            mode: "timed",
            power: 1,
            direction: 1,
            brake: true,
            durationMs: 5000,
          },
        },
        abort.signal,
      ),
    ).operation.operationId;
    input.providerControl.block("after-exchange", "motion-pulse");
    motionBlocked = true;
    const reached = input.providerControl.reached("after-exchange", "motion-pulse");
    value(
      await input.broker.request(principal, "devices/motion/start", { operationId }, abort.signal),
    );
    await bounded(reached);
    const motion = {
      operationId,
      sessionId: current.sessionId,
      atDisconnect: value(
        await input.broker.request(
          principal,
          "devices/motion/query",
          { operationId },
          abort.signal,
        ),
      ).operation,
    };
    failNextFinal = true;
    const first = track(input.disconnect(current.sessionId));
    clearInterval(pulse);
    pulse = undefined;
    input.providerControl.release("after-exchange", "motion-pulse");
    motionBlocked = false;
    assert.ok(events.some((e) => e.kind === "quiesce"));
    held = false;
    release();
    let blocked = false;
    try {
      await bounded(first);
    } catch {
      blocked = true;
    }
    assert.equal(blocked, true);
    assert.equal(disconnects.length, 0, "Physical disconnect before successful final save");
    await bounded(Promise.allSettled(pending));
    assert.equal(failNextFinal, false, "Fault was never injected");
    const snapshot = input.host.recovery.snapshot();
    const retryable = snapshot.items.filter(
      (r) => r.sourceKey === owner.sourceKey && r.state === "retryable",
    );
    assert.equal(
      retryable.length,
      1,
      `Expected one real failed final: ${JSON.stringify({ snapshot, reports, sdkDrains, publications })}`,
    );
    const id = retryable[0]!.id;
    const failed = await input.backend.evidence.loadRecovery(id);
    assert.ok(failed?.ticket && failed.sealedPin && failed.expiresAt !== null);
    assert.ok(Date.now() < failed.expiresAt);
    assert.ok(originalOffers.every((o) => input.now() < o.deadlineMonotonicMs));
    await bounded(input.retry(id));
    assert.equal(retryDispatches.length, 1);
    const { action, at, wall, report } = retryDispatches[0]!;
    // The host adapter reconciles the actual trusted Retry result before a
    // separate explicit Disconnect. Observation hooks themselves only forward.
    input.lifecycle.reconcileRecovery(id, report);
    assert.equal(report.state, "saved", "Core Retry did not save the original final");
    assert.equal(report.blocker, false);
    const recovered = await input.backend.evidence.loadRecovery(id);
    assert.ok(recovered);
    const barrier = input.backend.evidence.capture(
      { kind: "namespace", owner },
      Math.min(...originalOffers.map((o) => o.deadlineMonotonicMs)),
    );
    assert.equal((await input.backend.evidence.flush(barrier)).state, "saved");
    record("save-confirmed");
    assert.equal(disconnects.length, 0, "Retry auto-disconnected");
    // Reconcile through the original offer, with no renewed grant or dispatcher.
    let retryCallbacks = 0;
    const retryDrainAt = input.now();
    const retryReport = await bounded(
      drain.call(participant, offers[0]!, async () => {
        retryCallbacks++;
        throw new Error("Retry must not authorize another SDK drain callback");
      }),
    );
    const retryDrain = {
      offer: structuredClone(offers[0]!),
      at: retryDrainAt,
      report: retryReport,
      callbacks: retryCallbacks,
    };
    const grantProbes: DisconnectObservation["grantProbes"] = [];
    for (const [i, cp] of checkpoints.entries()) {
      const final = value(
        await input.host.request(principal, "storage/stat", { id: cp.record.id }, abort.signal),
      ).record;
      const params = {
        target: { mode: "replace" as const, id: final.id, expectedRevision: final.revision },
        kind: final.kind,
        schemaVersion: final.schemaVersion,
        label: final.label,
        mediaType: final.mediaType,
        byteLength: final.byteLength,
        sha256: final.sha256,
        checkpoint: { handle: cp.checkpoint, phase: "final" as const },
        drainToken: originalOffers[i]!.token,
      };
      const tickets = () =>
        structuredClone([
          ...input.backend.evidence.tickets(
            input.backend.evidence.capture(
              { kind: "namespace", owner },
              originalOffers[i]!.deadlineMonotonicMs,
            ),
          ),
        ]);
      const ticketsBefore = tickets(),
        at = input.now();
      const result = await input.host.request(
        principal,
        "storage/beginWrite",
        params,
        abort.signal,
      );
      grantProbes.push({
        params,
        result,
        at,
        ended: input.now(),
        ticketsBefore,
        ticketsAfter: tickets(),
        recordAfter: value(
          await input.host.request(principal, "storage/stat", { id: cp.record.id }, abort.signal),
        ).record,
      });
      if (result.ok)
        value(
          await input.host.request(
            principal,
            "storage/abortWrite",
            { write: result.value.write },
            abort.signal,
          ),
        );
    }
    await bounded(input.disconnect(current.sessionId));
    const oldReservationResults = [];
    for (const reservation of reservations)
      oldReservationResults.push({
        ok: input.broker.reservations.validate(owner, reservation.reservationId) !== null,
      });
    const after = input.recording.principal();
    assert.equal(after.kind, "plugin");
    observation = {
      ended,
      sdkDrains,
      finalAdmissions,
      offers: originalOffers,
      scope: "host-adapter",
      reservations,
      checkpoints,
      staged,
      retryDrain,
      grantProbes,
      retryDispatches,
      motion,
      requests,
      reports,
      publications,
      fault: input.fault.trace(),
      failed,
      recovered,
      snapshot,
      retry: { at, wall, action, report },
      actions,
      flushes,
      disconnects,
      events,
      providerTrace: input.providerControl.trace(),
      exits,
      ownerBefore: owner,
      ownerAfter: after.kind === "plugin" ? after.owner : null,
      oldReservationResults,
      blocked,
      journalCommits,
      stops,
      coordinatorCalls,
    };
    assertDisconnectObservation(observation);
  } catch (error) {
    failure = error;
  }
  const errors = await cleanupDisconnect(resources);
  if (errors.length)
    throw new AggregateError(
      failure ? [failure, ...errors] : errors,
      "Disconnect producer cleanup failed",
    );
  if (failure) throw failure;
  assert.ok(observation);
  assertDisconnectObservation(observation);
  const committed = observation.publications.filter(
    (r) =>
      r.ticket.metadata.kind === "record" &&
      r.ticket.metadata.record.checkpoint === "final" &&
      r.result.disposition === "committed",
  );
  return {
    disconnect: observation,
    events,
    samples: {},
    checks: {
      disconnectsBeforeSaved: disconnects.filter(
        (at) => at < events.find((r) => r.kind === "save-confirmed")!.time,
      ).length,
      failedSaveBlocker: observation.failed.report.blocker,
      retriesWithFreshAction: actions.filter(
        (r) => r.kind === "claim" && r.target.kind === "persistence-retry" && r.accepted,
      ).length,
      finalTargets: new Set(
        requests.flatMap(({ request }) => request.writes.map((write) => write.id)),
      ).size,
      finalPublications: committed.length,
      priorSessionIncluded:
        reservations[0]!.sessionId !== reservations[1]!.sessionId &&
        requests.some(({ request }) =>
          request.writes.some(
            (w) =>
              w.id === checkpoints[0]!.record.id &&
              w.write ===
                staged.find((row) => row.reservationId === reservations[0]!.reservationId)!.write,
          ),
        ),
      firstDeadline: originalOffers[0]!.deadlineMonotonicMs,
      lastDeadline: observation.retryDrain.offer.deadlineMonotonicMs,
    },
  };
}
