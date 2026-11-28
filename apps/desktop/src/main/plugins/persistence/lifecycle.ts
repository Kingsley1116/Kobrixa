import { isDeepStrictEqual } from "node:util";
import { wallExpiry as projectWallExpiry } from "./wall-expiry.js";
import type { FinalWriteGrant } from "./engine-port.js";
import { checkpointRecoveryId } from "./engine-port.js";
import { randomUUID } from "node:crypto";
import type {
  DrainReason,
  DrainRequest,
  RecordMeta,
  RecordWrite,
  ResourceOwner,
  StorageRequestMap,
} from "@kobrixa/plugin-protocol";
import type {
  DeviceDrainGrant,
  DrainDispatcher,
  DrainOffer,
  DrainReport,
  PersistenceParticipant,
  ReservationBinding,
  ReservationBindingPort,
  ReservationEnded,
} from "@kobrixa/plugin-runtime";
import { ownerKey, PersistenceFault, conflict, limit, stale } from "./record-port.js";
import type {
  PersistenceEvidencePort,
  PersistenceReadPort,
  PersistenceBarrier,
  StampedBarrierEvidence,
  PublicationTicket,
  PersistenceScope,
} from "./engine-port.js";
export type LifecycleDependencies = {
  now(): number;
  wall(): number;
  live(owner: ResourceOwner): boolean;
  reservations: ReservationBindingPort;
  record(owner: ResourceOwner, id: string): Promise<RecordMeta>;
  persist(
    owner: ResourceOwner,
    input: {
      checkpoint: string;
      record: RecordMeta;
      binding?: ReservationBinding;
      state: "open" | "final" | "interrupted";
    },
  ): Promise<void>;
  fence(owner: ResourceOwner, deadline: number): readonly string[];
  fenceTarget(owner: ResourceOwner, id: string, deadline: number): readonly string[];
  pendingWrites(owner: ResourceOwner): DrainRequest["writes"];
  pendingPublication(owner: ResourceOwner): boolean;
  pendingSettings(owner: ResourceOwner): boolean;
  hasDiscardedProjection?(owner: ResourceOwner): boolean;
  settle(tickets: readonly string[], deadline: number, owner: ResourceOwner): Promise<void>;
  evidence: PersistenceEvidencePort;
  reads: Pick<PersistenceReadPort, "stat">;
  payload(
    owner: ResourceOwner,
    id: string,
  ): { kind: "complete-staging" | "checkpoint-only" | "none"; expiresMonotonicMs?: number };
  recover(
    owner: ResourceOwner,
    report: DrainReport,
    current: () => boolean,
    unresolved: ReadonlySet<string>,
    restartBlocker?: string,
    ownerRecovery?: string,
  ): Promise<DrainReport>;
  checkpointOpen(owner: ResourceOwner, id: string): boolean;
  recovery: Pick<PersistenceParticipant, "recoverySnapshot" | "retry" | "discard"> & {
    reserveIdentity?(
      owner: ResourceOwner,
      id: string,
      kind: "owner" | "checkpoint" | "ticket",
    ): void;
    releaseIdentity?(owner: ResourceOwner, id: string): void;
    releaseOwner?(owner: ResourceOwner): void;
    blocked?(owner: ResourceOwner, targets?: ReadonlySet<string>): boolean;
  };
};
type Entry = {
  owner: ResourceOwner;
  id: string;
  handle: string;
  reservation?: string;
  binding?: ReservationBinding;
  record?: RecordMeta;
  ready: Promise<void>;
  ended?: ReservationEnded;
  final: boolean;
  failed: boolean;
  terminalAt?: number;
};
type Capture = {
  barrier: PersistenceBarrier;
  members: readonly PublicationTicket[];
  deadline: number;
  submission: "captured" | "in-flight" | "rejected" | "returned";
  timedOut?: boolean;
  discharged?: boolean;
  deadlineBeforeLoss?: number;
  result?: StampedBarrierEvidence;
  original: boolean;
  closingCut: boolean;
  unpublished?: Set<string>;
};
function timely(row: Capture): row is Capture & { result: StampedBarrierEvidence } {
  const stamp = row.result?.completedMonotonicMs;
  return (
    !row.timedOut &&
    stamp !== undefined &&
    Number.isFinite(stamp) &&
    stamp >= 0 &&
    stamp < row.deadline
  );
}
type RecheckObligations = {
  members: Map<
    string,
    { unknown: boolean; incomplete: boolean; unpublished: boolean; latestCompletion: number }
  >;
  latestEmptyCompletion: number;
  anonymousFailure: boolean;
  awaitingRead: boolean;
  restartBlocker?: string;
};
type OwnerEvidence = {
  rechecks: Map<string | undefined, RecheckObligations>;
  recoveryId: string;
  history: Capture[];
  tickets: Map<string, PublicationTicket>;
  resolvedTickets: Set<string>;
  discardedRecords: Map<string, string>;
  saturated: boolean;
};
type Group = {
  owner: ResourceOwner;
  reason: DrainReason;
  token: string;
  deadline: number;
  entries: Set<Entry>;
  targets: Set<string>;
  proof: OwnerEvidence;
  tickets: Set<string>;
  sent: Set<string>;
  retired: boolean;
  grant?: DeviceDrainGrant;
  run?: Promise<DrainReport>;
  completed?: DrainReport;
  completedAt?: number;
  revision: number;
  control: AbortController;
  retaining?: () => boolean;
  waiters: Set<() => void>;
  rearm?: () => void;
  lossRead?: { at: number; budget: { readonly deadline: number } };
  callbackAllowed: boolean;
  barriers: Capture[];
  observing: Capture[];
};
export function createPersistenceLifecycle(deps: LifecycleDependencies) {
  const entries = new Map<string, Entry>();
  const owners = new Map<string, { source: string; proof: OwnerEvidence }>();
  const groups = new Map<string, Group>();
  // Revocation identities are never TTL-evicted. Saturation closes new admission;
  // terminal payload/projection caches can expire without reviving a generation.
  const retired = new Set<string>();
  let retirementSaturated = false;
  const hostLimit = 1024,
    sourceLimit = 64,
    retention = 120000;
  function sweep() {
    const now = deps.now();
    for (const [id, value] of groups)
      if (
        !value.run &&
        value.completed &&
        !value.completed.blocker &&
        (value.retired ||
          (!mine(value.owner).length &&
            value.proof.history.every(
              (row) =>
                row.discharged && row.result && row.result.completedMonotonicMs < row.deadline,
            ))) &&
        !deps.recovery.blocked?.(value.owner) &&
        !deps.hasDiscardedProjection?.(value.owner) &&
        value.completedAt !== undefined &&
        now >= value.completedAt + retention
      ) {
        for (const row of value.proof.history) deps.evidence.releaseProof?.(row.barrier);
        groups.delete(id);
        owners.delete(id);
        deps.recovery.releaseOwner?.(value.owner);
      }
    for (const [id, entry] of entries)
      if (
        entry.final &&
        !entry.failed &&
        entry.terminalAt !== undefined &&
        now >= entry.terminalAt + retention &&
        !groups.get(ownerKey(entry.owner))?.run
      ) {
        entries.delete(id);
        deps.recovery.releaseIdentity?.(entry.owner, checkpointRecoveryId(entry.handle));
      }
  }
  function retire(owner: ResourceOwner) {
    if (retired.has(ownerKey(owner))) return;
    if (retired.size >= hostLimit) retirementSaturated = true;
    else retired.add(ownerKey(owner));
  }
  function shorten(value: Group, deadline: number) {
    if (deadline >= value.deadline) return;
    value.deadline = deadline;
    for (const row of [...value.proof.history, ...value.observing])
      row.deadline = Math.min(row.deadline, deadline);
    for (const recheck of value.proof.rechecks.values()) {
      if (recheck.latestEmptyCompletion >= deadline) {
        recheck.anonymousFailure = true;
        delete value.completed;
      }
      for (const member of recheck.members.values()) {
        if (member.latestCompletion >= deadline) {
          member.unknown = true;
          member.unpublished = false;
          delete value.completed;
        }
      }
    }
    if (
      value.completed &&
      value.proof.history.some(
        (row) => row.result && row.result.completedMonotonicMs >= row.deadline,
      )
    )
      delete value.completed;
    // Main's fence updates the same shared gates observed at worker publication.
    if (value.retired) {
      for (const ticket of deps.fence(value.owner, deadline)) value.tickets.add(ticket);
    } else
      for (const entry of value.entries)
        for (const ticket of deps.fenceTarget(value.owner, entry.id, deadline))
          value.tickets.add(ticket);
    value.rearm?.();
    for (const rearm of value.waiters) rearm();
  }
  function include(value: Group, entry: Entry) {
    if (!value.entries.has(entry)) {
      if (
        value.entries.size >= sourceLimit ||
        new Set([...value.targets, ...value.proof.discardedRecords.keys(), entry.id]).size >
          sourceLimit
      ) {
        deps.fenceTarget(value.owner, entry.id, deps.now());
        limit();
      }
      value.entries.add(entry);
      value.targets.add(entry.id);
      value.proof.discardedRecords.delete(entry.id);
      value.revision++;
      delete value.completed;
    }
  }
  const key = (owner: ResourceOwner, id: string) => JSON.stringify([ownerKey(owner), id]);
  const mine = (owner: ResourceOwner) =>
    [...entries.values()].filter(
      (entry) => ownerKey(entry.owner) === ownerKey(owner) && !entry.final,
    );
  function group(owner: ResourceOwner, reason: DrainReason, deadline: number) {
    sweep();
    const identity = ownerKey(owner);
    let value = groups.get(identity);
    let ownerRecord = owners.get(identity);
    if (!ownerRecord) {
      if (
        owners.size >= hostLimit ||
        [...owners.values()].filter((r) => r.source === owner.sourceKey).length >= sourceLimit
      ) {
        deps.fence(owner, deps.now());
        limit();
      }
      const recoveryId = randomUUID();
      deps.recovery.reserveIdentity?.(owner, recoveryId, "owner");
      ownerRecord = {
        source: owner.sourceKey,
        proof: {
          recoveryId,
          history: [],
          rechecks: new Map(),
          tickets: new Map(),
          resolvedTickets: new Set(),
          discardedRecords: new Map(),
          saturated: false,
        },
      };
      owners.set(identity, ownerRecord);
    }
    if (value && !value.retired && !value.run && [...value.entries].every((e) => e.final)) {
      groups.delete(identity);
      value = undefined;
    }
    if (!value) {
      if (
        groups.size >= hostLimit ||
        [...groups.values()].filter((g) => g.owner.sourceKey === owner.sourceKey).length >=
          sourceLimit
      ) {
        deps.fence(owner, deps.now());
        limit();
      }
      value = {
        owner: Object.freeze({ ...owner }),
        reason,
        token: randomUUID(),
        deadline: Math.min(deadline, deps.now() + 10000),
        entries: new Set(),
        targets: new Set(),
        proof: ownerRecord.proof,
        tickets: new Set(),
        sent: new Set(),
        retired: false,
        waiters: new Set(),
        control: new AbortController(),
        callbackAllowed: true,
        barriers: [],
        observing: [],
        revision: 0,
      };
      groups.set(identity, value);
    }
    shorten(value, deadline);
    return value;
  }
  function capture(
    value: Group,
    scope: PersistenceScope,
    original: boolean,
    deadline = value.deadline,
  ) {
    const firstClosingCut =
      !original &&
      !value.proof.history.some(
        (r) => r.closingCut && JSON.stringify(r.barrier.scope) === JSON.stringify(scope),
      );
    if ((original || firstClosingCut) && value.proof.history.length >= hostLimit) {
      value.proof.saturated = true;
      limit();
    }
    const barrier = deps.evidence.capture(scope, deadline);
    let members: PublicationTicket[];
    try {
      members = deps.evidence.tickets(barrier).map((ticket) => {
        const existing = value.proof.tickets.get(ticket.id);
        if (existing) {
          if (!isDeepStrictEqual(existing, ticket)) {
            value.proof.saturated = true;
            stale();
          }
          return existing;
        }
        if (value.proof.tickets.size >= hostLimit) {
          value.proof.saturated = true;
          limit();
        }
        deps.recovery.reserveIdentity?.(value.owner, ticket.id, "ticket");
        const copy = structuredClone(ticket);
        value.proof.tickets.set(ticket.id, copy);
        return copy;
      });
    } catch (error) {
      deps.evidence.releaseProof?.(barrier);
      throw error;
    }
    const row: Capture = {
      barrier,
      members,
      original: original || firstClosingCut,
      closingCut: firstClosingCut,
      submission: "captured",
      deadline,
    };
    if (row.original) value.proof.history.push(row);
    else deps.evidence.releaseProof?.(barrier);
    for (const ticket of members) value.tickets.add(ticket.id);
    return row;
  }
  function snapshot(value: Group): DrainOffer {
    return Object.freeze({
      owner: value.owner,
      reason: value.reason,
      token: value.token,
      deadlineMonotonicMs: value.deadline,
      checkpoints: Object.freeze(
        [...value.entries]
          .filter((e) => e.record && !e.final)
          .map((e) => ({
            checkpoint: e.handle,
            record: structuredClone(e.record!),
            ...(e.ended
              ? {
                  reservationEnd: {
                    reservationId: e.ended.reservationId,
                    reason: e.ended.reason,
                    lastSequence: e.ended.lastSequence,
                  },
                }
              : {}),
          })),
      ),
      writes: Object.freeze(
        deps
          .pendingWrites(value.owner)
          .filter(
            (write) => value.retired || [...value.entries].some((entry) => entry.id === write.id),
          ),
      ),
      acceptedTickets: Object.freeze([...value.tickets]),
    });
  }
  async function register(
    owner: ResourceOwner,
    input: StorageRequestMap["storage/registerCheckpoint"]["params"],
  ): Promise<StorageRequestMap["storage/registerCheckpoint"]["result"]> {
    sweep();
    if (retirementSaturated || !deps.live(owner) || retired.has(ownerKey(owner)))
      return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
    if (
      entries.size >= hostLimit ||
      [...entries.values()].filter((e) => e.owner.sourceKey === owner.sourceKey).length >=
        sourceLimit
    )
      return new PersistenceFault("PLUGIN_E_RESOURCE_LIMIT").result;
    if (
      [...entries.values()].filter(
        (entry) => entry.owner.sourceKey === owner.sourceKey && !entry.final,
      ).length >= 2
    )
      return new PersistenceFault("PLUGIN_E_RESOURCE_LIMIT").result;
    if (entries.has(key(owner, input.id)))
      return new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", "write-in-progress").result;
    const binding = input.reservation ? deps.reservations.validate(owner, input.reservation) : null;
    if (input.reservation && !binding)
      return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
    let resolve!: () => void;
    const entry: Entry = {
      owner: { ...owner },
      id: input.id,
      handle: randomUUID(),
      ...(input.reservation ? { reservation: input.reservation } : {}),
      ...(binding ? { binding: structuredClone(binding) } : {}),
      ready: new Promise<void>((done) => {
        resolve = done;
      }),
      final: false,
      failed: false,
    };
    try {
      deps.recovery.reserveIdentity?.(owner, checkpointRecoveryId(entry.handle), "checkpoint");
    } catch (error) {
      if (error instanceof PersistenceFault) return error.result;
      throw error;
    }
    entries.set(key(owner, input.id), entry);
    groups.get(ownerKey(owner))?.proof.discardedRecords.delete(input.id);
    try {
      const record = await deps.record(owner, input.id);
      entry.record = record;
      if (record.revision !== input.expectedRevision) conflict("revision-mismatch");
      if (record.checkpoint === "final" || record.interrupted) conflict("write-in-progress");
      await deps.persist(owner, {
        checkpoint: entry.handle,
        record,
        ...(binding ? { binding: structuredClone(binding) } : {}),
        state: "open",
      });
      if (
        entry.ended ||
        retired.has(ownerKey(owner)) ||
        !deps.live(owner) ||
        (input.reservation && !deps.reservations.validate(owner, input.reservation))
      )
        stale();
      return { ok: true, value: { checkpoint: entry.handle } };
    } catch (error) {
      if (!entry.ended && !retired.has(ownerKey(owner))) {
        entry.failed = true;
        entries.delete(key(owner, input.id));
        deps.recovery.releaseIdentity?.(owner, checkpointRecoveryId(entry.handle));
      }
      return error instanceof PersistenceFault
        ? error.result
        : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result;
    } finally {
      resolve();
    }
  }
  function authorize(
    owner: ResourceOwner,
    input: RecordWrite,
    token = input.drainToken,
  ): RecordMeta["checkpoint"] {
    const value = groups.get(ownerKey(owner));
    const target =
      input.target.mode === "replace" ? entries.get(key(owner, input.target.id)) : undefined;
    if (token) {
      if (
        !value ||
        value.token !== token ||
        !value.callbackAllowed ||
        value.control.signal.aborted ||
        deps.now() >= value.deadline ||
        input.target.mode !== "replace" ||
        !target ||
        !value.entries.has(target) ||
        target.failed ||
        target.final ||
        target.ended?.drain === null ||
        !input.checkpoint ||
        input.checkpoint.handle !== target.handle ||
        input.checkpoint.phase !== "final"
      )
        stale();
      return "final";
    }
    if (
      retirementSaturated ||
      retired.has(ownerKey(owner)) ||
      !deps.live(owner) ||
      (target && value?.entries.has(target))
    )
      stale();
    if (input.checkpoint) {
      if (!target || target.handle !== input.checkpoint.handle || target.final || target.failed)
        stale();
      if (
        input.checkpoint.phase === "final" &&
        target.reservation &&
        deps.reservations.validate(owner, target.reservation)
      )
        conflict("write-in-progress");
      return input.checkpoint.phase === "final" ? "final" : "open";
    }
    if (target) conflict("write-in-progress");
    return "none";
  }
  async function bounded<T>(
    value: Pick<Group, "deadline"> & Partial<Pick<Group, "waiters">>,
    action: Promise<T>,
    fallback: T,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rearm: (() => void) | undefined;
    try {
      return await Promise.race([
        action.catch(() => fallback),
        new Promise<T>((resolve) => {
          rearm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => resolve(fallback), Math.max(0, value.deadline - deps.now()));
          };
          value.waiters?.add(rearm);
          rearm();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (rearm) value.waiters?.delete(rearm);
    }
  }
  function readBudget(value: Group, deadline: number) {
    const originalGrant = value.deadline;
    return {
      waiters: value.waiters,
      get deadline() {
        return value.deadline < originalGrant ? Math.min(value.deadline, deadline) : deadline;
      },
    };
  }
  async function report(
    value: Group,
    deadline = value.deadline,
    coreRefresh = false,
    budget = coreRefresh || value.lossRead !== undefined ? readBudget(value, deadline) : value,
  ): Promise<DrainReport> {
    // This snapshot spans all reads/flushes and the recovery write, not just the
    // cached return. Core actions invalidate it on admission and on completion.
    const revision = value.revision;
    const current = () =>
      groups.get(ownerKey(value.owner)) === value && value.revision === revision;
    const records: DrainReport["records"] = [];
    let uncertain = false;
    for (const entry of value.entries) {
      if (entry.failed) {
        uncertain = true;
        continue;
      }
      const evidence = await bounded<RecordMeta | undefined>(
        budget,
        Promise.resolve().then(() => deps.reads.stat(value.owner, entry.id)),
        undefined,
      );
      if (!evidence) uncertain = true;
      const final = evidence?.checkpoint === "final";
      entry.final ||= final;
      if (final) entry.terminalAt ??= deps.now();
      const held = deps.payload(value.owner, entry.id);
      const complete =
        held.kind === "complete-staging" &&
        held.expiresMonotonicMs !== undefined &&
        deps.now() < held.expiresMonotonicMs;
      records.push({
        id: entry.id,
        committedRevision: evidence?.revision ?? null,
        final,
        payload: complete ? "complete-staging" : evidence ? "checkpoint-only" : "none",
        ...(complete ? { expiresAt: projectWallExpiry(deps, held.expiresMonotonicMs!) } : {}),
      });
    }
    if (value.retired)
      for (const write of deps.pendingWrites(value.owner)) {
        if (records.some((r) => r.id === write.id)) continue;
        const evidence = await bounded<RecordMeta | undefined>(
          budget,
          Promise.resolve().then(() => deps.reads.stat(value.owner, write.id)),
          undefined,
        );
        const held = deps.payload(value.owner, write.id);
        const complete =
          held.kind === "complete-staging" &&
          held.expiresMonotonicMs !== undefined &&
          deps.now() < held.expiresMonotonicMs;
        records.push({
          id: write.id,
          committedRevision: evidence?.revision ?? null,
          final: false,
          payload: complete ? "complete-staging" : evidence ? "checkpoint-only" : "none",
          ...(complete ? { expiresAt: projectWallExpiry(deps, held.expiresMonotonicMs!) } : {}),
        });
      }
    const pendingSettings = value.retired && deps.pendingSettings(value.owner);
    // Capture final grant-scoped submissions synchronously before awaiting any flush.
    const scopes: PersistenceScope[] = value.retired
      ? [{ kind: "namespace", owner: value.owner }]
      : [...value.targets].map((id) => ({
          kind: "target",
          owner: value.owner,
          recordId: id,
        }));
    if (value.proof.saturated) return unavailable();
    const submitted = [
      ...value.barriers.splice(0),
      ...scopes.map((scope) =>
        capture(value, scope, false, coreRefresh ? budget.deadline : value.deadline),
      ),
    ];
    value.observing = submitted;
    await Promise.all(
      submitted.map(async (row) => {
        // Each capture owns its one completion, even when another flush rejects or this view is superseded.
        const lossAtSubmission = value.lossRead;
        row.submission = "in-flight";
        const flush = deps.evidence.flush(row.barrier);
        // Record delivery independently of this observer. A timeout is permanent
        // for the original attempt even if the worker subsequently returns.
        const delivered = flush.then(
          (result) => {
            row.submission = "returned";
            row.result = result;
            return true;
          },
          () => {
            row.submission = "rejected";
            return true;
          },
        );
        if (!(await bounded(budget, delivered, false))) {
          row.timedOut = true;
          return;
        }
        for (const id of row.result?.unknown ?? []) {
          const ticket = row.members.find((t) => t.id === id);
          if (ticket?.metadata.kind !== "record") continue;
          const idOfRecord = ticket.metadata.record.id;
          const head = await bounded(
            budget,
            Promise.resolve().then(() => deps.reads.stat(value.owner, idOfRecord)),
            undefined,
          );
          if (
            head &&
            head.revision ===
              (ticket.target.kind === "record" ? ticket.target.expectedRevision : null)
          )
            (row.unpublished ??= new Set()).add(id);
        }
        if (
          !coreRefresh &&
          value.lossRead !== undefined &&
          row.result &&
          (lossAtSubmission !== undefined ||
            row.result.completedMonotonicMs > value.lossRead.at ||
            (row.result.completedMonotonicMs === value.lossRead.at &&
              row.deadlineBeforeLoss !== undefined &&
              row.result.completedMonotonicMs < row.deadlineBeforeLoss))
        )
          row.deadline = value.lossRead.budget.deadline;
      }),
    );
    const unresolved = new Set<string>();
    let restartBlocker: string | undefined;
    const remember = (
      summary: RecheckObligations,
      id: string,
      outcome: "unknown" | "incomplete" | "accepted",
      completion = -Infinity,
      unpublished = false,
    ) => {
      if (value.proof.resolvedTickets.has(id)) return;
      const prior = summary.members.get(id);
      if (!prior && summary.members.size >= hostLimit) {
        value.proof.saturated = true;
        return;
      }
      summary.members.set(id, {
        unknown: !!prior?.unknown || outcome === "unknown",
        incomplete: !!prior?.incomplete || outcome === "incomplete",
        latestCompletion: Math.max(prior?.latestCompletion ?? -Infinity, completion),
        unpublished:
          (!prior?.unknown || prior.unpublished) && (outcome !== "unknown" || unpublished),
      });
    };
    const corroborated = (id: string) => {
      const metadata = value.proof.tickets.get(id)?.metadata;
      if (metadata?.kind !== "record") return false;
      return (
        records.some(
          (r) => r.id === metadata.record.id && r.committedRevision === metadata.record.revision,
        ) &&
        submitted.some(
          (fresh) =>
            timely(fresh) &&
            fresh.result.state === "saved" &&
            fresh.members.some((t) => t.id === id) &&
            fresh.result.accepted.includes(id),
        )
      );
    };
    const discarded = async (id: string) => {
      const revision = value.proof.discardedRecords.get(id);
      if (!revision || entries.has(key(value.owner, id))) return false;
      const head = await bounded(budget, deps.reads.stat(value.owner, id), undefined);
      return head?.revision === revision && !entries.has(key(value.owner, id));
    };
    let flushed = true;
    for (const row of [...value.proof.history, ...submitted.filter((r) => !r.original)]) {
      if (
        !value.retired &&
        row.barrier.scope.kind === "target" &&
        !value.targets.has(row.barrier.scope.recordId)
      )
        continue;
      const scopeId = row.barrier.scope.kind === "target" ? row.barrier.scope.recordId : undefined;
      let summary: RecheckObligations | undefined;
      if (!row.original) {
        summary = value.proof.rechecks.get(scopeId) ?? {
          members: new Map(),
          latestEmptyCompletion: -Infinity,
          anonymousFailure: false,
          awaitingRead: false,
        };
        value.proof.rechecks.set(scopeId, summary);
      }
      if (!timely(row)) {
        if (summary) {
          if (!row.members.length) summary.awaitingRead = true;
          for (const ticket of row.members) remember(summary, ticket.id, "unknown");
        }
        // A durable disposition covers the exact known members. A fresh
        // successful scoped read must independently settle namespace work.
        row.discharged =
          !submitted.includes(row) &&
          row.members.length > 0 &&
          row.members.every((ticket) => value.proof.resolvedTickets.has(ticket.id)) &&
          submitted.some(
            (fresh) =>
              isDeepStrictEqual(fresh.barrier.scope, row.barrier.scope) &&
              timely(fresh) &&
              fresh.result.state === "saved",
          );
        flushed &&= row.discharged;
        continue;
      }
      const result = row.result;
      const incomplete = [];
      for (const id of result.incomplete) {
        if (value.proof.resolvedTickets.has(id)) continue;
        if (await discarded(id)) continue;
        incomplete.push(id);
      }
      const unknown = result.unknown.filter((id) => {
        if (value.proof.resolvedTickets.has(id)) return false;
        return submitted.includes(row) || !row.unpublished?.has(id) || !corroborated(id);
      });
      const covered = row.members.every(
        (t) =>
          result.accepted.includes(t.id) ||
          (result.unknown.includes(t.id) && !unknown.includes(t.id)) ||
          value.proof.resolvedTickets.has(t.id),
      );
      const resolved =
        (result.unknown.length || result.incomplete.length) &&
        !unknown.length &&
        !incomplete.length;
      row.discharged = !!(
        (result.state === "saved" || resolved) &&
        covered &&
        !incomplete.length &&
        !unknown.length
      );
      flushed &&= row.discharged;
      uncertain ||= !!unknown.length || (result.state === "unknown" && !resolved);
      for (const id of [...unknown, ...incomplete]) unresolved.add(id);
      restartBlocker ??= result.restartBlocker;
      if (summary) {
        if (!row.members.length)
          summary.latestEmptyCompletion = Math.max(
            summary.latestEmptyCompletion,
            result.completedMonotonicMs,
          );
        if (row.discharged) summary.awaitingRead = false;
        if (result.restartBlocker) summary.restartBlocker = result.restartBlocker;
        if (!row.discharged && !unknown.length && !incomplete.length && covered)
          summary.anonymousFailure = true;
        for (const id of unknown)
          remember(summary, id, "unknown", result.completedMonotonicMs, row.unpublished?.has(id));
        for (const id of incomplete)
          remember(summary, id, "incomplete", result.completedMonotonicMs);
        for (const { id } of row.members)
          if (result.accepted.includes(id))
            remember(summary, id, "accepted", result.completedMonotonicMs);
          else if (!result.unknown.includes(id))
            remember(summary, id, "incomplete", result.completedMonotonicMs);
      }
    }
    // Rechecks retain obligations, not capture identities. A new clock reading,
    // a different failure mode or an unrelated worker sequence uses the same slot.
    for (const [scopeId, summary] of value.proof.rechecks) {
      if (!value.retired && scopeId !== undefined && !value.targets.has(scopeId)) continue;
      restartBlocker ??= summary.restartBlocker;
      flushed &&= !summary.anonymousFailure && !summary.awaitingRead;
      for (const [id, obligation] of summary.members) {
        if (value.proof.resolvedTickets.has(id)) {
          summary.members.delete(id);
          continue;
        }
        if (obligation.unknown && obligation.unpublished && corroborated(id))
          obligation.unknown = false;
        if (obligation.incomplete && (await discarded(id))) obligation.incomplete = false;
        if (obligation.unknown || obligation.incomplete) {
          unresolved.add(id);
          flushed = false;
          uncertain ||= obligation.unknown;
        }
      }
    }
    if (value.proof.saturated) return unavailable();
    uncertain ||=
      deps.recovery.blocked?.(value.owner, value.retired ? undefined : value.targets) ?? false;
    uncertain ||= value.retired && deps.pendingPublication(value.owner);
    const saved = !uncertain && !pendingSettings && records.every((r) => r.final) && flushed;
    const state: DrainReport["state"] = saved
      ? "saved"
      : uncertain || pendingSettings
        ? "uncertain"
        : records.some((r) => r.payload === "complete-staging")
          ? "retryable"
          : "checkpoint-only";
    const result: DrainReport = { state, blocker: !saved, pendingSettings, records, errors: [] };
    if (!current()) return unavailable();
    if (saved || deps.now() >= budget.deadline) return result;
    const retaining = () => current() && deps.now() < budget.deadline;
    value.retaining = retaining;
    const retained = await bounded(
      budget,
      deps.recover(
        value.owner,
        result,
        retaining,
        unresolved,
        restartBlocker,
        value.proof.recoveryId,
      ),
      result,
    );
    delete value.retaining;
    return current() ? retained : unavailable();
  }
  async function run(value: Group, dispatch?: DrainDispatcher) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      value.rearm = () => {
        if (timedOut) return;
        clearTimeout(timer);
        timer = setTimeout(
          () => {
            timedOut = true;
            value.control.abort();
            resolve();
          },
          Math.max(0, value.deadline - deps.now()),
        );
      };
      value.rearm();
    });
    const work = async () => {
      for (;;) {
        await Promise.all([...value.entries].map((entry) => entry.ready));
        await deps.settle([...value.tickets], value.deadline, value.owner);
        const pending = [...value.entries].filter(
          (e) => !e.final && !e.failed && e.ended?.drain !== null && !value.sent.has(e.handle),
        );
        if (
          !pending.length ||
          !dispatch ||
          !value.callbackAllowed ||
          // Ordinary admission is already revoked during retirement. The frozen
          // original group retains only its bounded callback; dispatch still
          // checks the exact original channel, negotiation and peer lifetime.
          (!value.retired && !deps.live(value.owner)) ||
          value.control.signal.aborted ||
          deps.now() >= value.deadline
        )
          break;
        for (const entry of pending) value.sent.add(entry.handle);
        const request = snapshot(value);
        await dispatch(
          value.owner,
          {
            token: value.token,
            reason: value.reason,
            remainingMs: Math.max(0, Math.min(10000, value.deadline - deps.now())),
            checkpoints: request.checkpoints.filter((e) =>
              pending.some((p) => p.handle === e.checkpoint),
            ),
            writes: [...request.writes],
          },
          value.control.signal,
        ).catch(() => undefined);
        // A dispatch reply is only submission evidence. report() checks committed heads and the barrier.
      }
    };
    try {
      await Promise.race([work().catch(() => undefined), timeout]);
      return await report(value, value.lossRead?.budget.deadline);
    } finally {
      clearTimeout(timer);
      delete value.rearm;
    }
  }
  function start(
    value: Group,
    dispatch?: DrainDispatcher,
    reconciliationDeadline?: number,
  ): Promise<DrainReport> {
    if (value.run) return value.run;
    if (
      value.completed &&
      !value.completed.blocker &&
      deps.recovery.blocked?.(value.owner, value.retired ? undefined : value.targets)
    )
      return Promise.resolve(unavailable());
    if (value.completed) {
      const cached = value.completed;
      let expired = false;
      cached.records = cached.records.map((record) => {
        if (
          record.payload !== "complete-staging" ||
          record.expiresAt === undefined ||
          deps.wall() < record.expiresAt
        )
          return record;
        expired = true;
        const copy = { ...record };
        delete copy.expiresAt;
        return { ...copy, payload: record.committedRevision ? "checkpoint-only" : "none" };
      });
      if (
        expired &&
        cached.state === "retryable" &&
        !cached.records.some((r) => r.payload === "complete-staging")
      ) {
        cached.state = "checkpoint-only";
        delete cached.retryAction;
      }
      return Promise.resolve(structuredClone(cached));
    }
    const revision = value.revision;
    const operation =
      reconciliationDeadline === undefined
        ? run(value, dispatch)
        : (async () => {
            const budget = readBudget(value, reconciliationDeadline);
            await bounded(
              budget,
              deps.settle([...value.tickets], value.deadline, value.owner),
              undefined,
            );
            await bounded(budget, Promise.all([...value.entries].map((entry) => entry.ready)), []);
            return report(value, reconciliationDeadline, true, budget);
          })();
    async function publish() {
      try {
        let result = await operation;
        // Folding can yield, and even a saved report crosses a promise boundary.
        // The joined receipt must still satisfy every submitted producer's cutoff.
        if (!result.blocker && value.observing.some((row) => !timely(row))) result = unavailable();
        if (revision === value.revision) {
          value.completed = structuredClone(result);
          value.completedAt = deps.now();
        }
        return result;
      } finally {
        value.observing = [];
        delete value.run;
      }
    }
    value.run = publish();
    return value.run;
  }
  const unavailable = (): DrainReport => ({
    state: "uncertain",
    blocker: true,
    pendingSettings: false,
    records: [],
    errors: [{ code: "PLUGIN_E_STORAGE_IO", message: "Drain offer unavailable." }],
  });
  const participant: PersistenceParticipant = {
    endReservation(event, deadline) {
      const targets = mine(event.owner).filter(
        (entry) =>
          entry.reservation === event.reservationId &&
          entry.binding?.sessionId === event.sessionId &&
          entry.binding.providerGeneration === event.providerGeneration,
      );
      if (!targets.length) return null;
      const value = group(
        event.owner,
        "reservation-ended",
        Math.min(
          deadline,
          event.endedMonotonicMs + 10000,
          event.drain?.expiresMonotonicMs ?? Infinity,
        ),
      );
      if (event.drain) value.grant = event.drain;

      for (const entry of targets) {
        if (!entry.ended) {
          entry.ended = event;
          for (const ticket of deps.fenceTarget(event.owner, entry.id, value.deadline))
            value.tickets.add(ticket);
          const barrier = capture(
            value,
            { kind: "target", owner: event.owner, recordId: entry.id },
            true,
          );
          value.barriers.push(barrier);
        }
        include(value, entry);
      }
      return snapshot(value);
    },
    freeze(owner, reason, deadline, deviceDrain) {
      if (reason === "reservation-ended") throw new Error("Target ends do not retire owners.");
      if (deviceDrain && ownerKey(deviceDrain.owner) !== ownerKey(owner)) stale();
      retire(owner);
      const value = group(
        owner,
        reason,
        Math.min(deadline, deviceDrain?.expiresMonotonicMs ?? Infinity),
      );
      const newlyRetired = !value.retired;
      value.retired = true;
      value.reason = reason;
      if (deviceDrain) value.grant = deviceDrain;
      for (const entry of mine(owner)) include(value, entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      if (newlyRetired) {
        delete value.completed;
        value.revision++;
        const barrier = capture(value, { kind: "namespace", owner }, true);
        value.barriers.push(barrier);
      }
      return snapshot(value);
    },
    drain(offer, dispatch) {
      const value = groups.get(ownerKey(offer.owner));
      if (!value || value.token !== offer.token) return Promise.resolve(unavailable());
      shorten(value, offer.deadlineMonotonicMs);
      return start(value, dispatch);
    },
    async ownerLost(owner) {
      // A tied worker stamp can precede loss. Never promote a pre-loss
      // boundary ACK solely because its handler ran in the loss read window.
      for (const row of owners.get(ownerKey(owner))?.proof.history ?? [])
        row.deadlineBeforeLoss ??= row.deadline;
      const value = group(owner, "disable", deps.now());
      retire(owner);
      const newlyRetired = !value.retired;
      value.retired = true;
      for (const entry of mine(owner)) include(value, entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      if (newlyRetired) {
        delete value.completed;
        value.revision++;
        const barrier = capture(value, { kind: "namespace", owner }, true);
        value.barriers.push(barrier);
      }
      value.callbackAllowed = false;
      value.control.abort();
      // Publication was fenced at owner loss. Give the evidence reads their own bounded budget.
      if (!value.lossRead) {
        const at = deps.now();
        value.lossRead = { at, budget: readBudget(value, at + 10000) };
      }
      return start(value);
    },
    recoverySnapshot: () => deps.recovery.recoverySnapshot(),
    retry: (id, action) => deps.recovery.retry(id, action),
    discard: (id, action) => deps.recovery.discard(id, action),
  };
  return {
    participant,
    register,
    authorize,
    invalidateRecovery(owner: ResourceOwner, origin?: () => boolean) {
      const value = groups.get(ownerKey(owner));
      if (!value || (origin && value.retaining === origin)) return;
      value.revision++;
      delete value.completed;
    },
    async refreshRecovery(owner: ResourceOwner, deadline: number) {
      const value = groups.get(ownerKey(owner));
      if (!value) return;
      value.revision++;
      delete value.completed;
      if (value.run) await value.run;
      // Recovery reconciles evidence without dispatching callbacks or altering
      // the original grant, token, publication deadline or staging retention.
      return start(value, undefined, deadline);
    },
    captured(owner: ResourceOwner) {
      return owners.get(ownerKey(owner))?.proof.tickets;
    },
    permitsDisposition(owner: ResourceOwner, ticket: PublicationTicket) {
      const pinned = owners.get(ownerKey(owner))?.proof.tickets.get(ticket.id);
      return (
        ownerKey(owner) === ownerKey(ticket.owner) && (!pinned || isDeepStrictEqual(pinned, ticket))
      );
    },
    resolveTicket(owner: ResourceOwner, ticket: PublicationTicket) {
      const group = groups.get(ownerKey(owner));
      if (
        ownerKey(owner) === ownerKey(ticket.owner) &&
        group &&
        isDeepStrictEqual(group.proof.tickets.get(ticket.id), ticket)
      ) {
        group.proof.resolvedTickets.add(ticket.id);
        for (const check of group.proof.rechecks.values()) check.members.delete(ticket.id);
        return true;
      }
      return false;
    },
    retireCheckpoint(
      owner: ResourceOwner,
      recovery: string,
      resolvedRecords: DrainReport["records"] = [],
    ) {
      const value = groups.get(ownerKey(owner));
      const candidates = new Set([
        ...[...entries.values()].filter((entry) => ownerKey(entry.owner) === ownerKey(owner)),
        ...(value?.entries ?? []),
      ]);
      for (const entry of candidates) {
        if (checkpointRecoveryId(entry.handle) !== recovery) continue;
        const current = entries.get(key(owner, entry.id));
        if (current === entry) entries.delete(key(owner, entry.id));
        value?.entries.delete(entry);
        deps.recovery.releaseIdentity?.(owner, recovery);
        const revision =
          resolvedRecords.find((r) => r.id === entry.id)?.committedRevision ??
          entry.record?.revision;
        if (value?.targets.has(entry.id) && (!current || current === entry) && revision)
          value?.proof.discardedRecords.set(entry.id, revision);
      }
      if (value) {
        value.revision++;
        delete value.completed;
      }
    },
    finalGrant(owner: ResourceOwner, input: RecordWrite): FinalWriteGrant | undefined {
      if (!input.drainToken) return undefined;
      authorize(owner, input);
      const value = groups.get(ownerKey(owner))!;
      if (input.target.mode !== "replace" || !input.checkpoint) stale();
      const entry = entries.get(key(owner, input.target.id));
      const grant = entry?.ended?.drain ?? value.grant;
      return {
        owner: value.owner,
        recordId: input.target.id,
        checkpoint: input.checkpoint.handle,
        token: value.token,
        deadlineMonotonicMs: value.deadline,
        ...(grant ? { deviceDrain: grant } : {}),
      };
    },
    open: (owner: ResourceOwner) => mine(owner).length !== 0,
    committed(owner: ResourceOwner, input: RecordWrite, record: RecordMeta) {
      if (!input.checkpoint || input.target.mode !== "replace") return;
      const entry = entries.get(key(owner, input.target.id));
      if (!entry || entry.handle !== input.checkpoint.handle) return;
      entry.record = record;
      if (record.checkpoint === "final") {
        entry.final = true;
        entry.terminalAt = deps.now();
        entry.ready = deps
          .persist(owner, { checkpoint: entry.handle, record, state: "final" })
          .catch(() => {
            entry.failed = true;
          });
      }
    },
    async abandon(
      owner: ResourceOwner,
      input: { checkpoint: string },
    ): Promise<StorageRequestMap["storage/abandonCheckpoint"]["result"]> {
      const entry = mine(owner).find((e) => e.handle === input.checkpoint);
      if (!entry || !entry.record) return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
      if (
        deps.checkpointOpen(owner, entry.id) ||
        (entry.reservation && deps.reservations.validate(owner, entry.reservation))
      )
        return new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", "write-in-progress").result;
      const record = { ...entry.record, interrupted: true };
      await deps.persist(owner, { checkpoint: entry.handle, record, state: "interrupted" });
      if (entries.get(key(owner, entry.id)) === entry) {
        entries.delete(key(owner, entry.id));
        deps.recovery.releaseIdentity?.(owner, checkpointRecoveryId(entry.handle));
      }
      return { ok: true, value: { record } };
    },
  };
}
