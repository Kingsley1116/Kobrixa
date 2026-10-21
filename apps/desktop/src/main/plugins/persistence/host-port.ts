import { createHash, randomUUID } from "node:crypto";
import { createBoundSettingsService, settingsRequests } from "./settings-service.js";
import { createPersistenceRecovery } from "./recovery-port.js";
import { createPersistenceLifecycle } from "./lifecycle.js";
import { createRecordService } from "./record-service.js";
import { createPersistenceActions } from "./actions.js";
import { ownerKey, PersistenceFault, limit } from "./record-port.js";
import { checkpointRecoveryId, type PublicationTicket } from "./engine-port.js";
import { settingsRequestSchemas } from "../../../../../../packages/plugin-protocol/src/settings.js";
import { storageRequestSchemas } from "../../../../../../packages/plugin-protocol/src/storage.js";
import { persistenceActionRequestSchemas } from "../../../../../../packages/plugin-protocol/src/persistence-actions.js";
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type {
  Permission,
  SettingsRequestMap,
  StorageRequestMap,
  PersistenceActionRequestMap,
} from "@kobrixa/plugin-protocol";
import type {
  Principal,
  ProfileWriterLock,
  ReservationBindingPort,
  UserPersistenceActionPort,
  CoreActionValidationPort,
  PersistenceParticipant,
} from "@kobrixa/plugin-runtime";
import type { PersistenceBackend } from "./engine-port.js";
import type { PersistenceActionAdapter } from "./actions.js";
import type {
  ResourceOwner,
  UiOwner,
  SettingsResourceV1,
  Sha256,
  RecordWrite,
} from "@kobrixa/plugin-protocol";
import type {
  CoreWindowScope,
  BoundSettingsService,
  DrainDispatcher,
} from "@kobrixa/plugin-runtime";
import type { CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
import type { LegacyImportHostPort } from "./import-sources.js";
import type { PersistenceRecoveryHostPort } from "./recovery-port.js";
export type PersistenceRequestMap = SettingsRequestMap &
  StorageRequestMap &
  PersistenceActionRequestMap;
export interface PersistenceHost {
  readonly participant: PersistenceParticipant;
  readonly settings: BoundSettingsService;
  readonly recovery: PersistenceRecoveryHostPort;
  request<M extends keyof PersistenceRequestMap>(
    principal: Principal,
    method: M,
    params: PersistenceRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<PersistenceRequestMap[M]["result"]>;
  dispose(): Promise<void>;
}
export interface PersistenceSourcePort {
  current(owner: ResourceOwner): boolean;
  settings(input: { sourceKey: string; resourceDigest: Sha256 }): Promise<{
    owner: UiOwner;
    resource: SettingsResourceV1;
    validationDigest: Sha256;
  } | null>;
  coreOwner(input: { sourceKey: string; scope: CoreWindowScope }): ResourceOwner | null;
}
export interface PersistenceCompositionInput {
  backend: PersistenceBackend;
  sources: PersistenceSourcePort;
  events: CommonEventLedgerPort;
  dispatchDrain: DrainDispatcher;
  imports: LegacyImportHostPort;
}
function constructServices(input: Parameters<typeof createPersistenceHost>[0]) {
  const { backend, sources, events, dispatchDrain } = input.composition;
  const now = input.now,
    wall = Date.now;
  // T8 publishes these permissions. Keep the F factory signature while using the exact local names.
  const permission = (principal: Principal, value: string) =>
    input.hasPermission(principal, value as Permission);
  const owners = new Map<string, ResourceOwner>(),
    frozen = new Set<string>();
  const drains = new Set<Promise<unknown>>();
  const offers = new Map<string, ReturnType<PersistenceParticipant["freeze"]>>();
  const pending = new Set<Promise<unknown>>(),
    metadata = new Set<Promise<void>>();
  const registrations = new Map<
    string,
    { checkpoint: string; recovery: string; terminalAt?: number }
  >();
  const settledAt = new Map<string, number>();
  const hostLimit = 1024,
    sourceLimit = 64;
  function sweep() {
    for (const [id, at] of settledAt)
      if (now() >= at + 120000) {
        captured.delete(id);
        outcomes.delete(id);
        settledAt.delete(id);
      }
    for (const [id, row] of registrations)
      if (row.terminalAt !== undefined && now() >= row.terminalAt + 120000)
        registrations.delete(id);
  }
  function admitOwner(owner: ResourceOwner) {
    sweep();
    if (owners.has(ownerKey(owner))) return;
    // Lifetime owner identities are bounded and never evicted to reopen a generation.
    if (
      owners.size >= hostLimit ||
      [...owners.values()].filter((o) => o.sourceKey === owner.sourceKey).length >= sourceLimit
    )
      limit();
    owners.set(ownerKey(owner), Object.freeze({ ...owner }));
  }
  const captured = new Map<string, PublicationTicket>(),
    outcomes = new Map<string, string>();
  const schemas = {
    ...settingsRequestSchemas,
    ...storageRequestSchemas,
    ...persistenceActionRequestSchemas,
  };
  const boundSettings = createBoundSettingsService({ backend, sources, events, now });
  const settings = settingsRequests(backend);
  const recovery = createPersistenceRecovery({
    backend,
    adapter: input.actionAdapter,
    actions: input.coreActions,
    coreOwner: sources.coreOwner,
    discarded(owner, report) {
      const ids = report.records.map((r) => r.id);
      lifecycle.retireCheckpoint(owner, ids);
      for (const id of ids) registrations.delete(JSON.stringify([ownerKey(owner), id]));
      // Discard proves only this recovery row's outcome. Other captured tickets on
      // the same target retain their evidence until individually known and swept.
    },
    now,
    wall,
    async retry(_owner, report, deadline) {
      const stored = report.recovery ? await backend.evidence.loadRecovery(report.recovery) : null;
      if (!stored?.ticket) return { ...report, state: "checkpoint-only", blocker: true };
      let result;
      try {
        result = await backend.engine.reconcile(stored.ticket);
        if (
          result.disposition === "not-committed" &&
          stored.sealedPin &&
          stored.expiresAt !== null &&
          wall() < stored.expiresAt &&
          backend.engine.publishRecovery
        )
          result = await backend.engine.publishRecovery(stored.ticket, stored.sealedPin, deadline);
      } catch {
        return { ...report, state: "uncertain", blocker: true };
      }
      if (result.disposition !== "committed" || !result.receipt)
        return {
          ...report,
          state: result.disposition === "unknown" ? "uncertain" : "retryable",
          blocker: true,
        };
      const target =
        stored.ticket.metadata.kind === "record" ? stored.ticket.metadata.record : null;
      const remaining =
        report.pendingSettings || report.records.some((r) => r.id !== target?.id && !r.final);
      const open = target?.checkpoint === "open";
      return {
        ...report,
        state: remaining ? "uncertain" : open ? "checkpoint-only" : "saved",
        blocker: remaining || open,
        records: report.records.map((r) =>
          r.id !== target?.id
            ? r
            : {
                id: r.id,
                committedRevision: result.receipt!.revision,
                final: target.checkpoint === "final",
                payload: "checkpoint-only",
              },
        ),
      };
    },
    async discard(_owner, report) {
      const stored = report.recovery ? await backend.evidence.loadRecovery(report.recovery) : null;
      if (stored?.ticket) {
        const disposition = await backend.engine
          .abort(stored.ticket)
          .catch(() => "unknown" as const);
        if (disposition === "unknown") return { ...report, state: "uncertain", blocker: true };
        if (stored.sealedPin) await backend.reads.close(stored.owner, stored.sealedPin);
      }
      return {
        ...report,
        state: "checkpoint-only",
        blocker: false,
        records: report.records.map((r) => ({
          id: r.id,
          committedRevision: r.committedRevision,
          final: r.final,
          payload: r.committedRevision ? "checkpoint-only" : "none",
        })),
      };
    },
  });
  const lifecycle = createPersistenceLifecycle({
    now,
    wall,
    live: (o) => sources.current(o),
    reservations: input.reservations,
    record: (o, id) => backend.reads.stat(o, id),
    persist(owner, document) {
      const run = (async () => {
        const key = JSON.stringify([ownerKey(owner), document.record.id]);
        let registration = registrations.get(key);
        sweep();
        if (!registration || registration.checkpoint !== document.checkpoint) {
          if (!registration && registrations.size >= hostLimit) limit();
          registration = {
            checkpoint: document.checkpoint,
            recovery: checkpointRecoveryId(document.checkpoint),
          };
          registrations.set(key, registration);
        }
        const value = { ...document, binding: document.binding ?? null };
        if (document.state !== "open" && backend.evidence.saveCheckpoint)
          await backend.evidence.saveCheckpoint(owner, value);
        else {
          const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, ...value }));
          const ticket: PublicationTicket = Object.freeze({
            id: randomUUID(),
            owner: Object.freeze({ ...owner }),
            deadlineMonotonicMs: now() + 10000,
            target: { kind: "recovery" as const, key: document.checkpoint },
            metadata: { kind: "recovery" as const, key: document.checkpoint },
          });
          await backend.engine.reserve(ticket, bytes.length);
          for (let offset = 0; offset < bytes.length;) {
            const chunk = bytes.subarray(offset, offset + 262144),
              next = await backend.engine.append(ticket, offset, chunk);
            if (next <= offset || next > offset + chunk.length)
              throw new Error("Invalid metadata progress");
            offset = next;
          }
          await backend.engine.seal(
            ticket,
            bytes.length,
            createHash("sha256").update(bytes).digest("hex"),
          );
          let result = await backend.engine.publish(ticket);
          if (result.disposition === "unknown") result = await backend.engine.reconcile(ticket);
          if (result.disposition !== "committed")
            throw new Error("Checkpoint registration unavailable");
        }
        // This independent evidence preserves the original owner even for unbound registrations.
        // It is restored into the core registry only after restart or an actual failed drain.
        const final = document.state === "final";
        await backend.evidence.saveRecovery({
          id: registration.recovery,
          owner,
          ticket: null,
          sealedPin: null,
          expiresAt: null,
          report: {
            state: final ? "saved" : "checkpoint-only",
            blocker: !final,
            pendingSettings: false,
            records: [
              {
                id: document.record.id,
                committedRevision: document.record.revision,
                final,
                payload: "checkpoint-only",
              },
            ],
            errors: [],
          },
        });
        if (document.state !== "open") registration.terminalAt = now();
      })();
      metadata.add(run);
      void run.finally(() => metadata.delete(run)).catch(() => {});
      return run;
    },
    fence(o, d) {
      frozen.add(ownerKey(o));
      return backend.engine.fence(o, d);
    },
    fenceTarget: (o, id, d) => backend.engine.fenceTarget(o, id, d),
    pendingWrites: (o) =>
      records
        .admittedWrites(o)
        .filter((w) => ["receiving", "sealed"].includes(w.state))
        .map((w) => ({
          write: w.ticket.id,
          id: w.record.id,
          state: w.state as "receiving" | "sealed",
        })),
    pendingSettings: (o) =>
      [...captured.values()].some(
        (t) =>
          ownerKey(t.owner) === ownerKey(o) &&
          t.target.kind === "settings" &&
          outcomes.get(t.id) !== "committed",
      ),
    async settle(ids, _deadline) {
      await records.settle(ids);
      for (const id of ids) {
        const projection = records.admittedWrites().find((w) => w.ticket.id === id);
        if (projection) await projection.pending.catch(() => {});
        const ticket = captured.get(id) ?? projection?.ticket;
        if (ticket) {
          try {
            const disposition = (await backend.engine.reconcile(ticket)).disposition;
            outcomes.set(id, disposition);
            if (disposition === "committed") settledAt.set(id, settledAt.get(id) ?? now());
          } catch {
            outcomes.set(id, "unknown");
          }
        }
      }
    },
    evidence: {
      ...backend.evidence,
      capture(scope, deadline) {
        sweep();
        const barrier = (backend.evidence.captureDrain ?? backend.evidence.capture)(
          scope,
          deadline,
        );
        const tickets = backend.evidence.tickets(barrier);
        const additional = tickets.filter((t) => !captured.has(t.id));
        if (captured.size + additional.length > hostLimit) limit();
        for (const ticket of additional) captured.set(ticket.id, ticket);
        return barrier;
      },
    },
    reads: backend.reads,
    payload(o, id) {
      const write = records
        .admittedWrites(o)
        .find(
          (w) =>
            w.record.id === id &&
            w.retained &&
            w.state === "sealed" &&
            now() < w.retained.expiresMonotonicMs,
        );
      return write?.retained
        ? { kind: "complete-staging", expiresMonotonicMs: write.retained.expiresMonotonicMs }
        : { kind: "checkpoint-only" };
    },
    async recover(owner, report) {
      // StoredRecovery owns one immutable ticket/pin. Multi-target drains retain one row per target.
      const admissions = records.admittedWrites(owner);
      const missing = admissions.filter(
        (w) => w.state === "publishing" && !report.records.some((r) => r.id === w.record.id),
      );
      if (missing.length)
        report = {
          ...report,
          state: "uncertain",
          blocker: true,
          records: [
            ...report.records,
            ...missing.map((w) => ({
              id: w.record.id,
              committedRevision:
                w.input.target.mode === "replace" ? w.input.target.expectedRevision : null,
              final: false,
              payload:
                w.input.target.mode === "replace"
                  ? ("checkpoint-only" as const)
                  : ("none" as const),
            })),
          ],
        };
      const items = report.records.length ? report.records : [null];
      let first: string | undefined;
      for (const item of items) {
        const write = item
          ? admissions.find(
              (w) =>
                w.record.id === item.id && ["sealed", "publishing", "receiving"].includes(w.state),
            )
          : undefined;
        const identity = item
          ? registrations.get(JSON.stringify([ownerKey(owner), item.id]))?.recovery
          : undefined;
        const retained = await recovery.retain(
          owner,
          { ...report, records: item ? [item] : [], ...(identity ? { recovery: identity } : {}) },
          write
            ? {
                ticket: write.ticket,
                sealedPin:
                  write.retained && now() < write.retained.expiresMonotonicMs
                    ? write.retained.pin
                    : null,
              }
            : undefined,
        );
        first ??= retained.recovery;
        if (retained.state === "uncertain")
          report = { ...report, state: "uncertain", blocker: true };
      }
      for (const ticket of captured.values())
        if (
          ownerKey(ticket.owner) === ownerKey(owner) &&
          ticket.target.kind !== "record" &&
          outcomes.get(ticket.id) !== "committed" &&
          report.pendingSettings
        ) {
          const retained = await recovery.retain(
            owner,
            { ...report, records: [], recovery: ticket.id },
            { ticket, sealedPin: null },
          );
          first ??= retained.recovery;
        }
      return { ...report, ...(first ? { recovery: first } : {}) };
    },
    checkpointOpen: (o, id) =>
      records
        .admittedWrites(o)
        .some((w) => w.record.id === id && ["receiving", "sealed", "publishing"].includes(w.state)),
    recovery,
  });
  // T2 returns the cumulative received offset; T4 consumes a short-write byte count.
  const records = createRecordService({
    engine: {
      ...backend.engine,
      append: async (t, offset, bytes) => (await backend.engine.append(t, offset, bytes)) - offset,
    },
    read: backend.reads,
    evidence: backend.evidence,
    live: (o) => sources.current(o),
    permission,
    now,
    wall,
    checkpoint: lifecycle,
    retainForRecovery: true,
  });
  const actions = createPersistenceActions({
    output: backend.output,
    destinations: backend.destinations,
    actions: input.actions,
    adapter: input.actionAdapter,
    live: (o) => sources.current(o),
    permission,
    now,
    wall,
  });
  function trackDrain<T>(operation: Promise<T>): Promise<T> {
    drains.add(operation);
    void operation.finally(() => drains.delete(operation)).catch(() => {});
    return operation;
  }
  const participant: PersistenceParticipant = {
    freeze(owner, reason, deadline, grant) {
      admitOwner(owner);
      const offer = lifecycle.participant.freeze(owner, reason, deadline, grant);
      offers.set(ownerKey(owner), offer);
      return offer;
    },
    endReservation(event, deadline) {
      admitOwner(event.owner);
      const offer = lifecycle.participant.endReservation(event, deadline);
      if (offer) offers.set(ownerKey(event.owner), offer);
      return offer;
    },
    drain: (offer, dispatch) => trackDrain(lifecycle.participant.drain(offer, dispatch)),
    ownerLost: (owner) => {
      admitOwner(owner);
      frozen.add(ownerKey(owner));
      return trackDrain(lifecycle.participant.ownerLost(owner));
    },
    recoverySnapshot: () => lifecycle.participant.recoverySnapshot(),
    retry: (id, action) => trackDrain(lifecycle.participant.retry(id, action)),
    discard: (id, action) => trackDrain(lifecycle.participant.discard(id, action)),
  };
  const recoveryPort: PersistenceRecoveryHostPort = {
    snapshot: recovery.snapshot,
    subscribe: recovery.subscribe,
    export: (request) => trackDrain(recovery.export(request)),
  };
  return {
    boundSettings,
    settings,
    records,
    actions,
    recovery: { ...recovery, ...recoveryPort },
    participant,
    live: (principal: Principal) =>
      principal.kind === "plugin" &&
      sources.current(principal.owner) &&
      !frozen.has(ownerKey(principal.owner)),
    validate(method: keyof PersistenceRequestMap, params: unknown) {
      if (!schemas[method].params.safeParse(params).success)
        throw new RpcError(RPC_ERRORS.invalidParams, "Invalid persistence parameters.");
    },
    admit(principal: Principal) {
      if (principal.kind === "plugin") admitOwner(principal.owner);
    },
    closingRequest(
      principal: Principal,
      method: keyof PersistenceRequestMap,
      params: PersistenceRequestMap[keyof PersistenceRequestMap]["params"],
    ): boolean {
      if (principal.kind !== "plugin") return false;
      try {
        if (method === "storage/beginWrite" && "drainToken" in params && params.drainToken) {
          const input = params as StorageRequestMap["storage/beginWrite"]["params"];
          const { checkpoint, drainToken, ...base } = input;
          const write: RecordWrite = {
            ...base,
            ...(checkpoint ? { checkpoint } : {}),
            ...(drainToken ? { drainToken } : {}),
          };
          return !!lifecycle.finalGrant(principal.owner, write);
        }
        if (
          ![
            "storage/writeChunk",
            "storage/sealWrite",
            "storage/commitWrite",
            "storage/writeStatus",
            "storage/abortWrite",
          ].includes(method) ||
          !("write" in params)
        )
          return false;
        const write = records
          .admittedWrites(principal.owner)
          .find((w) => w.ticket.id === params.write);
        if (!write) return false;
        if (method === "storage/writeStatus" || method === "storage/abortWrite") return true;
        return !!write.input.drainToken && !!lifecycle.finalGrant(principal.owner, write.input);
      } catch {
        return false;
      }
    },
    track(_principal: Principal, operation: Promise<unknown>) {
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => {});
    },
    async dispose() {
      const closingSettings = settings.dispose();
      for (const owner of owners.values()) {
        actions.retire(owner);
        if (!frozen.has(ownerKey(owner))) participant.freeze(owner, "shutdown", now() + 10000);
      }
      await Promise.all(
        [...offers.values()].map((offer) => participant.drain(offer, dispatchDrain)),
      );
      await Promise.allSettled([...drains]);
      while (pending.size || metadata.size) await Promise.allSettled([...pending, ...metadata]);
      await closingSettings;
      await actions.dispose();
      await records.close();
    },
  };
}

