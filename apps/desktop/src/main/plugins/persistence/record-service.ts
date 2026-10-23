import { wallExpiry as projectWallExpiry } from "./wall-expiry.js";
import type { SealedPayloadPin } from "./engine-port.js";
import { randomUUID } from "node:crypto";
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type {
  RecordMeta,
  RecordWrite,
  ResourceOwner,
  StorageRequestMap,
  WriteProgress,
  Receipt,
  RecordRevision,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { PublicationTicket } from "./engine-port.js";
import {
  PersistenceFault,
  conflict,
  decodeChunk,
  limit,
  ownerKey,
  stale,
  type RecordDependencies,
  type RecordServiceHostPort,
} from "./record-port.js";

type Progress = Extract<StorageRequestMap["storage/writeStatus"]["result"], { ok: true }>["value"];
type Write = {
  owner: ResourceOwner;
  input: RecordWrite;
  ticket: PublicationTicket;
  record: RecordMeta;
  state: WriteProgress["state"];
  received: number;
  created: number;
  progress: number;
  terminal?: number;
  receipt?: Receipt<RecordRevision>;
  last?: { offset: number; data: string; expiresAt: number };
  error?: Progress["error"];
  pending: Promise<unknown>;
  retained?: SealedPayloadPin;
};
type Read = {
  owner: ResourceOwner;
  pin: string;
  record: RecordMeta;
  created: number;
  progress: number;
  closed: boolean;
};
type List = {
  owner: ResourceOwner;
  kind: string | undefined;
  limit: number;
  created: number;
  progress: number;
  entries: RecordMeta[];
  cursors: string[];
  bytes: number;
  closed: boolean;
};
export function createRecordService(deps: RecordDependencies): RecordServiceHostPort {
  const writes = new Map<string, Write>();
  const closingPins = new Set<Promise<void>>();
  function releaseRetained(write: Write) {
    if (!write.retained) return;
    const pin = write.retained.pin;
    delete write.retained;
    const operation = deps.read.close(write.owner, pin);
    closingPins.add(operation);
    void operation.finally(() => closingPins.delete(operation)).catch(() => {});
  }
  const targets = new Map<string, string>();
  const reads = new Map<string, Read>();
  const lists = new Map<string, List>();
  const admitting = new Map<string, number>();
  const opening = new Map<string, number>();
  const listing = new Set<string>();
  const deleting = new Map<
    string,
    { owner: ResourceOwner; expected: string; ticket: PublicationTicket }
  >();
  const deleted = new Map<
    string,
    { owner: ResourceOwner; expected: string; receipt: Receipt<RecordRevision>; until: number }
  >();
  const targetKey = (owner: ResourceOwner, id: string) => JSON.stringify([owner.sourceKey, id]);
  const expiry = (value: { created: number; progress: number }) =>
    Math.min(value.created + 120000, value.progress + 30000);
  const wallExpiry = (deadline: number) => projectWallExpiry(deps, deadline);
  const terminal = (write: Write) =>
    ["committed", "aborted", "expired", "failed"].includes(write.state);
  function sweep() {
    for (const [id, write] of writes)
      if (write.terminal !== undefined && deps.now() >= write.terminal + 120000) writes.delete(id);
    for (const [id, entry] of deleted) if (deps.now() >= entry.until) deleted.delete(id);
    for (const [id, read] of reads)
      if (deps.now() >= expiry(read)) {
        reads.delete(id);
        if (!read.closed) void deps.read.close(read.owner, read.pin).catch(() => {});
      }
    for (const [id, list] of lists) if (deps.now() >= expiry(list)) lists.delete(id);
  }
  function get(owner: ResourceOwner, id: string): Write {
    const write = writes.get(id);
    if (!write || ownerKey(write.owner) !== ownerKey(owner)) stale();
    return write;
  }
  async function gate(write: Write, signal: AbortSignal, token?: string) {
    if (write.state === "publishing" || terminal(write)) return;
    if (deps.now() >= expiry(write)) {
      const disposition = await deps.engine.abort(write.ticket);
      if (disposition === "unknown") {
        write.state = "publishing";
        return;
      }
      write.state = disposition === "committed" ? "publishing" : "expired";
      if (write.state === "expired") {
        releaseRetained(write);
        write.terminal = deps.now();
        targets.delete(targetKey(write.owner, write.record.id));
      }
      stale();
    }
    if (signal.aborted) throw new PersistenceFault("PLUGIN_E_CANCELLED");
    if (!deps.live(write.owner) && !write.input.drainToken) stale();
    deps.checkpoint.authorize(write.owner, write.input, token ?? write.input.drainToken);
  }
  function status(write: Write): Progress {
    return {
      write: write.ticket.id,
      id: write.record.id,
      state: write.state,
      receivedBytes: write.received,
      expiresAt: wallExpiry(expiry(write)),
      ...(write.receipt ? { receipt: write.receipt } : {}),
      ...(write.error ? { error: write.error } : {}),
    };
  }
  function committed(write: Write, receipt: Receipt<RecordRevision>) {
    delete write.error;
    write.state = "committed";
    releaseRetained(write);
    write.receipt = receipt;
    write.terminal = deps.now();
    targets.delete(targetKey(write.owner, write.record.id));
    deps.checkpoint.committed(write.owner, write.input, write.record);
  }
  async function reconcile(write: Write) {
    if (write.state !== "publishing") return;
    const outcome = await deps.engine.reconcile(write.ticket);
    if (outcome.disposition === "committed" && outcome.receipt) committed(write, outcome.receipt);
    else if (outcome.disposition === "not-committed") write.state = "sealed";
  }
  function unknown(): never {
    const error = new PersistenceFault("PLUGIN_E_STORAGE_IO", "publish-uncertain");
    error.result.error.detail = {
      kind: "persistence",
      reason: "publish-uncertain",
      disposition: "unknown",
    };
    throw error;
  }
  type Handlers = {
    [M in keyof StorageRequestMap]: (
      owner: ResourceOwner,
      params: StorageRequestMap[M]["params"],
      signal: AbortSignal,
    ) => Promise<StorageRequestMap[M]["result"]>;
  };
  async function begin(owner: ResourceOwner, input: RecordWrite, signal: AbortSignal) {
    for (const write of writes.values())
      if (!terminal(write) && write.state !== "publishing" && deps.now() >= expiry(write)) {
        try {
          await gate(write, signal);
        } catch {
          /* Expired evidence stays queryable. */
        }
      }
    if (!deps.live(owner) && !input.drainToken) stale();
    if (signal.aborted) throw new PersistenceFault("PLUGIN_E_CANCELLED");
    const active = [...writes.values()].filter((write) => !terminal(write));
    if (
      active.length + [...admitting.values()].reduce((a, b) => a + b, 0) >= 16 ||
      active.filter((write) => write.owner.sourceKey === owner.sourceKey).length +
        (admitting.get(owner.sourceKey) ?? 0) >=
        2 ||
      writes.size >= 1024 ||
      [...writes.values()].filter((write) => write.owner.sourceKey === owner.sourceKey).length >= 64
    )
      limit();
    const id = input.target.mode === "create" ? randomUUID() : input.target.id;
    const key = targetKey(owner, id);
    if (targets.has(key)) conflict("write-in-progress");
    const writeId = randomUUID();
    targets.set(key, writeId);
    admitting.set(owner.sourceKey, (admitting.get(owner.sourceKey) ?? 0) + 1);
    let admitted = true;
    try {
      const old = input.target.mode === "replace" ? await deps.read.stat(owner, id) : null;
      if (old && input.target.mode === "replace" && old.revision !== input.target.expectedRevision)
        conflict("revision-mismatch");
      const checkpoint = deps.checkpoint.authorize(owner, input, input.drainToken);
      const now = deps.now();
      const record: RecordMeta = {
        id,
        revision: `r_${randomUUID().replaceAll("-", "")}`,
        kind: input.kind,
        schemaVersion: input.schemaVersion,
        label: input.label,
        mediaType: input.mediaType,
        byteLength: input.byteLength,
        sha256: input.sha256,
        createdAt: old?.createdAt ?? deps.wall(),
        updatedAt: deps.wall(),
        checkpoint,
        interrupted: false,
      };
      const ticket: PublicationTicket = Object.freeze({
        id: writeId,
        owner: Object.freeze({ ...owner }),
        deadlineMonotonicMs: now + 120000,
        metadata: { kind: "record" as const, record, deleted: false },
        target: {
          kind: "record" as const,
          id,
          expectedRevision: input.target.mode === "replace" ? input.target.expectedRevision : null,
        },
      });
      const write: Write = {
        owner: ticket.owner,
        ticket,
        record,
        input: structuredClone(input),
        state: "receiving",
        received: 0,
        created: now,
        progress: now,
        pending: Promise.resolve(),
      };
      writes.set(writeId, write);
      admitting.set(owner.sourceKey, admitting.get(owner.sourceKey)! - 1);
      admitted = false;
      const admission = (async () => {
        const grant = deps.checkpoint.finalGrant?.(owner, input);
        if (grant) {
          if (!deps.engine.reserveFinal) stale();
          await deps.engine.reserveFinal(ticket, input.byteLength, grant);
        } else await deps.engine.reserve(ticket, input.byteLength);
        await gate(write, signal);
      })();
      write.pending = admission;
      await admission;
      return {
        ok: true as const,
        value: { write: writeId, id, expiresAt: wallExpiry(expiry(write)) },
      };
    } catch (error) {
      const write = writes.get(writeId);
      if (write && write.state === "publishing") throw error;
      if (write) await deps.engine.abort(write.ticket);
      targets.delete(key);
      writes.delete(writeId);
      throw error;
    } finally {
      if (admitted) admitting.set(owner.sourceKey, admitting.get(owner.sourceKey)! - 1);
    }
  }
  const handlers: Handlers = {
    "storage/beginWrite": (owner, params, signal) => {
      const { checkpoint, drainToken, ...input } = params;
      return begin(
        owner,
        { ...input, ...(checkpoint ? { checkpoint } : {}), ...(drainToken ? { drainToken } : {}) },
        signal,
      );
    },
    "storage/writeChunk": async (owner, p, signal) => {
      const write = get(owner, p.write);
      await gate(write, signal);
      if (write.state !== "receiving") conflict("sealed");
      if (write.last?.offset === p.offset && write.last.data === p.data)
        return {
          ok: true,
          value: { receivedBytes: write.received, expiresAt: write.last.expiresAt },
        };
      if (p.offset !== write.received) conflict("offset-mismatch");
      const bytes = decodeChunk(p.data);
      if (bytes.length > write.input.byteLength - write.received) conflict("incomplete");
      let offset = 0;
      try {
        while (offset < bytes.length) {
          await gate(write, signal);
          const count = await deps.engine.append(
            write.ticket,
            write.received + offset,
            bytes.subarray(offset),
          );
          if (count <= 0 || count > bytes.length - offset)
            throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
          offset += count;
        }
      } catch (error) {
        await deps.engine.abort(write.ticket);
        write.state = "aborted";
        write.terminal = deps.now();
        targets.delete(targetKey(owner, write.record.id));
        throw error;
      }
      write.received += bytes.length;
      write.progress = deps.now();
      const expiresAt = wallExpiry(expiry(write));
      write.last = { offset: p.offset, data: p.data, expiresAt };
      return { ok: true, value: { receivedBytes: write.received, expiresAt } };
    },
    "storage/sealWrite": async (owner, p, signal) => {
      const write = get(owner, p.write);
      await gate(write, signal);
      if (write.state === "sealed" || write.state === "committed")
        return { ok: true, value: status(write) };
      if (write.state !== "receiving" || write.received !== write.input.byteLength)
        conflict("incomplete");
      try {
        await deps.engine.seal(write.ticket, write.received, write.input.sha256);
      } catch (error) {
        write.error =
          error instanceof PersistenceFault
            ? error.result.error
            : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result.error;
        if (
          error instanceof PersistenceFault &&
          error.result.error.detail?.kind === "persistence" &&
          error.result.error.detail.reason === "checksum-mismatch"
        ) {
          write.state = "failed";
          write.terminal = deps.now();
          targets.delete(targetKey(owner, write.record.id));
          await deps.engine.abort(write.ticket);
        }
        throw error;
      }
      write.state = "sealed";
      delete write.error;
      write.progress = deps.now();
      if (deps.retainForRecovery && deps.evidence.retainSealed) {
        write.retained = await deps.evidence.retainSealed(write.ticket);
      }
      return { ok: true, value: status(write) };
    },
    "storage/commitWrite": async (owner, p, signal) => {
      const write = get(owner, p.write);
      if (write.state === "publishing") await reconcile(write);
      if (write.receipt)
        return { ok: true, value: { record: write.record, receipt: write.receipt } };
      if (write.state === "publishing") unknown();
      await gate(write, signal, p.drainToken);
      if (write.state !== "sealed") conflict("incomplete");
      if (write.input.drainToken !== p.drainToken) stale();
      write.state = "publishing";
      try {
        const result = await deps.engine.publish(write.ticket);
        if (result.disposition === "unknown") unknown();
        if (result.disposition === "not-committed" || !result.receipt) {
          write.state = "sealed";
          const failure = new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
          write.error = failure.result.error;
          throw failure;
        }
        committed(write, result.receipt);
        return { ok: true, value: { record: write.record, receipt: result.receipt } };
      } catch (error) {
        if (write.state === "publishing") unknown();
        throw error;
      }
    },
    "storage/writeStatus": async (owner, p, signal) => {
      const write = get(owner, p.write);
      try {
        await gate(write, signal);
      } catch {
        if (!terminal(write)) throw new PersistenceFault("PLUGIN_E_STALE_RESOURCE");
      }
      await reconcile(write);
      return { ok: true, value: status(write) };
    },
    "storage/abortWrite": async (owner, p) => {
      const write = get(owner, p.write);
      if (write.receipt)
        return { ok: true, value: { disposition: "committed", receipt: write.receipt } };
      const disposition = await deps.engine.abort(write.ticket);
      if (disposition === "aborted") {
        releaseRetained(write);
        write.state = "aborted";
        write.terminal = deps.now();
        targets.delete(targetKey(owner, write.record.id));
      } else write.state = "publishing";
      return { ok: true, value: { disposition } };
    },
    "storage/stat": async (owner, p) => ({
      ok: true,
      value: { record: await deps.read.stat(owner, p.id) },
    }),
    "storage/list": async (owner, p) => {
      const page = (list: List, index: number) => {
        const entries = list.entries.slice(index * list.limit, (index + 1) * list.limit);
        const nextCursor = list.cursors[index + 1];
        const value = { entries, ...(nextCursor ? { nextCursor } : {}) };
        if (entries.length > 64 || Buffer.byteLength(JSON.stringify({ ok: true, value })) > 262144)
          limit("storage-list");
        return structuredClone(value);
      };
      if (p.cursor) {
        const list = [...lists.values()].find((item) => item.cursors.includes(p.cursor!));
        if (
          !list ||
          ownerKey(list.owner) !== ownerKey(owner) ||
          list.kind !== p.kind ||
          list.limit !== p.limit
        )
          stale("storage-list");
        const index = list.cursors.indexOf(p.cursor);
        list.progress = deps.now();
        if (index === list.cursors.length - 1) list.closed = true;
        return { ok: true, value: page(list, index) };
      }
      if (
        listing.has(owner.sourceKey) ||
        [...lists.values()].filter(
          (list) => !list.closed && list.owner.sourceKey === owner.sourceKey,
        ).length >= 4 ||
        lists.size >= 1024 ||
        [...lists.values()].filter((list) => list.owner.sourceKey === owner.sourceKey).length >= 64
      )
        limit("storage-list");
      listing.add(owner.sourceKey);
      try {
        const entries: RecordMeta[] = [],
          seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const next = await deps.read.list(owner, {
            ...(p.kind ? { kind: p.kind } : {}),
            limit: 64,
            ...(cursor ? { cursor } : {}),
          });
          if (next.entries.length > 64 || entries.length + next.entries.length > 256)
            limit("storage-list");
          entries.push(...structuredClone(next.entries));
          cursor = next.nextCursor;
          if (cursor && seen.has(cursor))
            throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "corrupt");
          if (cursor) seen.add(cursor);
          if (seen.size > 4) limit("storage-list");
        } while (cursor);
        entries.sort(
          (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
        const bytes =
          Buffer.byteLength(JSON.stringify(entries)) +
          Math.max(1, Math.ceil(entries.length / p.limit)) * 36;
        if (
          [...lists.values()].reduce((n, x) => n + x.bytes, bytes) > 8388608 ||
          [...lists.values()]
            .filter((x) => x.owner.sourceKey === owner.sourceKey)
            .reduce((n, x) => n + x.bytes, bytes) > 524288
        )
          limit("storage-list");
        const list: List = {
          owner: { ...owner },
          kind: p.kind,
          limit: p.limit,
          created: deps.now(),
          progress: deps.now(),
          entries,
          bytes,
          closed: false,
          cursors: Array.from({ length: Math.max(1, Math.ceil(entries.length / p.limit)) }, () =>
            randomUUID(),
          ),
        };
        for (let index = 0; index < list.cursors.length; index++) page(list, index);
        if (list.cursors.length > 1) lists.set(list.cursors[0]!, list);
        return { ok: true, value: page(list, 0) };
      } finally {
        listing.delete(owner.sourceKey);
      }
    },
    "storage/openRead": async (owner, p) => {
      const active = [...reads.values()].filter(
        (r) => !r.closed && r.owner.sourceKey === owner.sourceKey,
      ).length;
      if (
        active + (opening.get(owner.sourceKey) ?? 0) >= 4 ||
        reads.size >= 1024 ||
        [...reads.values()].filter((r) => r.owner.sourceKey === owner.sourceKey).length >= 64
      )
        limit("storage-read");
      opening.set(owner.sourceKey, (opening.get(owner.sourceKey) ?? 0) + 1);
      try {
        const record = await deps.read.stat(owner, p.id);
        if (record.revision !== p.expectedRevision) conflict("revision-mismatch");
        if (record.schemaVersion !== p.schemaVersion)
          throw new PersistenceFault("PLUGIN_E_STORAGE_VERSION", "schema-mismatch");
        const pin = await deps.read.open(owner, p.id, p.expectedRevision);
        const handle = randomUUID(),
          now = deps.now();
        reads.set(handle, {
          owner: { ...owner },
          pin,
          record,
          created: now,
          progress: now,
          closed: false,
        });
        return { ok: true, value: { read: handle, record, expiresAt: wallExpiry(now + 30000) } };
      } finally {
        opening.set(owner.sourceKey, opening.get(owner.sourceKey)! - 1);
      }
    },
    "storage/readChunk": async (owner, p) => {
      const read = reads.get(p.read);
      if (!read || read.closed || ownerKey(read.owner) !== ownerKey(owner)) stale("storage-read");
      if (p.offset > read.record.byteLength)
        throw new RpcError(RPC_ERRORS.invalidParams, "Offset exceeds record.");
      const bytes = await deps.read.read(
        owner,
        read.pin,
        p.offset,
        Math.min(p.maxBytes, read.record.byteLength - p.offset),
      );
      read.progress = deps.now();
      const nextOffset = p.offset + bytes.length;
      return {
        ok: true,
        value: {
          offset: p.offset,
          data: Buffer.from(bytes).toString("base64"),
          nextOffset,
          eof: nextOffset === read.record.byteLength,
        },
      };
    },
    "storage/closeRead": async (owner, p) => {
      const read = reads.get(p.read);
      if (!read || ownerKey(read.owner) !== ownerKey(owner)) stale("storage-read");
      if (!read.closed) {
        await deps.read.close(owner, read.pin);
        read.closed = true;
      }
      return { ok: true, value: {} };
    },
    "storage/delete": async (owner, p, signal) => {
      const key = targetKey(owner, p.id),
        previous = deleted.get(key);
      if (
        previous &&
        ownerKey(previous.owner) === ownerKey(owner) &&
        previous.expected === p.expectedRevision
      )
        return { ok: true, value: { deleted: true, receipt: previous.receipt } };
      const pending = deleting.get(key);
      if (
        pending &&
        (ownerKey(pending.owner) !== ownerKey(owner) || pending.expected !== p.expectedRevision)
      )
        stale();
      if (!pending && targets.has(key)) conflict("write-in-progress");
      if (!pending) {
        targets.set(key, "delete");
        try {
          const record = await deps.read.stat(owner, p.id);
          if (record.revision !== p.expectedRevision) conflict("revision-mismatch");
          if (signal.aborted || !deps.live(owner)) stale();
          const ticket: PublicationTicket = {
            id: randomUUID(),
            owner: { ...owner },
            deadlineMonotonicMs: deps.now() + 10000,
            metadata: {
              kind: "record",
              record: { ...record, revision: `r_${randomUUID().replaceAll("-", "")}` },
              deleted: true,
            },
            target: { kind: "record", id: p.id, expectedRevision: p.expectedRevision },
          };
          await deps.engine.reserve(ticket, 0);
          if (signal.aborted || !deps.live(owner)) {
            await deps.engine.abort(ticket);
            stale();
          }
          deleting.set(key, { owner: { ...owner }, expected: p.expectedRevision, ticket });
        } catch (error) {
          targets.delete(key);
          throw error;
        }
      }
      const ticket = deleting.get(key)!.ticket;
      let result: Awaited<ReturnType<RecordDependencies["engine"]["publish"]>>;
      try {
        result = await (pending ? deps.engine.reconcile(ticket) : deps.engine.publish(ticket));
      } catch {
        unknown();
      }
      if (result.disposition === "unknown") unknown();
      deleting.delete(key);
      targets.delete(key);
      if (result.disposition !== "committed" || !result.receipt)
        throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
      deleted.set(key, {
        owner: { ...owner },
        expected: p.expectedRevision,
        receipt: result.receipt,
        until: deps.now() + 120000,
      });
      return { ok: true, value: { deleted: true, receipt: result.receipt } };
    },
    "storage/flush": async (owner, _p, _signal) => {
      if (
        deps.checkpoint.open(owner) ||
        [...deleting.values()].some((d) => d.owner.sourceKey === owner.sourceKey) ||
        [...writes.values()].some((w) => w.owner.sourceKey === owner.sourceKey && !terminal(w))
      )
        conflict("flush-incomplete");
      const barrier = deps.evidence.capture({ kind: "namespace", owner }, deps.now() + 10000);
      const evidence = await deps.evidence.flush(barrier);
      if (evidence.state !== "saved" || evidence.incomplete.length || evidence.unknown.length)
        conflict("flush-incomplete");
      return { ok: true, value: { barrier: barrier.id, durability: "file-sync-only" } };
    },
    "storage/quota": (owner) => deps.evidence.quota(owner),
    "storage/registerCheckpoint": (owner, p) => deps.checkpoint.register(owner, p),
    "storage/abandonCheckpoint": (owner, p) => deps.checkpoint.abandon(owner, p),
    "storage/drain": async () => {
      throw new RpcError(RPC_ERRORS.methodNotFound, "Host-only method direction.");
    },
  };
  return {
    admittedWrites(owner) {
      return [...writes.values()]
        .filter((w) => !owner || ownerKey(w.owner) === ownerKey(owner))
        .map((w) => ({
          ...structuredClone({
            owner: w.owner,
            input: w.input,
            ticket: w.ticket,
            record: w.record,
            state: w.state,
            created: w.created,
            progress: w.progress,
            ...(w.retained ? { retained: w.retained } : {}),
          }),
          pending: w.pending,
        }));
    },
    async settle(tickets) {
      for (const id of tickets) {
        const write = writes.get(id);
        if (!write) continue;
        await write.pending.catch(() => {});
        if (write.state === "sealed") {
          const result = await deps.engine.reconcile(write.ticket);
          if (result.disposition === "committed" && result.receipt)
            committed(write, result.receipt);
        } else await reconcile(write);
      }
    },
    async close() {
      await Promise.allSettled([...writes.values()].map((w) => w.pending));
      for (const read of reads.values())
        if (!read.closed) {
          await deps.read.close(read.owner, read.pin);
          read.closed = true;
        }
      reads.clear();
      lists.clear();
      await Promise.allSettled([...closingPins]);
    },
    async request<M extends keyof StorageRequestMap>(
      principal: Principal,
      method: M,
      params: StorageRequestMap[M]["params"],
      signal: AbortSignal,
    ): Promise<StorageRequestMap[M]["result"]> {
      sweep();
      if (principal.kind !== "plugin")
        return new PersistenceFault("PLUGIN_E_PERMISSION_DENIED")
          .result as StorageRequestMap[M]["result"];
      const owner = principal.owner;
      const read = [
        "storage/stat",
        "storage/list",
        "storage/openRead",
        "storage/readChunk",
        "storage/closeRead",
      ].includes(method);
      const permission = read ? "storage.read" : "storage.write";
      if (
        !deps.permission(principal, permission) &&
        !(method === "storage/quota" && deps.permission(principal, "storage.read"))
      )
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "Permission required.",
            detail: { kind: "permission", reason: "permission" },
          },
        } as StorageRequestMap[M]["result"];
      const run = async () => {
        try {
          return await handlers[method](owner, params, signal);
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return error instanceof PersistenceFault
            ? error.result
            : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result;
        }
      };
      if ("write" in params && typeof params.write === "string") {
        const write = writes.get(params.write);
        if (write) {
          const next = write.pending.catch(() => {}).then(run);
          write.pending = next;
          return next as Promise<StorageRequestMap[M]["result"]>;
        }
      }
      return run() as Promise<StorageRequestMap[M]["result"]>;
    },
  };
}
