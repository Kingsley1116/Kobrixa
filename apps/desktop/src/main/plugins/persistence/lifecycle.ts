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
  pendingSettings(owner: ResourceOwner): boolean;
  settle(tickets: readonly string[], deadline: number): Promise<void>;
  evidence: PersistenceEvidencePort;
  reads: Pick<PersistenceReadPort, "stat">;
  payload(
    owner: ResourceOwner,
    id: string,
  ): { kind: "complete-staging" | "checkpoint-only" | "none"; expiresMonotonicMs?: number };
  recover(owner: ResourceOwner, report: DrainReport, current: () => boolean): Promise<DrainReport>;
  checkpointOpen(owner: ResourceOwner, id: string): boolean;
  recovery: Pick<PersistenceParticipant, "recoverySnapshot" | "retry" | "discard">;
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
type Group = {
  owner: ResourceOwner;
  reason: DrainReason;
  token: string;
  deadline: number;
  entries: Set<Entry>;
  targets: Set<string>;
  discardedRecords: Map<string, string>;
  tickets: Set<string>;
  sent: Set<string>;
  retired: boolean;
  grant?: DeviceDrainGrant;
  run?: Promise<DrainReport>;
  completed?: DrainReport;
  completedAt?: number;
  revision: number;
  control: AbortController;
  rearm?: () => void;
  callbackAllowed: boolean;
  barriers: PersistenceBarrier[];
};
export function createPersistenceLifecycle(deps: LifecycleDependencies) {
  const entries = new Map<string, Entry>();
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
        !value.discardedRecords.size &&
        value.completedAt !== undefined &&
        now >= value.completedAt + retention
      )
        groups.delete(id);
    for (const [id, entry] of entries)
      if (
        entry.final &&
        !entry.failed &&
        entry.terminalAt !== undefined &&
        now >= entry.terminalAt + retention &&
        !groups.get(ownerKey(entry.owner))?.run
      )
        entries.delete(id);
  }
  function retire(owner: ResourceOwner) {
    if (retired.has(ownerKey(owner))) return;
    if (retired.size >= hostLimit) retirementSaturated = true;
    else retired.add(ownerKey(owner));
  }
  function shorten(value: Group, deadline: number) {
    if (deadline >= value.deadline) return;
    value.deadline = deadline;
    // Main's fence updates the same shared gates observed at worker publication.
    if (value.retired) {
      for (const ticket of deps.fence(value.owner, deadline)) value.tickets.add(ticket);
    } else
      for (const entry of value.entries)
        for (const ticket of deps.fenceTarget(value.owner, entry.id, deadline))
          value.tickets.add(ticket);
    value.rearm?.();
  }
  function include(value: Group, entry: Entry) {
    if (!value.entries.has(entry)) {
      if (
        value.entries.size >= sourceLimit ||
        new Set([...value.targets, ...value.discardedRecords.keys(), entry.id]).size > sourceLimit
      ) {
        deps.fenceTarget(value.owner, entry.id, deps.now());
        limit();
      }
      value.entries.add(entry);
      value.targets.add(entry.id);
      value.discardedRecords.delete(entry.id);
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
    const discardedRecords = value?.discardedRecords ?? new Map<string, string>();
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
        retirementSaturated = true;
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
        discardedRecords,
        tickets: new Set(),
        sent: new Set(),
        retired: false,
        control: new AbortController(),
        callbackAllowed: true,
        barriers: [],
        revision: 0,
      };
      groups.set(identity, value);
    }
    shorten(value, deadline);
    return value;
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
    entries.set(key(owner, input.id), entry);
    groups.get(ownerKey(owner))?.discardedRecords.delete(input.id);
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
        deps.now() >= value.deadline ||
        input.target.mode !== "replace" ||
        !target ||
        !value.entries.has(target) ||
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
    value: Pick<Group, "deadline">,
    action: Promise<T>,
    fallback: T,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action.catch(() => fallback),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), Math.max(0, value.deadline - deps.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function report(value: Group, deadline = value.deadline): Promise<DrainReport> {
    // This snapshot spans all reads/flushes and the recovery write, not just the
    // cached return. Core actions invalidate it on admission and on completion.
    const revision = value.revision;
    const current = () =>
      groups.get(ownerKey(value.owner)) === value && value.revision === revision;
    const budget = { deadline };
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
        ...(complete ? { expiresAt: deps.wall() + held.expiresMonotonicMs! - deps.now() } : {}),
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
          ...(complete ? { expiresAt: deps.wall() + held.expiresMonotonicMs! - deps.now() } : {}),
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
    const finalBarriers = scopes.map((scope) => deps.evidence.capture(scope, value.deadline));
    for (const barrier of finalBarriers)
      for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
    const initialBarriers = value.barriers.splice(0);
    const outcomes = await bounded(
      budget,
      Promise.all(
        [...initialBarriers, ...finalBarriers].map(async (barrier) => {
          const result = await deps.evidence.flush(barrier);
          const discarded = new Set<string>();
          for (const id of result.incomplete) {
            const revision = value.discardedRecords.get(id);
            if (!revision || entries.has(key(value.owner, id))) continue;
            const current = await bounded<RecordMeta | undefined>(
              budget,
              Promise.resolve().then(() => deps.reads.stat(value.owner, id)),
              undefined,
            );
            if (
              current?.revision === revision &&
              !entries.has(key(value.owner, id)) &&
              value.discardedRecords.get(id) === revision
            )
              discarded.add(id);
          }
          const incomplete = result.incomplete.filter((id) => !discarded.has(id));
          const unknown = result.unknown;
          // Explicit, durably removed recovery resolves only its exact evidence.
          const resolved =
            !incomplete.length &&
            !unknown.length &&
            (result.incomplete.length > 0 || result.unknown.length > 0);
          return {
            ...result,
            incomplete,
            unknown,
            state: resolved ? ("saved" as const) : result.state,
          };
        }),
      ),
      [],
    );
    const flushed =
      outcomes.length === initialBarriers.length + finalBarriers.length &&
      outcomes.every(
        (result) => result.state === "saved" && !result.incomplete.length && !result.unknown.length,
      );
    uncertain ||= outcomes.some(
      (result) => result.unknown.length > 0 || result.state === "unknown",
    );
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
    const retained = saved ? result : await deps.recover(value.owner, result, current);
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
        await deps.settle([...value.tickets], value.deadline);
        const pending = [...value.entries].filter(
          (e) => !e.final && !e.failed && e.ended?.drain !== null && !value.sent.has(e.handle),
        );
        if (
          !pending.length ||
          !dispatch ||
          !value.callbackAllowed ||
          !deps.live(value.owner) ||
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
      return await report(value);
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
            const budget = { deadline: reconciliationDeadline };
            await bounded(budget, deps.settle([...value.tickets], value.deadline), undefined);
            await bounded(budget, Promise.all([...value.entries].map((entry) => entry.ready)), []);
            return report(value, reconciliationDeadline);
          })();
    value.run = operation
      .then((result) => {
        if (revision === value.revision) {
          value.completed = structuredClone(result);
          value.completedAt = deps.now();
        }
        return result;
      })
      .finally(() => {
        delete value.run;
      });
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
          const barrier = deps.evidence.capture(
            { kind: "target", owner: event.owner, recordId: entry.id },
            value.deadline,
          );
          value.barriers.push(barrier);
          for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
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
        const barrier = deps.evidence.capture({ kind: "namespace", owner }, value.deadline);
        value.barriers.push(barrier);
        for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
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
      const value = group(owner, "disable", deps.now());
      retire(owner);
      const newlyRetired = !value.retired;
      value.retired = true;
      for (const entry of mine(owner)) include(value, entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      if (newlyRetired) {
        delete value.completed;
        value.revision++;
        const barrier = deps.evidence.capture({ kind: "namespace", owner }, value.deadline);
        value.barriers.push(barrier);
        for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
      }
      value.callbackAllowed = false;
      value.control.abort();
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
    invalidateRecovery(owner: ResourceOwner) {
      const value = groups.get(ownerKey(owner));
      if (!value) return;
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
      await start(value, undefined, deadline);
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
        const revision =
          resolvedRecords.find((r) => r.id === entry.id)?.committedRevision ??
          entry.record?.revision;
        if ((!current || current === entry) && revision)
          value?.discardedRecords.set(entry.id, revision);
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
      entries.delete(key(owner, entry.id));
      return { ok: true, value: { record } };
    },
  };
}
