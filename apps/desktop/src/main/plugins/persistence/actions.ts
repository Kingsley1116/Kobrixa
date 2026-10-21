import { randomUUID } from "node:crypto";
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type { Handle, PersistenceActionRequestMap, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { Principal, UserPersistenceActionPort } from "@kobrixa/plugin-runtime";
import { decodeChunk, ownerKey, PersistenceFault, conflict, limit, stale } from "./record-port.js";
declare const exportDestinationBrand: unique symbol;
export type ExportDestination = { readonly [exportDestinationBrand]: true };
export interface PersistenceActionAdapter {
  chooseDestination(
    action: Handle,
    suggestedName: string,
    signal: AbortSignal,
  ): Promise<ExportDestination | null>;
  copyText(action: Handle, text: string): Promise<void>;
}
import type {
  PersistenceOutputPort,
  ExportDestinationRegistry,
  ExportOutcome,
} from "./engine-port.js";
type Outcome = ExportOutcome;
export type ActionDependencies = {
  now(): number;
  wall(): number;
  live(owner: ResourceOwner): boolean;
  permission(principal: Principal, permission: "storage.export" | "ui.clipboard"): boolean;
  actions: UserPersistenceActionPort;
  adapter: PersistenceActionAdapter;
  output: PersistenceOutputPort;
  destinations: ExportDestinationRegistry;
};
type Job = {
  id: Handle;
  owner: ResourceOwner;
  state: "waiting" | "receiving" | "publishing" | "completed" | "cancelled" | "expired" | "failed";
  created: number;
  progress: number;
  deadline: number;
  length: number;
  received: number;
  destination?: ExportDestination;
  beginDispatched?: boolean;
  beginPending?: Promise<void>;
  unsettled: number;
  control: AbortController;
  result?: Outcome;
  last?: { offset: number; data: string; expiresAt: number };
  error?: { code: "PLUGIN_E_STORAGE_IO"; message: string };
  pending: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
};
export function createPersistenceActions(deps: ActionDependencies) {
  const jobs = new Map<string, Job>();
  const cleanup = new Set<Promise<unknown>>();
  let disposed = false;
  function abortKnown(job: Job) {
    job.unsettled++;
    return performAbort(job).finally(() => job.unsettled--);
  }
  async function performAbort(job: Job) {
    const disposition = job.beginDispatched
      ? await deps.output.abort(job.id).catch(() => "unknown" as const)
      : "aborted";
    if (disposition === "unknown") {
      job.state = "publishing";
      job.result = { disposition: "unknown" };
    } else if (disposition === "committed") {
      job.state = "completed";
      job.result = await deps.output.reconcile(job.id).catch(() => ({ disposition: "unknown" }));
      if (job.result.disposition === "unknown") {
        job.state = "publishing";
        return "unknown";
      }
    } else if (job.state === "publishing") {
      job.state = "cancelled";
      job.result = { disposition: "not-committed" };
    }
    if (disposition !== "unknown" && job.destination) {
      const destination = job.destination;
      delete job.destination;
      await deps.destinations.release(destination);
    }
    return disposition;
  }
  function stop(job: Job) {
    job.control.abort();
    clearTimeout(job.timer);
    const operation = abortKnown(job);
    cleanup.add(operation);
    void operation.finally(() => cleanup.delete(operation)).catch(() => {});
  }
  async function releaseKnown(job: Job) {
    if (!job.destination || !job.result || job.result.disposition === "unknown") return;
    const destination = job.destination;
    delete job.destination;
    await deps.destinations.release(destination);
  }
  const active = (job: Job) => ["waiting", "receiving", "publishing"].includes(job.state);
  const expires = (job: Job) =>
    job.state === "waiting" ? job.deadline : Math.min(job.deadline, job.progress + 30000);
  const wallExpiry = (job: Job) => Math.max(0, deps.wall() + expires(job) - deps.now());
  function gate(job: Job) {
    if (
      disposed ||
      !deps.live(job.owner) ||
      deps.now() >= expires(job) ||
      job.control.signal.aborted
    ) {
      if (job.state !== "publishing" && job.state !== "completed") job.state = "expired";
      job.control.abort();
      stale("storage-export");
    }
  }
  function arm(job: Job) {
    clearTimeout(job.timer);
    if (!active(job) || job.state === "publishing") return;
    job.timer = setTimeout(
      () => {
        try {
          gate(job);
          arm(job);
        } catch {
          stop(job);
        }
      },
      Math.max(0, expires(job) - deps.now()),
    );
    job.timer.unref();
  }
  const get = (owner: ResourceOwner, id: string) => {
    const job = jobs.get(id);
    if (!job || ownerKey(job.owner) !== ownerKey(owner)) stale("storage-export");
    return job;
  };
  const safeName = (name: string, media: string) => {
    if (
      /[\uD800-\uDFFF]/u.test(name) ||
      !name.length ||
      [...name].length > 80 ||
      Buffer.byteLength(name) > 320 ||
      /[\\/:\p{Cc}]/u.test(name) ||
      /^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    )
      throw new RpcError(RPC_ERRORS.invalidParams, "Invalid suggested name.");
    const ext =
      media === "application/json"
        ? "json"
        : media === "text/plain"
          ? "txt"
          : media === "text/csv"
            ? "csv"
            : "bin";
    const base = name.replace(/[. ]+$/u, "").replace(/\.[^.]+$/u, "");
    if (!base.trim()) throw new RpcError(RPC_ERRORS.invalidParams, "Invalid suggested name.");
    return `${base}.${ext}`;
  };
  type Handlers = {
    [M in keyof PersistenceActionRequestMap]: (
      owner: ResourceOwner,
      p: PersistenceActionRequestMap[M]["params"],
      signal: AbortSignal,
    ) => Promise<PersistenceActionRequestMap[M]["result"]>;
  };
  const handlers: Handlers = {
    "ui/copyText": async (owner, p, signal) => {
      if (
        /[\uD800-\uDFFF]/u.test(p.text) ||
        p.text.includes("\0") ||
        [...p.text].length > 16384 ||
        Buffer.byteLength(p.text) > 65536
      )
        throw new RpcError(RPC_ERRORS.invalidParams, "Invalid text size or encoding.");
      if (signal.aborted || !deps.live(owner)) stale("storage-export");
      const claim = deps.actions.claim({ owner, actionRef: p.actionRef }, "ui.clipboard");
      if (!claim.ok) return claim;
      try {
        await deps.adapter.copyText(claim.value.action, p.text);
      } catch {
        throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "clipboard-unavailable");
      }
      return { ok: true, value: { copied: true } };
    },
    "storage/exportBegin": async (owner, p, signal) => {
      const name = safeName(p.suggestedName, p.mediaType);
      if (p.byteLength < 0 || p.byteLength > 8388608 || !Number.isSafeInteger(p.byteLength))
        throw new RpcError(RPC_ERRORS.invalidParams, "Invalid export length.");
      if (signal.aborted || !deps.live(owner)) stale("storage-export");
      for (const job of jobs.values())
        if (active(job) && job.state !== "publishing") {
          try {
            gate(job);
          } catch {
            stop(job);
          }
        }
      const running = [...jobs.values()].filter((job) => active(job) || job.unsettled > 0);
      if (
        running.length >= 4 ||
        running.some((j) => j.owner.sourceKey === owner.sourceKey) ||
        jobs.size >= 1024 ||
        [...jobs.values()].filter((j) => j.owner.sourceKey === owner.sourceKey).length >= 64
      )
        limit("storage-export");
      const claim = deps.actions.claim({ owner, actionRef: p.actionRef }, "storage.export");
      if (!claim.ok) return claim;
      const now = deps.now(),
        id = randomUUID();
      const job: Job = {
        id,
        owner: { ...owner },
        state: "waiting",
        created: now,
        progress: now,
        deadline: now + 120000,
        length: p.byteLength,
        received: 0,
        control: new AbortController(),
        pending: Promise.resolve(),
        unsettled: 0,
      };
      jobs.set(id, job);
      arm(job);
      void deps.adapter
        .chooseDestination(claim.value.action, name, job.control.signal)
        .then(async (destination) => {
          if (destination) job.destination = destination;
          gate(job);
          if (!destination) {
            job.state = "cancelled";
            clearTimeout(job.timer);
            return;
          }
          job.progress = deps.now(); // Preserve the registered destination’s original deadline.
          job.beginDispatched = true;
          // Track dispatched I/O independently of the native dialog, which may return late.
          job.unsettled++;
          job.beginPending = (async () => {
            try {
              await deps.output.begin(id, owner, destination, p.byteLength, p.sha256, job.deadline);
              gate(job);
              job.state = "receiving";
              arm(job);
            } catch {
              clearTimeout(job.timer);
              if (job.state !== "expired" && job.state !== "cancelled") job.state = "failed";
              job.error = { code: "PLUGIN_E_STORAGE_IO", message: "Export unavailable." };
              await abortKnown(job);
            } finally {
              job.unsettled--;
            }
          })();
          await job.beginPending;
        })
        .catch(async () => {
          clearTimeout(job.timer);
          if (job.state !== "expired" && job.state !== "cancelled") {
            job.state = "failed";
            job.error = { code: "PLUGIN_E_STORAGE_IO", message: "Export unavailable." };
          }
          await abortKnown(job);
        });
      return { ok: true, value: { export: id, state: "waiting", expiresAt: wallExpiry(job) } };
    },
    "storage/exportChunk": async (owner, p) => {
      const job = get(owner, p.export);
      gate(job);
      if (job.state !== "receiving") conflict("export-not-ready");
      if (job.last?.offset === p.offset && job.last.data === p.data)
        return { ok: true, value: { receivedBytes: job.received, expiresAt: job.last.expiresAt } };
      if (p.offset !== job.received) conflict("offset-mismatch");
      const bytes = decodeChunk(p.data);
      if (job.received + bytes.length > job.length) conflict("incomplete");
      let offset = 0;
      while (offset < bytes.length) {
        gate(job);
        const written =
          (await deps.output.append(job.id, job.received + offset, bytes.subarray(offset))) -
          (job.received + offset);
        if (written <= 0 || written > bytes.length - offset)
          throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
        offset += written;
      }
      job.received += bytes.length;
      job.progress = deps.now();
      arm(job);
      const expiresAt = wallExpiry(job);
      job.last = { offset: p.offset, data: p.data, expiresAt };
      return { ok: true, value: { receivedBytes: job.received, expiresAt } };
    },
    "storage/exportCommit": async (owner, p) => {
      const job = get(owner, p.export);
      if (job.state === "publishing") {
        job.result = await deps.output.reconcile(job.id);
        await releaseKnown(job);
      } else if (job.state !== "completed") {
        gate(job);
        if (job.state !== "receiving") conflict("export-not-ready");
        if (job.received !== job.length) conflict("incomplete");
        job.state = "publishing";
        clearTimeout(job.timer);
        try {
          job.result = await deps.output.commit(job.id);
          await releaseKnown(job);
        } catch (error) {
          if (
            error instanceof PersistenceFault &&
            error.result.error.detail?.kind === "persistence" &&
            ["destination-changed", "checksum-mismatch"].includes(error.result.error.detail.reason)
          ) {
            job.state = "failed";
            await abortKnown(job);
            throw error;
          }
          const fault = new PersistenceFault("PLUGIN_E_STORAGE_IO", "publish-uncertain");
          fault.result.error.detail = {
            kind: "persistence",
            reason: "publish-uncertain",
            disposition: "unknown",
          };
          throw fault;
        }
      }
      if (job.result?.disposition === "not-committed") {
        job.state = "receiving";
        arm(job);
        throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
      }
      if (
        job.result?.disposition !== "committed" ||
        !job.result.commitId ||
        !job.result.durability
      ) {
        const fault = new PersistenceFault("PLUGIN_E_STORAGE_IO", "publish-uncertain");
        fault.result.error.detail = {
          kind: "persistence",
          reason: "publish-uncertain",
          disposition: "unknown",
        };
        throw fault;
      }
      job.state = "completed";
      clearTimeout(job.timer);
      return {
        ok: true,
        value: { exported: true, commitId: job.result.commitId, durability: job.result.durability },
      };
    },
    "storage/exportStatus": async (owner, p) => {
      const job = get(owner, p.export);
      if (active(job) && job.state !== "publishing") {
        try {
          gate(job);
        } catch {
          await abortKnown(job);
        }
      }
      if (job.state === "publishing") {
        job.result = await deps.output.reconcile(job.id);
        await releaseKnown(job);
        if (job.result.disposition === "committed") {
          job.state = "completed";
          clearTimeout(job.timer);
        } else if (job.result.disposition === "not-committed") {
          job.state = "failed";
          clearTimeout(job.timer);
        }
      }
      return {
        ok: true,
        value: {
          state: job.state,
          receivedBytes: job.received,
          expiresAt: wallExpiry(job),
          ...(job.result?.commitId ? { commitId: job.result.commitId } : {}),
          ...(job.result?.durability ? { durability: job.result.durability } : {}),
          ...(job.error ? { error: job.error } : {}),
        },
      };
    },
    "storage/exportCancel": async (owner, p) => {
      const job = get(owner, p.export);
      job.control.abort();
      clearTimeout(job.timer);
      const disposition = job.state === "completed" ? "committed" : await deps.output.abort(job.id);
      job.state =
        disposition === "aborted"
          ? "cancelled"
          : disposition === "committed"
            ? "completed"
            : "publishing";
      if (disposition !== "unknown" && job.destination) {
        await deps.destinations.release(job.destination);
        delete job.destination;
      }
      return {
        ok: true,
        value: { disposition, ...(job.result?.commitId ? { commitId: job.result.commitId } : {}) },
      };
    },
  };
  return {
    async request<M extends keyof PersistenceActionRequestMap>(
      principal: Principal,
      method: M,
      params: PersistenceActionRequestMap[M]["params"],
      signal: AbortSignal,
    ): Promise<PersistenceActionRequestMap[M]["result"]> {
      if (disposed)
        return new PersistenceFault("PLUGIN_E_SHUTTING_DOWN")
          .result as PersistenceActionRequestMap[M]["result"];
      if (
        principal.kind !== "plugin" ||
        !deps.permission(principal, method === "ui/copyText" ? "ui.clipboard" : "storage.export")
      )
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "Permission required.",
            detail: { kind: "permission", reason: "permission" },
          },
        } as PersistenceActionRequestMap[M]["result"];
      for (const [id, job] of jobs)
        if (!active(job) && !job.unsettled && deps.now() >= job.deadline + 120000) jobs.delete(id);
      const run = async () => {
        try {
          return await handlers[method](principal.owner, params, signal);
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return error instanceof PersistenceFault
            ? error.result
            : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result;
        }
      };
      if ("export" in params && typeof params.export === "string") {
        const job = jobs.get(params.export);
        if (job) {
          const next = job.pending.catch(() => {}).then(run);
          job.pending = next;
          return next as Promise<PersistenceActionRequestMap[M]["result"]>;
        }
      }
      return run() as Promise<PersistenceActionRequestMap[M]["result"]>;
    },
    async dispose() {
      disposed = true;
      for (const job of jobs.values()) if (active(job)) stop(job);
      await Promise.allSettled(
        [...jobs.values()].flatMap((job) => [job.pending, job.beginPending ?? Promise.resolve()]),
      );
      await Promise.allSettled([...cleanup]);
      for (const job of jobs.values()) if (active(job)) stop(job);
      await Promise.allSettled([...cleanup]);
    },
    retire(owner: ResourceOwner) {
      for (const job of jobs.values())
        if (ownerKey(job.owner) === ownerKey(owner) && active(job)) {
          job.control.abort();
          clearTimeout(job.timer);
          if (job.state !== "publishing") {
            job.state = "expired";
            stop(job);
          }
        }
    },
  };
}
