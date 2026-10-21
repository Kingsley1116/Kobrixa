import { randomUUID } from "node:crypto";
import type { ResourceOwner, Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { PersistenceBackend, StoredRecovery } from "./engine-port.js";
import type { PersistenceActionAdapter, ExportDestination } from "./actions.js";
import type { ExportOutcome } from "./engine-port.js";
import type {
  CoreWindowScope,
  CoreActionReference,
  CoreActionValidationPort,
  DrainReport,
  PersistenceRecoverySnapshot,
} from "@kobrixa/plugin-runtime";
import { PersistenceFault, ownerKey, limit, stale } from "./record-port.js";
type Dependencies = {
  now(): number;
  wall(): number;
  actions: CoreActionValidationPort;
  retry(owner: ResourceOwner, report: DrainReport, deadline: number): Promise<DrainReport>;
  discard(owner: ResourceOwner, report: DrainReport): Promise<DrainReport>;
  backend: PersistenceBackend;
  adapter: PersistenceActionAdapter;
  coreOwner(input: { sourceKey: string; scope: CoreWindowScope }): ResourceOwner | null;
  discarded?(owner: ResourceOwner, report: DrainReport): void;
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
  actionIds: { retry: string; export: string; discard: string };
  evidence?: Pick<StoredRecovery, "ticket" | "sealedPin">;
};
export function createPersistenceRecovery(deps: Dependencies) {
  const entries = new Map<string, Entry>();
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
      expiresAt: Number.isFinite(entry.expires) ? deps.wall() + entry.expires - deps.now() : null,
    });
    changed();
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
    const entry = entries.get(id);
    if (!entry) stale();
    expire(entry);
    if (!deps.actions.claim(action, { kind, recovery: id }))
      throw new PersistenceFault("PLUGIN_E_PERMISSION_DENIED");
    return entry;
  }
  const api = {
    async retain(
      owner: ResourceOwner,
      report: DrainReport,
      evidence?: Pick<StoredRecovery, "ticket" | "sealedPin">,
    ): Promise<DrainReport> {
      const existing = report.recovery
        ? entries.get(report.recovery)
        : [...entries.values()].find(
            (entry) =>
              ownerKey(entry.owner) === ownerKey(owner) &&
              entry.report.records[0]?.id === report.records[0]?.id,
          );
      const size = Buffer.byteLength(JSON.stringify(report));
      if (report.records.length > 2 || report.errors.length > 16 || size > 8192) limit();
      const retained = [...entries.values()].filter((entry) => entry !== existing);
      if (
        retained.reduce(
          (total, entry) => total + Buffer.byteLength(JSON.stringify(entry.report)),
          size,
        ) > 67108864 ||
        retained
          .filter((entry) => entry.owner.sourceKey === owner.sourceKey)
          .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.report)), size) >
          4194304
      )
        limit();
      const expires = Math.min(
        ...report.records.map((r) =>
          r.expiresAt === undefined
            ? Infinity
            : deps.now() + Math.max(0, r.expiresAt - deps.wall()),
        ),
      );
      const entry: Entry = existing ?? {
        id: report.recovery ?? randomUUID(),
        owner: { ...owner },
        report,
        expires,
        actionIds: { retry: randomUUID(), export: randomUUID(), discard: randomUUID() },
      };
      if (evidence) entry.evidence = structuredClone(evidence);
      entry.expires = Math.min(entry.expires, expires);
      entry.report = structuredClone(report);
      entry.report.recovery = entry.id;
      for (const record of entry.report.records)
        if (record.expiresAt !== undefined)
          record.expiresAt = Math.min(record.expiresAt, deps.wall() + entry.expires - deps.now());
      if (entry.report.state === "retryable") entry.report.retryAction = entry.actionIds.retry;
      entries.set(entry.id, entry);
      revision++;
      await persist(entry).catch(() => {
        entry.report.state = "uncertain";
        entry.report.blocker = true;
        revision++;
      });
      return structuredClone(entry.report);
    },
    recoverySnapshot(): PersistenceRecoverySnapshot {
      for (const entry of entries.values()) expire(entry);
      return {
        revision,
        items: [...entries.values()].map((entry) => {
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
              ? { expiresAt: deps.wall() + entry.expires - deps.now() }
              : {}),
            actions: [
              ...(entry.report.state === "retryable"
                ? [{ id: entry.actionIds.retry, kind: "retry" as const }]
                : []),
              ...(payload !== "none"
                ? [{ id: entry.actionIds.export, kind: "export" as const }]
                : []),
              { id: entry.actionIds.discard, kind: "discard" as const },
            ],
          };
        }),
      };
    },
    async retry(id: string, action: CoreActionReference) {
      const entry = checked(id, action, "persistence-retry");
      try {
        if (entry.report.state !== "retryable" || deps.now() >= entry.expires) stale();
        const result = await deps.retry(
          entry.owner,
          entry.report,
          Math.min(entry.expires, deps.now() + 10000),
        );
        entry.report = structuredClone(result);
        entry.report.recovery = entry.id;
        for (const record of entry.report.records)
          if (record.expiresAt !== undefined)
            record.expiresAt = Math.min(record.expiresAt, deps.wall() + entry.expires - deps.now());
        expire(entry);
        revision++;
        await persist(entry);
        return structuredClone(entry.report);
      } finally {
        deps.actions.complete(action);
      }
    },
    async discard(id: string, action: CoreActionReference) {
      const entry = checked(id, action, "persistence-discard");
      try {
        if (exporting.has(id) || (await reconcileExport(id))?.disposition === "unknown")
          return { ...entry.report, state: "uncertain" as const, blocker: true };
        const report = await deps.discard(entry.owner, entry.report);
        // Unknown dispatch remains a blocker even after a user's discard request.
        entry.report = report;
        revision++;
        if (!report.blocker) {
          await deps.backend.evidence.removeRecovery(id);
          entries.delete(id);
          deps.discarded?.(entry.owner, report);
          changed();
        } else await persist(entry);
        return structuredClone(report);
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
