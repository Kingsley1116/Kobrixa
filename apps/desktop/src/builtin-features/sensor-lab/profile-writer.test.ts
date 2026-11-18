import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type {
  RecordWrite,
  RecordMeta,
  ResourceOwner,
  StorageRequestMap,
} from "@kobrixa/plugin-protocol";
import { CalibrationWriter } from "../../../../../plugins/sensor-lab/src/profile-writer.js";
import type { LabStorage } from "../../../../../plugins/sensor-lab/src/persistence.js";
import { recording } from "./data.test.js";
const ok = <T>(value: T) => ({ ok: true as const, value });
function fixture() {
  const profile = {
    schemaVersion: 2 as const,
    id: randomUUID(),
    name: "Calibration",
    ...recording().channels[0]!,
  };
  const id = randomUUID(),
    write = randomUUID(),
    revision = randomUUID();
  let input: RecordWrite,
    received = 0;
  const status = () => ({
    write,
    id,
    state: "receiving" as const,
    receivedBytes: received,
    expiresAt: 1000,
  });
  const storage = {
    list: vi.fn(async () => ok({ entries: [] as RecordMeta[] })),
    quota: vi.fn(async () =>
      ok({
        recordCount: 0,
        reservedCreates: 0,
        committedBytes: 0,
        reservedBytes: 0,
        hostAvailableBytes: 8388608,
        sourceLimitBytes: 536870912,
        sourceLimitRecords: 256,
        writeSlotsAvailable: 2,
      }),
    ),
    beginWrite: vi.fn(async (p: RecordWrite) => {
      input = structuredClone(p);
      received = 0;
      return ok({ write, id, expiresAt: 1000 });
    }),
    writeStatus: vi.fn(async () => ok(status())),
    writeChunk: vi.fn(async (p: { data: string; offset: number }) => {
      received = p.offset + Buffer.from(p.data, "base64").length;
      return ok({ receivedBytes: received, expiresAt: 1000 });
    }),
    sealWrite: vi.fn(async () => ok({ ...status(), state: "sealed" as const })),
    commitWrite: vi.fn(async () => {
      const meta: RecordMeta = {
        id,
        revision,
        kind: input.kind,
        schemaVersion: 2,
        label: input.label,
        mediaType: input.mediaType,
        byteLength: input.byteLength,
        sha256: input.sha256,
        createdAt: 0,
        updatedAt: 0,
        checkpoint: "none",
        interrupted: false,
      };
      return ok({
        record: meta,
        receipt: { revision, commitId: randomUUID(), durability: "file-sync-only" as const },
      });
    }),
  };
  return {
    profile,
    id,
    write,
    storage,
    writer: new CalibrationWriter(storage as unknown as LabStorage),
  };
}
it("saves immutable calibration payload under a distinct host ID and confirmed receipt", async () => {
  const f = fixture(),
    original = structuredClone(f.profile);
  const saving = f.writer.save(f.profile);
  f.profile.calibration.unit = "changed";
  const meta = await saving;
  expect(meta.id).toBe(f.id);
  expect(meta.id).not.toBe(f.profile.id);
  expect(
    JSON.parse(Buffer.from(f.storage.writeChunk.mock.calls[0]![0].data, "base64").toString()),
  ).toEqual(original);
  expect(f.writer.pendingWrite).toBeUndefined();
});
it("unknown commit keeps the original write and rejects a different new profile", async () => {
  const f = fixture();
  f.storage.commitWrite.mockRejectedValueOnce(new Error("reply lost"));
  await expect(f.writer.save(f.profile)).rejects.toThrow("reply lost");
  expect(f.writer.pendingWrite).toBe(f.write);
  await expect(f.writer.save({ ...f.profile, id: randomUUID() })).rejects.toThrow(
    "original profile",
  );
  const meta = await f.writer.reconcile();
  expect(meta.id).toBe(f.id);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});
