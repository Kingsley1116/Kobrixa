import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RecordMeta, ResourceOwner, StorageRequestMap } from "@kobrixa/plugin-protocol";
import { createRecordService } from "../../main/plugins/persistence/record-service.js";
import {
  PersistenceFault,
  type RecordDependencies,
} from "../../main/plugins/persistence/record-port.js";
import type {
  PersistenceEvidencePort,
  StoredRecovery,
} from "../../main/plugins/persistence/engine-port.js";
import {
  RecordingWriter,
  type LabStorage,
} from "../../../../../plugins/sensor-lab/src/persistence.js";
import { recording } from "./data.test.js";
// Actual record service; in-memory engine/read/evidence ports adapted from its unit fixture.
// This exercises domain state/CAS/token rules, not native durability or retained RPC admission.
const owner: ResourceOwner = {
  sourceKey: "builtin:test.records",
  pluginId: "test.records",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const p = { kind: "plugin" as const, owner, authorityContext: null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const now = 0;
  const records = new Map<string, RecordMeta>();
  const payloads = new Map<string, Uint8Array>();
  const staging = new Map<string, Uint8Array>();
  const pins = new Map<string, Uint8Array>();
  const reserve = vi.fn<RecordDependencies["engine"]["reserve"]>(async (ticket, length) => {
    staging.set(ticket.id, new Uint8Array(length));
  });
  const append = vi.fn<RecordDependencies["engine"]["append"]>(async (ticket, offset, bytes) => {
    staging.get(ticket.id)!.set(bytes, offset);
    return bytes.length;
  });
  const publish = vi.fn<RecordDependencies["engine"]["publish"]>(async (ticket) => {
    if (ticket.metadata.kind !== "record") throw new Error("record required");
    const record = ticket.metadata.record;
    const receipt = {
      revision: record.revision,
      commitId: ticket.id,
      durability: "file-sync-only" as const,
    };
    if (ticket.metadata.deleted) records.delete(record.id);
    else {
      records.set(record.id, record);
      payloads.set(record.revision, staging.get(ticket.id)!);
    }
    return { disposition: "committed", receipt };
  });
  const deps: Parameters<typeof createRecordService>[0] = {
    now: () => now,
    wall: () => 100000 + now,
    live: () => true,
    permission: () => deps.live(owner),
    engine: {
      reserve,
      append,
      seal: async (ticket, length, digest) => {
        expect(staging.get(ticket.id)!.length).toBe(length);
        if (hash(staging.get(ticket.id)!) !== digest)
          throw new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", "checksum-mismatch");
      },
      publish,
      reconcile: publish,
      abort: async () => "aborted",
      fence: () => [],
      fenceTarget: () => [],
    },
    read: {
      settings: async () => null,
      stat: async (_owner, id) => {
        const r = records.get(id);
        if (!r) throw new Error("missing");
        return structuredClone(r);
      },
      list: async (_owner, query) => {
        const offset = query.cursor ? Number(query.cursor) : 0;
        const all = [...records.values()].filter((r) => !query.kind || r.kind === query.kind);
        return {
          entries: all.slice(offset, offset + query.limit),
          ...(offset + query.limit < all.length
            ? { nextCursor: String(offset + query.limit) }
            : {}),
        };
      },
      open: async (_owner, _id, revision) => {
        pins.set(revision, payloads.get(revision)!);
        return revision;
      },
      read: async (_owner, pin, offset, max) => pins.get(pin)!.slice(offset, offset + max),
      close: async (_owner, pin) => {
        pins.delete(pin);
      },
    },
    evidence: evidenceDouble({
      quota: async () => ({
        ok: true,
        value: {
          recordCount: records.size,
          reservedCreates: staging.size,
          committedBytes: 0,
          reservedBytes: 0,
          pinnedBytes: 0,
          temporaryBytes: 0,
          sourceLimitBytes: 536870912,
          sourceLimitRecords: 256,
          hostAvailableBytes: 1073741824,
          writeSlotsAvailable: 2,
          exportSlotsAvailable: 1,
        },
      }),
    }),
    checkpoint: {
      authorize: () => "none",
      committed: () => {},
      open: () => false,
      register: async () => ({
        ok: false,
        error: { code: "PLUGIN_E_DISABLED", message: "Not attached" },
      }),
      abandon: async () => ({
        ok: false,
        error: { code: "PLUGIN_E_DISABLED", message: "Not attached" },
      }),
    },
  };
  const service = createRecordService(deps);
  return { service, deps, reserve, append, publish, records };
}
function evidenceDouble(overrides: Partial<PersistenceEvidencePort> = {}): PersistenceEvidencePort {
  let sequence = 0;
  const recovery = new Map<string, StoredRecovery>();
  return {
    capture: (scope, deadlineMonotonicMs) => ({
      id: crypto.randomUUID(),
      scope,
      through: sequence++,
      deadlineMonotonicMs,
    }),
    flush: async () => ({ state: "saved", accepted: [], incomplete: [], unknown: [] }),
    tickets: () => [],
    settingsDigest: async () => null,
    quota: async () => {
      throw new Error("Quota not exercised by this unit.");
    },
    auxiliary: async () => null,
    auxiliaryKeys: async () => ({ keys: [], nextCursor: null }),
    recoveryPage: async () => ({ items: [...recovery.values()], nextCursor: null }),
    loadRecovery: async (id) => recovery.get(id) ?? null,
    saveRecovery: async (value) => {
      recovery.set(value.id, structuredClone(value));
    },
    removeRecovery: async (id) => {
      recovery.delete(id);
    },
    ...overrides,
  };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function setup() {
  const f = fixture();
  const call = <M extends keyof StorageRequestMap>(
    method: M,
    params: StorageRequestMap[M]["params"],
    signal = new AbortController().signal,
  ) => f.service.request(p, method, params, signal);
  const storage = {
    beginWrite: vi.fn<LabStorage["beginWrite"]>((params, signal) =>
      call("storage/beginWrite", params, signal),
    ),
    writeStatus: vi.fn<LabStorage["writeStatus"]>((params, signal) =>
      call("storage/writeStatus", params, signal),
    ),
    writeChunk: vi.fn<LabStorage["writeChunk"]>((params, signal) =>
      call("storage/writeChunk", params, signal),
    ),
    sealWrite: vi.fn<LabStorage["sealWrite"]>((params, signal) =>
      call("storage/sealWrite", params, signal),
    ),
    commitWrite: vi.fn<LabStorage["commitWrite"]>((params, signal) =>
      call("storage/commitWrite", params, signal),
    ),
    list: vi.fn<LabStorage["list"]>((params, signal) => call("storage/list", params, signal)),
    quota: vi.fn<LabStorage["quota"]>((params, signal) => call("storage/quota", params, signal)),
  };
  return {
    ...f,
    storage,
    writer: new RecordingWriter(storage as unknown as LabStorage),
    model: { ...recording(), id: id(30) },
  };
}
const final = () => ({
  checkpoint: { handle: id(40), phase: "final" as const },
  drainToken: id(41),
});

it.each([undefined, id(41)])(
  "reconciles a sealed final write using its original token (retry %s)",
  async (token) => {
    const f = setup();
    expect(f.writer.committedWrite).toBeUndefined();
    await f.writer.save(f.model);
    const committed = f.writer.committedWrite;
    f.publish.mockResolvedValueOnce({ disposition: "not-committed" });
    await expect(f.writer.save(f.model, final())).rejects.toThrow();
    const write = f.writer.pendingWrite;
    expect(f.writer.committedWrite).toBe(committed);
    await f.writer.reconcile(token ? { drainToken: token } : {});
    expect(f.storage.commitWrite.mock.lastCall?.[0]).toEqual({ write, drainToken: id(41) });
    expect(f.writer.committedWrite).toBe(write);
    expect(f.writer.pendingWrite).toBeUndefined();
    expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
  },
);

it("rejects a contradictory retry token before dispatch and retains the original write", async () => {
  const f = setup();
  await f.writer.save(f.model);
  f.publish.mockResolvedValueOnce({ disposition: "not-committed" });
  await expect(f.writer.save(f.model, final())).rejects.toThrow();
  const write = f.writer.pendingWrite;
  const calls = f.storage.writeStatus.mock.calls.length;
  await expect(f.writer.reconcile({ drainToken: id(42) })).rejects.toMatchObject({ code: "drain" });
  expect(f.storage.writeStatus).toHaveBeenCalledTimes(calls);
  expect(f.writer.pendingWrite).toBe(write);
  await f.writer.reconcile();
  expect(f.writer.committedWrite).toBe(write);
});

it("never promotes an ordinary pending checkpoint to final", async () => {
  const f = setup();
  await f.writer.save(f.model);
  const committed = f.writer.committedWrite;
  f.publish.mockResolvedValueOnce({ disposition: "not-committed" });
  await expect(
    f.writer.save(f.model, { checkpoint: { handle: id(40), phase: "checkpoint" } }),
  ).rejects.toThrow();
  const write = f.writer.pendingWrite;
  const calls = f.storage.writeStatus.mock.calls.length;
  await expect(f.writer.save(f.model, final())).rejects.toMatchObject({ code: "drain" });
  expect(f.storage.writeStatus).toHaveBeenCalledTimes(calls);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.committedWrite).toBe(committed);
  await f.writer.reconcile();
  expect(f.storage.commitWrite.mock.lastCall?.[0]).toEqual({ write });
});

it("retries a confirmed aborted healthy replacement with the same CAS head and terminal evidence", async () => {
  const f = setup();
  const first = await f.writer.save(f.model);
  const committed = f.writer.committedWrite;
  f.append.mockRejectedValueOnce(new Error("transient I/O"));
  await expect(f.writer.save({ ...f.model, name: "second" })).rejects.toThrow();
  const write = f.writer.pendingWrite;
  expect(await f.storage.writeStatus({ write: write! })).toMatchObject({
    ok: true,
    value: { state: "aborted" },
  });
  await expect(f.writer.reconcile()).rejects.toMatchObject({ code: "terminal" });
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.current).toEqual(first);
  expect(f.writer.committedWrite).toBe(committed);
  const next = await f.writer.save({ ...f.model, name: "retry" });
  expect(next.id).toBe(first.id);
  expect(next.revision).not.toBe(first.revision);
  expect(f.storage.beginWrite.mock.lastCall?.[0].target).toEqual({
    mode: "replace",
    id: first.id,
    expectedRevision: first.revision,
  });
  expect(f.writer.terminalWrite).toMatchObject({
    write,
    id: first.id,
    state: "aborted",
    input: { target: { mode: "replace", expectedRevision: first.revision } },
  });
  expect(Object.isFrozen(f.writer.terminalWrite)).toBe(true);
  expect(f.writer.pendingWrite).toBeUndefined();
  expect(f.writer.committedWrite).not.toBe(committed);
  expect(f.records.size).toBe(1);
});

