import type { FinalWriteGrant } from "./engine-port.js";
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
import { ownerKey, PersistenceFault, conflict, stale } from "./record-port.js";
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
  recover(owner: ResourceOwner, report: DrainReport): Promise<DrainReport>;
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
};
type Group = {
  owner: ResourceOwner;
  reason: DrainReason;
  token: string;
  deadline: number;
  entries: Set<Entry>;
  tickets: Set<string>;
  sent: Set<string>;
  retired: boolean;
  grant?: DeviceDrainGrant;
  run?: Promise<DrainReport>;
  control: AbortController;
  rearm?: () => void;
  callbackAllowed: boolean;
  barriers: PersistenceBarrier[];
};
export function createPersistenceLifecycle(deps: LifecycleDependencies) {
  const entries = new Map<string, Entry>();
  const groups = new Map<string, Group>();
  const retired = new Set<string>();
  const key = (owner: ResourceOwner, id: string) => JSON.stringify([ownerKey(owner), id]);
  const mine = (owner: ResourceOwner) =>
    [...entries.values()].filter(
      (entry) => ownerKey(entry.owner) === ownerKey(owner) && !entry.final,
    );
  function group(owner: ResourceOwner, reason: DrainReason, deadline: number) {
    const identity = ownerKey(owner);
    let value = groups.get(identity);
    if (value && !value.retired && !value.run && [...value.entries].every((e) => e.final)) {
      groups.delete(identity);
      value = undefined;
    }
    if (!value) {
      value = {
        owner: Object.freeze({ ...owner }),
        reason,
        token: randomUUID(),
        deadline: Math.min(deadline, deps.now() + 10000),
        entries: new Set(),
        tickets: new Set(),
        sent: new Set(),
        retired: false,
        control: new AbortController(),
        callbackAllowed: true,
        barriers: [],
      };
      groups.set(identity, value);
    }
    value.deadline = Math.min(value.deadline, deadline);
    value.rearm?.();
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
    if (!deps.live(owner) || retired.has(ownerKey(owner)))
      return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
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
    if (retired.has(ownerKey(owner)) || !deps.live(owner) || (target && value?.entries.has(target)))
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
  async function bounded<T>(value: Group, action: Promise<T>, fallback: T): Promise<T> {
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
  async function report(value: Group): Promise<DrainReport> {
    const records: DrainReport["records"] = [];
    let uncertain = false;
    for (const entry of value.entries) {
      if (entry.failed) {
        uncertain = true;
        continue;
      }
      const evidence = await bounded<RecordMeta | undefined>(
        value,
        Promise.resolve().then(() => deps.reads.stat(value.owner, entry.id)),
        undefined,
      );
      if (!evidence) uncertain = true;
      const final = evidence?.checkpoint === "final";
      entry.final ||= final;
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
          value,
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
      : [...value.entries].map((entry) => ({
          kind: "target",
          owner: value.owner,
          recordId: entry.id,
        }));
    const finalBarriers = scopes.map((scope) => deps.evidence.capture(scope, value.deadline));
    const outcomes = await bounded(
      value,
      Promise.all(
        [...value.barriers, ...finalBarriers].map((barrier) => deps.evidence.flush(barrier)),
      ),
      [],
    );
    const flushed =
      outcomes.length === value.barriers.length + finalBarriers.length &&
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
    return saved ? result : deps.recover(value.owner, result);
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
          const barrier = deps.evidence.capture(
            { kind: "target", owner: event.owner, recordId: entry.id },
            value.deadline,
          );
          value.barriers.push(barrier);
          for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
          for (const ticket of deps.fenceTarget(event.owner, entry.id, value.deadline))
            value.tickets.add(ticket);
        }
        value.entries.add(entry);
      }
      return snapshot(value);
    },
    freeze(owner, reason, deadline, deviceDrain) {
      if (reason === "reservation-ended") throw new Error("Target ends do not retire owners.");
      if (deviceDrain && ownerKey(deviceDrain.owner) !== ownerKey(owner)) stale();
      retired.add(ownerKey(owner));
      const value = group(
        owner,
        reason,
        Math.min(deadline, deviceDrain?.expiresMonotonicMs ?? Infinity),
      );
      value.retired = true;
      value.reason = reason;
      if (deviceDrain) value.grant = deviceDrain;
      for (const entry of mine(owner)) value.entries.add(entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      const barrier = deps.evidence.capture({ kind: "namespace", owner }, value.deadline);
      value.barriers.push(barrier);
      for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
      return snapshot(value);
    },
    drain(offer, dispatch) {
      const value = groups.get(ownerKey(offer.owner));
      if (!value || value.token !== offer.token) return Promise.resolve(unavailable());
      value.deadline = Math.min(value.deadline, offer.deadlineMonotonicMs);
      value.rearm?.();
      if (!value.run)
        value.run = run(value, dispatch).finally(() => {
          delete value.run;
        });
      return value.run;
    },
    async ownerLost(owner) {
      const value = group(owner, "disable", deps.now());
      retired.add(ownerKey(owner));
      value.retired = true;
      for (const entry of mine(owner)) value.entries.add(entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      const barrier = deps.evidence.capture({ kind: "namespace", owner }, value.deadline);
      value.barriers.push(barrier);
      for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
      value.callbackAllowed = false;
      value.control.abort();
      if (!value.run)
        value.run = run(value).finally(() => {
          delete value.run;
        });
      return value.run;
    },
    recoverySnapshot: () => deps.recovery.recoverySnapshot(),
    retry: (id, action) => deps.recovery.retry(id, action),
    discard: (id, action) => deps.recovery.discard(id, action),
  };
  return {
    participant,
    register,
    authorize,
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
