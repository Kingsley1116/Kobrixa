import { wallExpiry as projectWallExpiry } from "./wall-expiry.js";
import { randomUUID } from "node:crypto";
import type { ResourceOwner, Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { PersistenceBackend, StoredRecovery, PublicationTicket } from "./engine-port.js";
import type { PersistenceActionAdapter, ExportDestination } from "./actions.js";
import type { ExportOutcome } from "./engine-port.js";
import type {
  CoreWindowScope,
  CoreActionReference,
  CoreActionValidationPort,
  DrainReport,
} from "@kobrixa/plugin-runtime";
import type { PersistenceRecoverySnapshot } from "../../../shared/plugin-persistence.js";
import { PersistenceFault, ownerKey, limit, stale } from "./record-port.js";
type Dependencies = {
  now(): number;
  wall(): number;
  actions: CoreActionValidationPort;
  retry(
    owner: ResourceOwner,
    report: DrainReport,
    deadline: number,
    retainedTicket?: PublicationTicket | null,
  ): Promise<DrainReport>;
  discard(
    owner: ResourceOwner,
    report: DrainReport,
    ticket: PublicationTicket | null,
  ): Promise<DrainReport>;
  backend: PersistenceBackend;
  adapter: PersistenceActionAdapter;
  coreOwner(input: { sourceKey: string; scope: CoreWindowScope }): ResourceOwner | null;
  changing?(owner: ResourceOwner, origin?: () => boolean): void;
  // Exact identity retirement is synchronous with durable removal. Reconciliation
  // below runs after releasing the mutation queue because it can join a drain.
  retired?(owner: ResourceOwner, report: DrainReport, ticket: PublicationTicket | null): void;
  retried?(
    owner: ResourceOwner,
    report: DrainReport,
    deadline: number,
    ticket?: PublicationTicket | null,
  ): Promise<void>;
  discarded?(
    owner: ResourceOwner,
    report: DrainReport,
    ticket: PublicationTicket | null,
  ): Promise<void>;
};
export interface PersistenceRecoveryHostPort {
  snapshot(): PersistenceRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  export(input: { recovery: Handle; action: CoreActionReference }): Promise<
    PersistenceResult<{
      disposition: "not-committed" | "committed" | "unknown";
    }>
  >;
}
type Entry = {
  id: string;
  owner: ResourceOwner;
  report: DrainReport;
  expires: number;
  restartRequired?: true;
  dispositionFailed?: "retain" | "action" | "retry-blocked";
  actionIds: { retry: string; export: string; discard: string };
  evidence?: Pick<StoredRecovery, "ticket" | "sealedPin">;
};
export function createPersistenceRecovery(deps: Dependencies) {
  const entries = new Map<string, Entry>();
  // Reserve a compact failure row before mutation admission. Pending slots do
  // not expose actions or replace the last published snapshot.
  const reservations = new Map<
    string,
    { entry: Entry; recordId: string | undefined; users: number }
  >();
  // A full report store can still owe a disposition. Keep only its identity
  // and authority here; project the unavailable report when it is requested.
  type Refusal = Pick<Entry, "owner" | "id" | "evidence"> & {
    recordId?: string;
    discardAction: string;
    pendingSettings: boolean;
  };
  const refusals = new Map<string, Refusal>();
  type IdentityKind = "owner" | "checkpoint" | "ticket";
  const capacity = new Map<
    string,
    { source: string; owner: Set<string>; checkpoint: Set<string>; ticket: Set<string> }
  >();
  function reserveIdentity(owner: ResourceOwner, id: string, kind: IdentityKind) {
    const key = ownerKey(owner);
    let group = capacity.get(key);
    if (!group) {
      if (
        capacity.size >= 1024 ||
        [...capacity.values()].filter((row) => row.source === owner.sourceKey).length >= 64
      )
        limit();
      group = {
        source: owner.sourceKey,
        owner: new Set(),
        checkpoint: new Set(),
        ticket: new Set(),
      };
      capacity.set(key, group);
    }
    if (group.owner.has(id) || group.checkpoint.has(id) || group.ticket.has(id)) return;
    const slots = group[kind],
      bound = kind === "owner" ? 1 : kind === "checkpoint" ? 64 : 1024;
    if (slots.size >= bound) limit();
    slots.add(id);
  }
  function releaseIdentity(owner: ResourceOwner, id: string) {
    if (refusals.has(id)) return;
    const key = ownerKey(owner),
      group = capacity.get(key);
    if (!group) return;
    group.owner.delete(id);
    group.checkpoint.delete(id);
    group.ticket.delete(id);
    if (!group.owner.size && !group.ticket.size && !group.checkpoint.size) capacity.delete(key);
  }
  function refusalEntry(row: Refusal): Entry {
    return {
      id: row.id,
      owner: row.owner,
      expires: Infinity,
      dispositionFailed: "retain",
      actionIds: { retry: "", export: "", discard: row.discardAction },
      report: {
        state: "uncertain",
        blocker: true,
        records: [],
        errors: [],
        pendingSettings: row.pendingSettings,
        recovery: row.id,
      },
      ...(row.evidence ? { evidence: row.evidence } : {}),
    };
  }
  const mutations = new Map<string, { owner: ResourceOwner; tail: Promise<void>; count: number }>();
  let pendingMutations = 0;
  function mutate<T>(owner: ResourceOwner, operation: () => Promise<T>): Promise<T> {
    if (
      pendingMutations >= 1024 ||
      [...mutations.values()]
        .filter((row) => row.owner.sourceKey === owner.sourceKey)
        .reduce((count, row) => count + row.count, 0) >= 64
    )
      limit();
    const key = ownerKey(owner);
    const row = mutations.get(key) ?? { owner, tail: Promise.resolve(), count: 0 };
    mutations.set(key, row);
    row.count++;
    pendingMutations++;
    const run = row.tail.then(operation).finally(() => {
      pendingMutations--;
      if (--row.count === 0) mutations.delete(key);
    });
    // A rejected write must not poison later recovery. Idle queues retain no history.
    row.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const dispositions = new Set<{ owner: ResourceOwner; report: DrainReport }>();
  function disposition<T>(
    owner: ResourceOwner,
    report: DrainReport,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = { owner, report };
    const work = mutate(owner, operation);
    dispositions.add(pending);
    return work.finally(() => {
      dispositions.delete(pending);
    });
  }

  // Sample admission data synchronously. Publish a queued failure before the
  // next mutation can replace or remove the identified entry.
  async function claimedDisposition<T>(
    entry: Entry,
    prepare: (preserveProjection: () => void) => () => Promise<T>,
  ): Promise<T> {
    const refusal = refusals.get(entry.id);
    const identified = () =>
      refusal ? refusals.get(entry.id) === refusal : entries.get(entry.id) === entry;
    let preserve = false;
    const publishFailure = () => {
      if (!identified()) return;
      if (preserve) {
        entry.dispositionFailed ??= "retry-blocked";
        revision++;
        changed();
      } else failed(entry, "action");
    };
    let work: Promise<T>;
    try {
      const operation = prepare(() => {
        preserve = true;
      });
      work = disposition(entry.owner, entry.report, async () => {
        try {
          if (!identified()) stale();
          return await operation();
        } catch (error) {
          publishFailure();
          throw error;
        } finally {
          // Revoke reports before the next queued retain can test its revision.
          deps.changing?.(entry.owner);
        }
      });
    } catch (error) {
      publishFailure();
      deps.changing?.(entry.owner);
      throw error;
    }
    deps.changing?.(entry.owner);
    return work;
  }
  function fits(owner: ResourceOwner, id: string, candidate: DrainReport) {
    const size = chargeBytes(candidate);
    let host = size,
      source = size;
    const charge = (other: Entry) => {
      if (other.id === id) return;
      const bytes = Math.max(chargeBytes(other.report), pendingBytes.get(other.id) ?? 0);
      host += bytes;
      if (other.owner.sourceKey === owner.sourceKey) source += bytes;
    };
    for (const row of entries.values()) charge(row);
    for (const { entry } of reservations.values()) if (!entries.has(entry.id)) charge(entry);
    return size <= 8192 && host <= 67108864 && source <= 4194304;
  }
  const pendingBytes = new Map<string, number>();
  function chargeBytes(report: DrainReport) {
    return Math.max(
      Buffer.byteLength(JSON.stringify(report)),
      Buffer.byteLength(JSON.stringify({ ...report, state: "uncertain", blocker: true })),
    );
  }
  function failed(entry: Entry, operation: "retain" | "action", origin?: () => boolean) {
    entry.dispositionFailed = operation;
    entry.report = { ...entry.report, state: "uncertain", blocker: true };
    revision++;
    changed();
    if (operation === "retain") deps.changing?.(entry.owner, origin);
  }
  let revision = 0;
  const listeners = new Set<() => void>();
  const exporting = new Set<string>();
  const exports = new Map<
    string,
    {
      job: string;
      owner: ResourceOwner;
      pin: Handle | undefined;
      closePin: boolean;
      destination: ExportDestination | null;
    }
  >();
  async function reconcileExport(id: string): Promise<ExportOutcome | undefined> {
    const job = exports.get(id);
    if (!job) return undefined;
    const result = await deps.backend.output
      .reconcile(job.job)
      .catch(() => ({ disposition: "unknown" as const }));
    if (result.disposition !== "unknown") {
      if (job.closePin && job.pin) await deps.backend.reads.close(job.owner, job.pin);
      if (job.destination) await deps.backend.destinations.release(job.destination);
      exports.delete(id);
    }
    return result;
  }
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot invalidate durable evidence. */
      }
    }
  };
  async function persist(entry: Entry) {
    const previous = await deps.backend.evidence.loadRecovery(entry.id);
    if (
      entry.report.state === "saved" ||
      (entry.report.state === "checkpoint-only" &&
        !entry.report.records.some((record) => record.payload === "complete-staging"))
    ) {
      const pin = entry.evidence?.sealedPin ?? previous?.sealedPin;
      if (pin) await deps.backend.reads.close(entry.owner, pin);
      entry.evidence = {
        ticket: entry.evidence?.ticket ?? previous?.ticket ?? null,
        sealedPin: null,
      };
    }
    await deps.backend.evidence.saveRecovery({
      id: entry.id,
      owner: entry.owner,
      report: entry.report,
      ticket: entry.evidence?.ticket ?? previous?.ticket ?? null,
      sealedPin: entry.evidence ? entry.evidence.sealedPin : (previous?.sealedPin ?? null),
      expiresAt: Number.isFinite(entry.expires) ? projectWallExpiry(deps, entry.expires) : null,
    });
  }
  async function persistReplacement(entry: Entry, candidate: Entry) {
    if (!fits(entry.owner, entry.id, candidate.report)) limit();
    pendingBytes.set(entry.id, chargeBytes(candidate.report));
    try {
      await persist(candidate);
      Object.assign(entry, candidate);
    } finally {
      pendingBytes.delete(entry.id);
    }
  }
  function expire(entry: Entry) {
    if (
      deps.now() < entry.expires ||
      !entry.report.records.some((r) => r.payload === "complete-staging")
    )
      return;
    entry.report = {
      ...entry.report,
      state: entry.report.state === "uncertain" ? "uncertain" : "checkpoint-only",
      records: entry.report.records.map((record) => {
        const copy = { ...record };
        delete copy.expiresAt;
        return {
          ...copy,
          payload: record.committedRevision ? ("checkpoint-only" as const) : ("none" as const),
        };
      }),
    };
    delete entry.report.retryAction;
    revision++;
  }
  function checked(
    id: string,
    action: CoreActionReference,
    kind: "persistence-retry" | "persistence-discard" | "persistence-export",
  ) {
    const refusal = refusals.get(id);
    const entry =
      entries.get(id) ??
      (refusal && kind === "persistence-discard" ? refusalEntry(refusal) : undefined);
    if (!entry) stale();
    expire(entry);
    if (!deps.actions.claim(action, { kind, recovery: id }))
      throw new PersistenceFault("PLUGIN_E_PERMISSION_DENIED");
    return entry;
  }
  const restartError = {
    code: "PLUGIN_E_STORAGE_IO",
    message: "Restart Kobrixa to verify storage before writing to this source again.",
  };
  const api = {
    reserveIdentity,
    releaseIdentity,
    releaseOwner(owner: ResourceOwner) {
      const key = ownerKey(owner),
        group = capacity.get(key);
      if (!group) return;
      for (const slot of [group.owner, group.checkpoint, group.ticket])
        for (const id of slot) releaseIdentity(owner, id);
    },
    blocked(owner: ResourceOwner, targets?: ReadonlySet<string>) {
      const matches = (entry: { owner: ResourceOwner; report: DrainReport }) =>
        ownerKey(entry.owner) === ownerKey(owner) &&
        (!targets ||
          !entry.report.records.length ||
          entry.report.records.some((r) => targets.has(r.id)));
      return (
        [...refusals.values()].some((r) => ownerKey(r.owner) === ownerKey(owner)) ||
        [...dispositions].some(matches) ||
        [...entries.values()].some((e) => e.dispositionFailed && matches(e))
      );
    },
    retainRestartBlocker(owner: ResourceOwner, id: Handle): DrainReport {
      const existing = entries.get(id);
      if (existing) return structuredClone(existing.report);
      const report: DrainReport = {
        state: "uncertain",
        blocker: true,
        recovery: id,
        records: [],
        pendingSettings: false,
        errors: [restartError],
      };
      // The source fence belongs to this host epoch. A fresh worker can serve
      // the next epoch only after verified startup recovery completes.
      entries.set(id, {
        id,
        owner: { ...owner },
        report,
        restartRequired: true,
        expires: Infinity,
        actionIds: { retry: randomUUID(), export: randomUUID(), discard: randomUUID() },
      });
      revision++;
      changed();
      return structuredClone(report);
    },
    // Checkpoint metadata and its derived recovery row must share the same
    // ordering as core actions, including every persistence await.
    async persistCheckpoint(
      owner: ResourceOwner,
      current: () => boolean,
      write: () => Promise<void>,
    ): Promise<void> {
      await mutate(owner, async () => {
        if (current()) await write();
      });
    },
    async retain(
      owner: ResourceOwner,
      report: DrainReport,
      evidence?: Pick<StoredRecovery, "ticket" | "sealedPin">,
      current: () => boolean = () => true,
    ): Promise<DrainReport> {
      if (!current()) return structuredClone(report);
      const refusal = report.recovery
        ? refusals.get(report.recovery)
        : [...refusals.values()].find(
            (r) => ownerKey(r.owner) === ownerKey(owner) && r.recordId === report.records[0]?.id,
          );
      if (refusal) {
        if (ownerKey(refusal.owner) !== ownerKey(owner)) stale();
        return refusalEntry(refusal).report;
      }
      const existing = report.recovery
        ? entries.get(report.recovery)
        : [...entries.values()].find(
            (entry) =>
              !entry.restartRequired &&
              ownerKey(entry.owner) === ownerKey(owner) &&
              entry.report.records[0]?.id === report.records[0]?.id,
          );
      if (existing && ownerKey(existing.owner) !== ownerKey(owner)) stale();
      const pending = report.recovery
        ? reservations.get(report.recovery)
        : [...reservations.values()].find(
            (r) =>
              ownerKey(r.entry.owner) === ownerKey(owner) && r.recordId === report.records[0]?.id,
          );
      if (pending && ownerKey(pending.entry.owner) !== ownerKey(owner)) stale();
      const id = existing?.id ?? pending?.entry.id ?? report.recovery ?? randomUUID();
      const placeholder: DrainReport = {
        state: "uncertain",
        blocker: true,
        pendingSettings: report.pendingSettings,
        records: [],
        errors: [],
        recovery: id,
      };
      const reserved: Entry = existing ??
        pending?.entry ?? {
          id,
          owner: { ...owner },
          report: placeholder,
          expires: Infinity,
          actionIds: { retry: randomUUID(), export: randomUUID(), discard: randomUUID() },
        };
      if (!existing && !pending && !fits(owner, id, placeholder)) {
        // Identity admission is independent of the report-byte and mutation
        // budgets. Nothing enters the queue until one of these slots exists.
        reserveIdentity(owner, id, "ticket");
        refusals.set(id, {
          id,
          owner: { ...owner },
          discardAction: reserved.actionIds.discard,
          pendingSettings: report.pendingSettings,
          ...(report.records[0] ? { recordId: report.records[0].id } : {}),
          ...(evidence ? { evidence: structuredClone(evidence) } : {}),
        });
        revision++;
        changed();
        deps.changing?.(owner, current);
        limit();
      }
      const slot = pending ?? { entry: reserved, recordId: report.records[0]?.id, users: 0 };
      reservations.set(id, slot);
      slot.users++;
      try {
        return await disposition(owner, report, async () => {
          if (!current()) return structuredClone(report);
          const entry = entries.get(id) ?? reserved;
          const projected = structuredClone(report);
          projected.recovery = id;
          if (projected.state === "retryable") projected.retryAction = entry.actionIds.retry;
          if (report.records.length > 2 || report.errors.length > 16) limit();
          const expires = Math.min(
            ...report.records.map((r) =>
              r.expiresAt === undefined
                ? Infinity
                : deps.now() + Math.max(0, r.expiresAt - deps.wall()),
            ),
          );
          if (entry.dispositionFailed) {
            if (entry.dispositionFailed !== "action")
              await persist(entry).catch(() => failed(entry, "retain", current));
            return structuredClone(entry.report);
          }
          const projectedExpires = Math.min(entry.expires, expires);
          for (const record of projected.records)
            if (record.expiresAt !== undefined)
              record.expiresAt = Math.min(
                record.expiresAt,
                projectWallExpiry(deps, projectedExpires),
              );
          if (!fits(owner, id, projected)) limit();
          if (evidence) entry.evidence = structuredClone(evidence);
          entry.expires = projectedExpires;
          entry.report = projected;
          entries.set(entry.id, entry);
          revision++;
          await persist(entry).then(changed, () => failed(entry, "retain", current));
          return structuredClone(entry.report);
        });
      } catch (error) {
        const entry = entries.get(id) ?? reserved;
        if (evidence && !entry.evidence) entry.evidence = structuredClone(evidence);
        entries.set(id, entry);
        failed(entry, "retain", current);
        throw error;
      } finally {
        if (--slot.users === 0) reservations.delete(id);
      }
    },
    recoverySnapshot(): PersistenceRecoverySnapshot {
      for (const entry of entries.values()) expire(entry);
      return {
        revision,
        items: [...entries.values(), ...Array.from(refusals.values(), refusalEntry)].map(
          (entry) => {
            const record = entry.report.records.length === 1 ? entry.report.records[0] : undefined;
            const payload = entry.report.records.some((r) => r.payload === "complete-staging")
              ? ("complete-staging" as const)
              : entry.report.records.some((r) => r.committedRevision !== null)
                ? ("checkpoint-only" as const)
                : ("none" as const);
            return {
              id: entry.id,
              sourceKey: entry.owner.sourceKey,
              pluginId: entry.owner.pluginId,
              recordId: record?.id ?? null,
              committedRevision: record?.committedRevision ?? null,
              state: entry.report.state,
              payload,
              ...(entry.report.state === "retryable" && Number.isFinite(entry.expires)
                ? { expiresAt: projectWallExpiry(deps, entry.expires) }
                : {}),
              ...(entry.restartRequired ? { restartRequired: true as const } : {}),
              actions: entry.restartRequired
                ? []
                : [
                    ...(entry.report.state === "retryable"
                      ? [{ id: entry.actionIds.retry, kind: "retry" as const }]
                      : []),
                    ...(payload !== "none"
                      ? [{ id: entry.actionIds.export, kind: "export" as const }]
                      : []),
                    { id: entry.actionIds.discard, kind: "discard" as const },
                  ],
            };
          },
        ),
      };
    },
    async retry(id: string, action: CoreActionReference) {
      const entry = checked(id, action, "persistence-retry");
      try {
        let deadline: number = entry.expires;
        const saved = await claimedDisposition(entry, (preserveProjection) => {
          const admitted = deps.now();
          deadline = Math.min(entry.expires, admitted + 10000);
          if (admitted >= entry.expires) {
            preserveProjection();
            stale();
          }
          if (entry.report.state !== "retryable") stale();
          return async () => {
            if (entry.report.state !== "retryable") stale();
            if (deps.now() >= deadline) {
              preserveProjection();
              stale();
            }
            const result = await deps.retry(
              entry.owner,
              entry.report,
              deadline,
              entry.evidence?.ticket,
            );
            const candidate = { ...entry, report: structuredClone(result) };
            candidate.report.recovery = entry.id;
            for (const record of candidate.report.records)
              if (record.expiresAt !== undefined)
                record.expiresAt = Math.min(
                  record.expiresAt,
                  projectWallExpiry(deps, entry.expires),
                );
            expire(candidate);
            if (candidate.report.blocker) candidate.dispositionFailed = "retry-blocked";
            await persistReplacement(entry, candidate);
            if (!entry.report.blocker) delete entry.dispositionFailed;
            revision++;
            changed();
            return structuredClone(entry.report);
          };
        });
        await deps.retried?.(entry.owner, saved, deadline, entry.evidence?.ticket);
        return saved;
      } finally {
        deps.actions.complete(action);
      }
    },
    async discard(id: string, action: CoreActionReference) {
      const entry = checked(id, action, "persistence-discard");
      try {
        const result = await claimedDisposition(entry, () => async () => {
          if (entry.restartRequired) {
            failed(entry, "action");
            return { report: structuredClone(entry.report), ticket: null };
          }
          if (exporting.has(id) || (await reconcileExport(id))?.disposition === "unknown") {
            failed(entry, "action");
            return {
              report: { ...entry.report, state: "uncertain" as const, blocker: true },
              ticket: null,
            };
          }
          const ticket =
            entry.evidence?.ticket ??
            (await deps.backend.evidence.loadRecovery(id))?.ticket ??
            null;
          const report = await deps.discard(entry.owner, entry.report, ticket);
          report.recovery = id;
          // Unknown dispatch remains a blocker even after a user's discard request.
          revision++;
          if (!report.blocker) {
            await deps.backend.evidence.removeRecovery(id);
            entries.delete(id);
            refusals.delete(id);
            releaseIdentity(entry.owner, id);
            deps.retired?.(entry.owner, report, ticket);
            changed();
          } else {
            const candidate: Entry = { ...entry, report, dispositionFailed: "action" };
            await persistReplacement(entry, candidate);
            changed();
          }
          return { report: structuredClone(report), ticket };
        });
        if (!result.report.blocker)
          await deps.discarded?.(entry.owner, result.report, result.ticket);
        return result.report;
      } finally {
        deps.actions.complete(action);
      }
    },
    async restore() {
      let cursor: Handle | undefined;
      do {
        const page = await deps.backend.evidence.recoveryPage(cursor);
        for (const stored of page.items) {
          // T2 validates format, payload pins and unknown tickets before this page is returned.
          const entry: Entry = {
            id: stored.id,
            owner: stored.owner,
            report: structuredClone(stored.report),
            expires:
              stored.expiresAt === null
                ? Infinity
                : deps.now() + Math.max(0, stored.expiresAt - deps.wall()),
            actionIds: { retry: randomUUID(), export: randomUUID(), discard: randomUUID() },
          };
          entries.set(entry.id, entry);
          expire(entry);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      revision++;
      changed();
    },
    async export(input: { recovery: Handle; action: CoreActionReference }): Promise<
      PersistenceResult<{
        disposition: "not-committed" | "committed" | "unknown";
      }>
    > {
      const { recovery: id, action } = input;
      const entry = checked(id, action, "persistence-export");
      if (exporting.has(id)) {
        deps.actions.complete(action);
        stale();
      }
      exporting.add(id);
      if (exports.has(id)) {
        try {
          const result = await reconcileExport(id);
          return { ok: true, value: { disposition: result!.disposition } };
        } finally {
          exporting.delete(id);
          deps.actions.complete(action);
        }
      }
      const backend = deps.backend;
      let pinOwner = entry.owner;
      let pin: Handle | undefined,
        closePin = false,
        destination: ExportDestination | null = null;
      const job = randomUUID(),
        control = new AbortController(),
        deadline = deps.now() + 120000;
      const timer = setTimeout(() => control.abort(), 120000);
      let outcome: ExportOutcome = { disposition: "not-committed" };
      let begun = false;
      try {
        const stored = await backend.evidence.loadRecovery(id);
        if (!stored) stale();
        const current = deps.coreOwner({ sourceKey: stored.owner.sourceKey, scope: action.scope });
        if (
          !current ||
          current.sourceKey !== stored.owner.sourceKey ||
          current.pluginId !== stored.owner.pluginId ||
          current.hostEpoch !== action.scope.hostEpoch
        )
          stale();
        const record = stored.report.records.find(
          (r) => r.payload === "complete-staging" || r.committedRevision !== null,
        );
        if (!record) stale();
        let bytes: number, digest: string;
        if (
          record.payload === "complete-staging" &&
          stored.sealedPin &&
          stored.ticket?.metadata.kind === "record" &&
          stored.expiresAt !== null &&
          deps.wall() < stored.expiresAt
        ) {
          // A transient sealed pin remains bound to its exact historical owner.
          if (stored.owner.hostEpoch !== current.hostEpoch) stale();
          pin = stored.sealedPin;
          bytes = stored.ticket.metadata.record.byteLength;
          digest = stored.ticket.metadata.record.sha256;
        } else {
          if (!record.committedRevision) stale();
          const meta = await backend.reads.stat(current, record.id);
          if (meta.revision !== record.committedRevision) stale();
          pin = await backend.reads.open(current, record.id, record.committedRevision);
          pinOwner = current;
          closePin = true;
          bytes = meta.byteLength;
          digest = meta.sha256;
        }
        destination = await deps.adapter.chooseDestination(
          action.actionToken,
          "recovery.bin",
          control.signal,
        );
        if (!destination) return { ok: true, value: outcome };
        if (
          control.signal.aborted ||
          deps.now() >= deadline ||
          !deps.actions.isClaimed(action, { kind: "persistence-export", recovery: id })
        )
          stale();
        begun = true;
        await backend.output.begin(job, current, destination, bytes, digest, deadline);
        for (let offset = 0; offset < bytes;) {
          if (
            control.signal.aborted ||
            deps.now() >= deadline ||
            !deps.actions.isClaimed(action, { kind: "persistence-export", recovery: id })
          )
            stale();
          const chunk = await backend.reads.read(
            pinOwner,
            pin!,
            offset,
            Math.min(262144, bytes - offset),
          );
          if (!chunk.length) throw new Error("Incomplete retained payload.");
          const written = (await backend.output.append(job, offset, chunk)) - offset;
          if (written <= 0 || written > chunk.length) throw new Error("Invalid output progress.");
          offset += written;
        }
        outcome = await backend.output.commit(job);
        if (outcome.disposition === "unknown") outcome = await backend.output.reconcile(job);
        return { ok: true, value: { disposition: outcome.disposition } };
      } catch {
        const aborted = begun
          ? await backend.output.abort(job).catch(() => "unknown" as const)
          : "aborted";
        outcome = { disposition: aborted === "aborted" ? "not-committed" : aborted };
        return { ok: true, value: { disposition: outcome.disposition } };
      } finally {
        clearTimeout(timer);
        exporting.delete(id);
        if (outcome.disposition === "unknown")
          exports.set(id, { job, owner: pinOwner, pin, closePin, destination });
        if (outcome.disposition !== "unknown" && closePin && pin)
          await backend.reads.close(pinOwner, pin);
        // Unknown jobs retain destination identity and are reconciled using their original job ID.
        if (destination && outcome.disposition !== "unknown")
          await backend.destinations.release(destination);
        deps.actions.complete(action);
      }
    },
    snapshot: () => api.recoverySnapshot(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return api;
}