it("retains aborted evidence when ordinary authority is retired", async () => {
  const f = setup();
  await f.writer.save(f.model);
  const committed = f.writer.committedWrite;
  f.append.mockRejectedValueOnce(new Error("transient I/O"));
  await expect(f.writer.save(f.model)).rejects.toThrow();
  const write = f.writer.pendingWrite;
  // Status can be available via bounded recovery, but no ordinary quota/begin admission.
  f.deps.live = () => false;
  f.deps.retainedFinalRequest = (_principal, method) => method === "storage/writeStatus";
  await expect(f.writer.save(f.model)).rejects.toMatchObject({
    code: "PLUGIN_E_PERMISSION_DENIED",
  });
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.committedWrite).toBe(committed);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
});

it("does not reset an aborted final write even if the caller omits retry options", async () => {
  const f = setup();
  await f.writer.save(f.model);
  const committed = f.writer.committedWrite;
  f.append.mockRejectedValueOnce(new Error("transient I/O"));
  await expect(f.writer.save(f.model, final())).rejects.toThrow();
  const write = f.writer.pendingWrite;
  await expect(f.writer.save(f.model)).rejects.toMatchObject({ code: "terminal" });
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.committedWrite).toBe(committed);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
});

it("does not reset an unknown publishing write or issue another begin", async () => {
  const f = setup();
  await f.writer.save(f.model);
  const committed = f.writer.committedWrite;
  f.publish.mockResolvedValue({ disposition: "unknown" });
  await expect(f.writer.save(f.model)).rejects.toThrow();
  const write = f.writer.pendingWrite;
  await expect(f.writer.save(f.model)).rejects.toThrow();
  await expect(f.writer.reconcile()).rejects.toThrow();
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.committedWrite).toBe(committed);
  expect(f.writer.terminalWrite).toBeUndefined();
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
});