export async function createPersistenceHost(input: {
  profile: ProfileWriterLock;
  composition: PersistenceCompositionInput;
  reservations: ReservationBindingPort;
  actions: UserPersistenceActionPort;
  actionAdapter: PersistenceActionAdapter;
  coreActions: CoreActionValidationPort;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
}): Promise<PersistenceHost> {
  input.profile.assertHeld();
  if (!input.composition) throw new TypeError("Incomplete persistence composition.");
  const { backend, sources, events, dispatchDrain, imports } = input.composition;
  if (!backend || !sources || !events || !dispatchDrain || !imports) {
    if (backend) await backend.dispose();
    throw new TypeError("Incomplete persistence composition.");
  }
  let services!: ReturnType<typeof constructServices>;
  try {
    services = constructServices(input);
    await services.recovery.restore();
  } catch (error) {
    try {
      if (services) await services.dispose();
    } finally {
      await backend.dispose();
    }
    throw error;
  }
  let disposed = false,
    closed = false,
    pending = 0,
    bytes = 0;
  let disposal: Promise<void> | undefined;
  const counts = new Map<string, { pending: number; bytes: number }>();
  const controllers = new Set<AbortController>();
  const readMethods = new Set([
    "settings/read",
    "settings/watch",
    "settings/readMigration",
    "storage/stat",
    "storage/list",
    "storage/openRead",
    "storage/readChunk",
    "storage/closeRead",
  ]);
  function required(method: string): string {
    if (method === "ui/copyText") return "ui.clipboard";
    if (method.startsWith("storage/export")) return "storage.export";
    return method.startsWith("settings/")
      ? readMethods.has(method)
        ? "settings.read"
        : "settings.write"
      : readMethods.has(method)
        ? "storage.read"
        : "storage.write";
  }
  async function dispatch<M extends keyof PersistenceRequestMap>(
    principal: Principal,
    method: M,
    params: PersistenceRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<PersistenceRequestMap[M]["result"]> {
    // The branch predicates are a finite method-name partition, not a generic RPC tunnel.
    if (method.startsWith("settings/"))
      return services.settings.request(
        principal,
        method as keyof SettingsRequestMap,
        params as SettingsRequestMap[keyof SettingsRequestMap]["params"],
        signal,
      ) as Promise<PersistenceRequestMap[M]["result"]>;
    if (method === "ui/copyText" || method.startsWith("storage/export"))
      return services.actions.request(
        principal,
        method as keyof PersistenceActionRequestMap,
        params as PersistenceActionRequestMap[keyof PersistenceActionRequestMap]["params"],
        signal,
      ) as Promise<PersistenceRequestMap[M]["result"]>;
    return services.records.request(
      principal,
      method as keyof StorageRequestMap,
      params as StorageRequestMap[keyof StorageRequestMap]["params"],
      signal,
    ) as Promise<PersistenceRequestMap[M]["result"]>;
  }
  return {
    participant: services.participant,
    settings: services.boundSettings,
    recovery: services.recovery,
    async request<M extends keyof PersistenceRequestMap>(
      principal: Principal,
      method: M,
      params: PersistenceRequestMap[M]["params"],
      signal: AbortSignal,
    ): Promise<PersistenceRequestMap[M]["result"]> {
      input.profile.assertHeld();
      if (method === "storage/drain")
        throw new RpcError(RPC_ERRORS.methodNotFound, "Host-only method direction.");
      if (closed)
        return {
          ok: false,
          error: { code: "PLUGIN_E_SHUTTING_DOWN", message: "Host is closing." },
        };
      if (
        !input.hasPermission(principal, required(method) as Permission) &&
        !(
          method === "storage/quota" && input.hasPermission(principal, "storage.read" as Permission)
        )
      )
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "Permission required.",
            detail: { kind: "permission", reason: "permission" },
          },
        };
      const cleanup =
        method === "storage/writeStatus" ||
        method === "storage/abortWrite" ||
        ("drainToken" in params && typeof params.drainToken === "string") ||
        method === "storage/writeChunk" ||
        method === "storage/sealWrite";
      if (!services.live(principal) && !cleanup)
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_STALE_RESOURCE",
            message: "Retired owner.",
            detail: { kind: "resource", reason: "stale", resource: "rpc" },
          },
        };
      services.validate(method, params);
      if (disposed && !services.closingRequest(principal, method, params))
        return {
          ok: false,
          error: { code: "PLUGIN_E_SHUTTING_DOWN", message: "Host is closing." },
        };
      try {
        services.admit(principal);
      } catch (error) {
        if (error instanceof PersistenceFault) return error.result;
        throw error;
      }
      const size = Buffer.byteLength(JSON.stringify(params));
      const key = principal.kind === "plugin" ? principal.owner.sourceKey : "core";
      const source = counts.get(key) ?? { pending: 0, bytes: 0 };
      if (
        pending >= 32 ||
        source.pending >= 16 ||
        bytes + size > 8388608 ||
        source.bytes + size > 1048576
      )
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_RESOURCE_LIMIT",
            message: "Persistence queue full.",
            detail: { kind: "resource", reason: "queue", resource: "rpc" },
          },
        };
      counts.set(key, source);
      pending++;
      bytes += size;
      source.pending++;
      source.bytes += size;
      const control = new AbortController();
      controllers.add(control);
      const cancel = () => control.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<PersistenceRequestMap[M]["result"]>((resolve) => {
        timer = setTimeout(() => {
          control.abort();
          resolve({
            ok: false,
            error: {
              code: "PLUGIN_E_TIMEOUT",
              message: "Persistence request timed out; query its original identity.",
            },
          } as PersistenceRequestMap[M]["result"]);
        }, 10000);
      });
      const operation = dispatch(principal, method, params, control.signal).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        controllers.delete(control);
        pending--;
        bytes -= size;
        source.pending--;
        source.bytes -= size;
        if (!source.pending) counts.delete(key);
      });
      services.track(principal, operation);
      return Promise.race([operation, timeout]);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      for (const controller of controllers) controller.abort();
      disposal = (async () => {
        input.profile.assertHeld();
        try {
          await services.dispose();
        } finally {
          closed = true;
          await backend.dispose();
        }
        input.profile.assertHeld();
      })();
      return disposal;
    },
  };
}