it("unknown begin is fenced instead of allocating another profile", async () => {
  const f = fixture();
  f.storage.beginWrite.mockRejectedValueOnce(new Error("lost"));
  await expect(f.writer.save(f.profile)).rejects.toThrow("lost");
  await expect(f.writer.save(f.profile)).rejects.toThrow("admission unknown");
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});
it("quota failure makes no create and a confirmed same-payload retry makes no duplicate", async () => {
  const f = fixture();
  f.storage.quota.mockResolvedValueOnce(
    ok({
      recordCount: 256,
      reservedCreates: 0,
      committedBytes: 0,
      reservedBytes: 0,
      hostAvailableBytes: 8388608,
      sourceLimitBytes: 536870912,
      sourceLimitRecords: 256,
      writeSlotsAvailable: 2,
    }),
  );
  await expect(f.writer.save(f.profile)).rejects.toThrow("quota");
  expect(f.storage.beginWrite).not.toHaveBeenCalled();
  const first = await f.writer.save(f.profile);
  expect(await f.writer.save(f.profile)).toEqual(first);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});

import { createRecordService } from "../../main/plugins/persistence/record-service.js";
import {
  PersistenceFault,
  type RecordDependencies,
} from "../../main/plugins/persistence/record-port.js";
import type {
  PersistenceEvidencePort,
  StoredRecovery,
} from "../../main/plugins/persistence/engine-port.js";