it("fences an accepted begin whose reply is lost instead of issuing a duplicate create", async () => {
  const f = setup();
  const begin = f.storage.beginWrite.getMockImplementation()!;
  f.storage.beginWrite.mockImplementationOnce(async (...args) => {
    await begin(...args);
    throw new Error("lost begin reply");
  });
  await expect(f.writer.save(f.model)).rejects.toThrow();
  await expect(f.writer.save(f.model)).rejects.toMatchObject({ code: "uncertain" });
  await expect(f.writer.reconcile()).rejects.toMatchObject({ code: "uncertain" });
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
  expect(f.writer.committedWrite).toBeUndefined();
});

it("keeps the aborted pending write if ordinary begin loses admission after quota", async () => {
  const f = setup();
  const first = await f.writer.save(f.model);
  const committed = f.writer.committedWrite;
  f.append.mockRejectedValueOnce(new Error("transient I/O"));
  await expect(f.writer.save(f.model)).rejects.toThrow();
  const write = f.writer.pendingWrite;
  const begin = f.storage.beginWrite.getMockImplementation()!;
  f.storage.beginWrite.mockImplementationOnce((...args) => {
    f.deps.live = () => false;
    return begin(...args);
  });
  await expect(f.writer.save(f.model)).rejects.toMatchObject({
    code: "PLUGIN_E_PERMISSION_DENIED",
  });
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.current).toEqual(first);
  expect(f.writer.committedWrite).toBe(committed);
  expect(f.writer.terminalWrite).toMatchObject({ write, state: "aborted" });
  f.deps.live = () => true;
  await f.writer.save(f.model);
  expect(f.writer.current?.id).toBe(first.id);
  expect(f.records.size).toBe(1);
});

it("does not turn an aborted initial create into a second create", async () => {
  const f = setup();
  f.append.mockRejectedValueOnce(new Error("transient I/O"));
  await expect(f.writer.save(f.model)).rejects.toThrow();
  const write = f.writer.pendingWrite;
  await expect(f.writer.save(f.model)).rejects.toMatchObject({ code: "terminal" });
  expect(f.writer.pendingWrite).toBe(write);
  expect(f.writer.committedWrite).toBeUndefined();
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});