// Actual record service, in-memory engine/read/evidence only; no native durability claim.
const owner: ResourceOwner = {
  sourceKey: "builtin:test.records",
  pluginId: "test.records",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const p = { kind: "plugin" as const, owner, authorityContext: null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function recordFixture() {
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
function recordSetup() {
  const f = recordFixture();
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
    openRead: vi.fn<LabStorage["openRead"]>((params, signal) =>
      call("storage/openRead", params, signal),
    ),
    readChunk: vi.fn<LabStorage["readChunk"]>((params, signal) =>
      call("storage/readChunk", params, signal),
    ),
    closeRead: vi.fn<LabStorage["closeRead"]>((params, signal) =>
      call("storage/closeRead", params, signal),
    ),
    list: vi.fn<LabStorage["list"]>((params, signal) => call("storage/list", params, signal)),
    quota: vi.fn<LabStorage["quota"]>((params, signal) => call("storage/quota", params, signal)),
  };
  return {
    ...f,
    storage,

    model: { ...recording(), id: id(30) },
  };
}

const newProfile = (n = 80) => ({
  schemaVersion: 2 as const,
  id: id(n),
  name: "Calibration",
  ...recording().channels[0]!,
});
it("actual service: explicit save recovers confirmed aborted create with immutable terminal evidence", async () => {
  const f = recordSetup(),
    w = new CalibrationWriter(f.storage as unknown as LabStorage),
    profile = newProfile();
  f.append.mockRejectedValueOnce(new Error("transient append"));
  await expect(w.save(profile)).rejects.toThrow();
  const write = w.pendingWrite!;
  expect(await f.storage.writeStatus({ write })).toMatchObject({
    ok: true,
    value: { state: "aborted" },
  });
  await expect(w.reconcile()).rejects.toMatchObject({ code: "terminal" });
  expect(w.pendingWrite).toBe(write);
  const saved = await w.save(profile);
  expect(w.pendingWrite).toBeUndefined();
  expect(f.records.size).toBe(1);
  expect(w.terminalWrite).toMatchObject({
    write,
    state: "aborted",
    input: { target: { mode: "create" } },
  });
  expect(Object.isFrozen(w.terminalWrite)).toBe(true);
  expect(saved.id).not.toBe(w.terminalWrite!.id);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
});
it("actual service: A-B-A reuses confirmed identity, including a fresh writer lookup", async () => {
  const f = recordSetup(),
    w = new CalibrationWriter(f.storage as unknown as LabStorage),
    a = newProfile();
  const first = await w.save(a);
  await w.save(newProfile(81));
  expect(await w.save(a)).toEqual(first);
  await expect(w.save({ ...a, name: "changed" })).rejects.toMatchObject({ code: "identity" });
  const reopened = new CalibrationWriter(f.storage as unknown as LabStorage);
  expect(await reopened.save(a)).toEqual(first);
  expect(f.storage.openRead).toHaveBeenCalled();
  expect(f.storage.closeRead).toHaveBeenCalled();
  expect(f.records.size).toBe(2);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
});
it("actual service: aborted evidence stays pending after owner retirement", async () => {
  const f = recordSetup(),
    w = new CalibrationWriter(f.storage as unknown as LabStorage);
  f.append.mockRejectedValueOnce(new Error("failed"));
  await expect(w.save(newProfile())).rejects.toThrow();
  const write = w.pendingWrite;
  f.deps.live = () => false;
  await expect(w.save(newProfile(81))).rejects.toThrow();
  expect(w.pendingWrite).toBe(write);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});
it("actual service: unknown publishing cannot reset the original identity", async () => {
  const f = recordSetup(),
    w = new CalibrationWriter(f.storage as unknown as LabStorage);
  f.publish.mockResolvedValue({ disposition: "unknown" });
  await expect(w.save(newProfile())).rejects.toThrow();
  const write = w.pendingWrite;
  await expect(w.save(newProfile(81))).rejects.toThrow();
  await expect(w.reconcile()).rejects.toThrow();
  expect(w.pendingWrite).toBe(write);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});

it("keeps at most 256 confirmed model identities without eviction or duplicate replay", async () => {
  const f = fixture(),
    first = structuredClone(f.profile);
  let firstMeta: RecordMeta | undefined;
  for (let n = 0; n < 256; n++) {
    const meta = await f.writer.save(n === 0 ? first : { ...first, id: randomUUID() });
    if (n === 0) firstMeta = meta;
  }
  await expect(f.writer.save({ ...first, id: randomUUID() })).rejects.toMatchObject({
    code: "identity-limit",
  });
  expect(await f.writer.save(first)).toEqual(firstMeta);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(256);
});
it("actual service: current storage duplicate model identities block a fresh writer", async () => {
  const f = recordSetup(),
    profile = newProfile();
  const meta = await new CalibrationWriter(f.storage as unknown as LabStorage).save(profile);
  const duplicate = { ...meta, id: randomUUID() };
  f.records.set(duplicate.id, duplicate);
  await expect(
    new CalibrationWriter(f.storage as unknown as LabStorage).save(profile),
  ).rejects.toMatchObject({ code: "identity" });
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
});
it("inventory errors cannot silently become permission-free creates", async () => {
  const f = fixture();
  f.storage.list.mockRejectedValueOnce(new Error("read denied"));
  await expect(f.writer.save(f.profile)).rejects.toThrow("read denied");
  expect(f.storage.beginWrite).not.toHaveBeenCalled();
});
it("actual service: a different explicit profile can replace confirmed aborted work, but quota failure retains it", async () => {
  const f = recordSetup(),
    w = new CalibrationWriter(f.storage as unknown as LabStorage);
  f.append.mockRejectedValueOnce(new Error("append"));
  await expect(w.save(newProfile())).rejects.toThrow();
  const write = w.pendingWrite;
  f.storage.quota.mockRejectedValueOnce(new Error("quota unavailable"));
  await expect(w.save(newProfile(81))).rejects.toThrow("quota unavailable");
  expect(w.pendingWrite).toBe(write);
  const meta = await w.save(newProfile(81));
  expect(meta.id).not.toBe(w.terminalWrite!.id);
  expect(f.records.size).toBe(1);
  expect(w.terminalWrite!.write).toBe(write);
});

it("actual service: a lost admitted begin reply stays fenced without another create", async () => {
  const f = recordSetup(),
    w = new CalibrationWriter(f.storage as unknown as LabStorage);
  const begin = f.storage.beginWrite.getMockImplementation()!;
  f.storage.beginWrite.mockImplementationOnce(async (...args) => {
    await begin(...args);
    throw new Error("lost admitted begin");
  });
  await expect(w.save(newProfile())).rejects.toThrow("lost admitted begin");
  await expect(w.save(newProfile(81))).rejects.toMatchObject({ code: "uncertain" });
  await expect(w.reconcile()).rejects.toMatchObject({ code: "uncertain" });
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(1);
  expect(f.reserve).toHaveBeenCalledTimes(1);
});
