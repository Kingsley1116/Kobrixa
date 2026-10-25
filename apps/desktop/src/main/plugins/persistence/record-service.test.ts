import { storageRequestSchemas } from "@kobrixa/plugin-protocol";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RecordMeta, RecordWrite, ResourceOwner } from "@kobrixa/plugin-protocol";
import { createRecordService } from "./record-service.js";
import { PersistenceFault, type RecordDependencies } from "./record-port.js";
const owner: ResourceOwner = {
  sourceKey: "builtin:test.records",
  pluginId: "test.records",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const p = { kind: "plugin" as const, owner, authorityContext: null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const input = (bytes: Uint8Array): RecordWrite => ({
  target: { mode: "create" },
  kind: "test.data",
  schemaVersion: 1,
  label: "Data",
  mediaType: "application/octet-stream",
  byteLength: bytes.length,
  sha256: hash(bytes),
});
const signal = () => new AbortController().signal;
function fixture() {
  let now = 0;
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
  const deps: RecordDependencies = {
    now: () => now,
    wall: () => 100000 + now,
    live: () => true,
    permission: () => true,
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
  async function begin(bytes: Uint8Array) {
    const r = await service.request(p, "storage/beginWrite", input(bytes), signal());
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.value;
  }
  async function complete(bytes: Uint8Array) {
    const b = await begin(bytes);
    if (bytes.length)
      await service.request(
        p,
        "storage/writeChunk",
        { write: b.write, offset: 0, data: Buffer.from(bytes).toString("base64") },
        signal(),
      );
    await service.request(p, "storage/sealWrite", { write: b.write }, signal());
    const c = await service.request(p, "storage/commitWrite", { write: b.write }, signal());
    if (!c.ok) throw new Error(JSON.stringify(c));
    return { ...b, ...c.value };
  }
  return {
    service,
    deps,
    begin,
    complete,
    reserve,
    append,
    publish,
    records,
    pins,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("B2-12.1-2/3: reserves all bytes first; duplicate last chunk does not append or renew", async () => {
  const f = fixture(),
    bytes = Buffer.from("hello");
  const b = await f.begin(bytes);
  expect(f.reserve.mock.calls[0]![1]).toBe(5);
  const c = { write: b.write, offset: 0, data: bytes.toString("base64") };
  const first = await f.service.request(p, "storage/writeChunk", c, signal());
  f.advance(1000);
  expect(await f.service.request(p, "storage/writeChunk", c, signal())).toEqual(first);
  expect(f.append).toHaveBeenCalledOnce();
  expect(
    await f.service.request(
      p,
      "storage/writeChunk",
      { ...c, data: Buffer.from("HELLO").toString("base64") },
      signal(),
    ),
  ).toMatchObject({ error: { detail: { reason: "offset-mismatch" } } });
});
it("B2-12.1-2: source 2 and host 16 staged writes; a third has no reserve side effect", async () => {
  const f = fixture();
  await f.begin(new Uint8Array());
  await f.begin(new Uint8Array());
  expect(
    await f.service.request(p, "storage/beginWrite", input(new Uint8Array()), signal()),
  ).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  expect(f.reserve).toHaveBeenCalledTimes(2);
  for (let n = 1; n < 8; n++) {
    const other = { ...p, owner: { ...owner, sourceKey: `builtin:test.source${n}` } };
    for (let w = 0; w < 2; w++)
      expect(
        await f.service.request(other, "storage/beginWrite", input(new Uint8Array()), signal()),
      ).toMatchObject({ ok: true });
  }
  expect(
    await f.service.request(
      { ...p, owner: { ...owner, sourceKey: "builtin:test.ninth" } },
      "storage/beginWrite",
      input(new Uint8Array()),
      signal(),
    ),
  ).toMatchObject({ ok: false });
});
it("B2-RF1: double commit returns one receipt; unknown reconciles without a second publish", async () => {
  const f = fixture();
  const c = await f.complete(new Uint8Array());
  expect(await f.service.request(p, "storage/commitWrite", { write: c.write }, signal())).toEqual({
    ok: true,
    value: { record: c.record, receipt: c.receipt },
  });
  expect(f.publish).toHaveBeenCalledOnce();
  const b = await f.begin(new Uint8Array());
  await f.service.request(p, "storage/sealWrite", { write: b.write }, signal());
  f.deps.engine.publish = vi.fn(async () => ({ disposition: "unknown" as const }));
  expect(
    await f.service.request(p, "storage/commitWrite", { write: b.write }, signal()),
  ).toMatchObject({ error: { detail: { disposition: "unknown" } } });
  await f.service.request(p, "storage/writeStatus", { write: b.write }, signal());
  expect(f.deps.engine.publish).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledTimes(2);
});
it("B2-10: incomplete/open-checkpoint/unknown work cannot flush", async () => {
  const f = fixture();
  await f.begin(Buffer.from("x"));
  expect(await f.service.request(p, "storage/flush", {}, signal())).toMatchObject({
    error: { detail: { reason: "flush-incomplete" } },
  });
  const g = fixture();
  g.deps.checkpoint.open = () => true;
  expect(await g.service.request(p, "storage/flush", {}, signal())).toMatchObject({ ok: false });
});
it("B2-12.1-3: read pins survive delete, exact EOF and same-owner close are idempotent", async () => {
  const f = fixture();
  const c = await f.complete(Buffer.from("abc"));
  const opened = await f.service.request(
    p,
    "storage/openRead",
    { id: c.id, expectedRevision: c.record.revision, schemaVersion: 1 },
    signal(),
  );
  if (!opened.ok) throw new Error("read failed");
  await f.service.request(
    p,
    "storage/delete",
    { id: c.id, expectedRevision: c.record.revision },
    signal(),
  );
  expect(
    await f.service.request(
      p,
      "storage/readChunk",
      { read: opened.value.read, offset: 0, maxBytes: 3 },
      signal(),
    ),
  ).toMatchObject({ ok: true, value: { data: "YWJj", eof: true } });
  expect(
    await f.service.request(
      p,
      "storage/readChunk",
      { read: opened.value.read, offset: 3, maxBytes: 3 },
      signal(),
    ),
  ).toMatchObject({ ok: true, value: { data: "", eof: true } });
  await f.service.request(p, "storage/closeRead", { read: opened.value.read }, signal());
  expect(
    await f.service.request(p, "storage/closeRead", { read: opened.value.read }, signal()),
  ).toEqual({ ok: true, value: {} });
  expect(
    await f.service.request(
      { ...p, owner: { ...owner, generation: 2 } },
      "storage/closeRead",
      { read: opened.value.read },
      signal(),
    ),
  ).toMatchObject({ error: { code: "PLUGIN_E_STALE_RESOURCE" } });
});
it("B2-12.1-3: idle expiry at exactly 30 seconds prevents append and preserves expired status", async () => {
  const f = fixture();
  const b = await f.begin(Buffer.from("x"));
  f.advance(30000);
  expect(
    await f.service.request(
      p,
      "storage/writeChunk",
      { write: b.write, offset: 0, data: "eA==" },
      signal(),
    ),
  ).toMatchObject({ ok: false });
  expect(f.append).not.toHaveBeenCalled();
  expect(
    await f.service.request(p, "storage/writeStatus", { write: b.write }, signal()),
  ).toMatchObject({ ok: true, value: { state: "expired" } });
});
it("B2-12.1-3: all list pages are immutable, bounded and owner/filter/limit bound", async () => {
  const f = fixture(),
    committed = await f.complete(new Uint8Array());
  for (let index = 1; index < 129; index++)
    f.records.set(String(index), {
      ...committed.record,
      id: String(index),
      createdAt: 1000 - index,
    });
  const first = await f.service.request(p, "storage/list", { limit: 64 }, signal());
  if (!first.ok || !first.value.nextCursor) throw new Error("cursor missing");
  f.records.clear();
  const second = await f.service.request(
    p,
    "storage/list",
    { limit: 64, cursor: first.value.nextCursor },
    signal(),
  );
  if (!second.ok || !second.value.nextCursor) throw new Error("second cursor missing");
  const third = await f.service.request(
    p,
    "storage/list",
    { limit: 64, cursor: second.value.nextCursor },
    signal(),
  );
  expect(first.value.entries).toHaveLength(64);
  expect(second.value.entries).toHaveLength(64);
  expect(third).toMatchObject({ ok: true, value: { entries: [{ id: "128" }] } });
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(262144);
  expect(
    await f.service.request(
      p,
      "storage/list",
      { limit: 64, cursor: first.value.nextCursor },
      signal(),
    ),
  ).toEqual(second);
  for (const params of [
    { limit: 63, cursor: first.value.nextCursor },
    { limit: 64, kind: "other", cursor: first.value.nextCursor },
  ])
    expect(await f.service.request(p, "storage/list", params, signal())).toMatchObject({
      error: { code: "PLUGIN_E_STALE_RESOURCE" },
    });
  expect(
    await f.service.request(
      { ...p, owner: { ...owner, generation: 2 } },
      "storage/list",
      { limit: 64, cursor: first.value.nextCursor },
      signal(),
    ),
  ).toMatchObject({ ok: false });
});
it("B2-12.1-3: four read pins and four independent list snapshots; closing frees a pin", async () => {
  const f = fixture(),
    committed = await f.complete(new Uint8Array());
  f.records.set("second", { ...committed.record, id: "second" });
  const handles: string[] = [];
  for (let index = 0; index < 4; index++) {
    const opened = await f.service.request(
      p,
      "storage/openRead",
      { id: committed.id, expectedRevision: committed.record.revision, schemaVersion: 1 },
      signal(),
    );
    if (!opened.ok) throw new Error("pin missing");
    handles.push(opened.value.read);
    expect(await f.service.request(p, "storage/list", { limit: 1 }, signal())).toMatchObject({
      ok: true,
    });
  }
  expect(
    await f.service.request(
      p,
      "storage/openRead",
      { id: committed.id, expectedRevision: committed.record.revision, schemaVersion: 1 },
      signal(),
    ),
  ).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  expect(await f.service.request(p, "storage/list", { limit: 1 }, signal())).toMatchObject({
    error: { code: "PLUGIN_E_RESOURCE_LIMIT" },
  });
  await f.service.request(p, "storage/closeRead", { read: handles[0]! }, signal());
  expect(
    await f.service.request(
      p,
      "storage/openRead",
      { id: committed.id, expectedRevision: committed.record.revision, schemaVersion: 1 },
      signal(),
    ),
  ).toMatchObject({ ok: true });
  f.advance(30000);
  expect(await f.service.request(p, "storage/list", { limit: 1 }, signal())).toMatchObject({
    ok: true,
  });
});
it("B2-RF1: an uncertain delete retains its ticket, blocks flush and only reconciles", async () => {
  const f = fixture(),
    committed = await f.complete(new Uint8Array());
  const publish = f.deps.engine.publish;
  f.deps.engine.publish = vi.fn(async () => ({ disposition: "unknown" as const }));
  f.deps.engine.reconcile = vi.fn((ticket) => publish(ticket));
  const params = { id: committed.id, expectedRevision: committed.record.revision };
  expect(await f.service.request(p, "storage/delete", params, signal())).toMatchObject({
    error: { detail: { disposition: "unknown" } },
  });
  expect(await f.service.request(p, "storage/flush", {}, signal())).toMatchObject({ ok: false });
  const resolved = await f.service.request(p, "storage/delete", params, signal());
  expect(resolved).toMatchObject({ ok: true });
  expect(await f.service.request(p, "storage/delete", params, signal())).toEqual(resolved);
  expect(f.deps.engine.publish).toHaveBeenCalledOnce();
  expect(f.deps.engine.reconcile).toHaveBeenCalledOnce();
});
it("B2-12.1-3: I/O during seal is not checksum mismatch; original bytes can seal again", async () => {
  const f = fixture(),
    begin = await f.begin(new Uint8Array());
  const seal = f.deps.engine.seal;
  f.deps.engine.seal = vi
    .fn()
    .mockRejectedValueOnce(new Error("/private/path"))
    .mockImplementation(seal);
  const failed = await f.service.request(p, "storage/sealWrite", { write: begin.write }, signal());
  expect(failed).toMatchObject({
    error: { code: "PLUGIN_E_STORAGE_IO", detail: { reason: "io" } },
  });
  expect(JSON.stringify(failed)).not.toContain("/private/path");
  expect(
    await f.service.request(p, "storage/sealWrite", { write: begin.write }, signal()),
  ).toMatchObject({ ok: true });
});
it("B2-12.1-3: progress never extends a write past its original 120-second cap", async () => {
  const f = fixture(),
    begin = await f.begin(Buffer.from("abcde"));
  for (let index = 0; index < 4; index++) {
    f.advance(25000);
    expect(
      await f.service.request(
        p,
        "storage/writeChunk",
        {
          write: begin.write,
          offset: index,
          data: Buffer.from("abcde"[index]!).toString("base64"),
        },
        signal(),
      ),
    ).toMatchObject({ ok: true });
  }
  f.advance(20000);
  expect(
    await f.service.request(
      p,
      "storage/writeChunk",
      { write: begin.write, offset: 4, data: "ZQ==" },
      signal(),
    ),
  ).toMatchObject({ ok: false });
  expect(f.append).toHaveBeenCalledTimes(4);
});

import type { StoredRecovery } from "./engine-port.js";
import type { PersistenceEvidencePort } from "./engine-port.js";
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

it("B2-RF1: cancellation after dispatch retains the ticket and target until reconciliation", async () => {
  const f = fixture(),
    initial = await f.complete(new Uint8Array());
  const controller = new AbortController();
  const params: RecordWrite = {
    ...input(new Uint8Array()),
    target: {
      mode: "replace",
      id: initial.id,
      expectedRevision: initial.record.revision,
    },
  };
  const begun = await f.service.request(p, "storage/beginWrite", params, signal());
  if (!begun.ok) throw new Error("begin failed");
  const write = begun.value.write;
  await f.service.request(p, "storage/sealWrite", { write }, signal());
  const originalPublish = f.deps.engine.publish;
  f.deps.engine.publish = vi.fn(async () => {
    controller.abort();
    throw new Error("/private/publish-ack-lost");
  });
  f.deps.engine.reconcile = vi.fn((ticket) => originalPublish(ticket));
  const uncertain = await f.service.request(p, "storage/commitWrite", { write }, controller.signal);
  expect(uncertain).toMatchObject({ error: { detail: { disposition: "unknown" } } });
  expect(JSON.stringify(uncertain)).not.toContain("/private");
  expect(await f.service.request(p, "storage/beginWrite", params, signal())).toMatchObject({
    error: { detail: { reason: "write-in-progress" } },
  });
  expect(await f.service.request(p, "storage/flush", {}, signal())).toMatchObject({ ok: false });
  const resolved = await f.service.request(p, "storage/commitWrite", { write }, controller.signal);
  expect(resolved).toMatchObject({ ok: true, value: { receipt: { commitId: write } } });
  expect(await f.service.request(p, "storage/commitWrite", { write }, signal())).toEqual(resolved);
  expect(f.deps.engine.publish).toHaveBeenCalledOnce();
  expect(f.deps.engine.reconcile).toHaveBeenCalledOnce();
  expect(vi.mocked(f.deps.engine.reconcile).mock.calls[0]![0]).toBe(
    vi.mocked(f.deps.engine.publish).mock.calls[0]![0],
  );
});

it("rejects plugin-to-host storage/drain before checkpoint callbacks", async () => {
  const f = fixture();
  await expect(
    f.service.request(
      p,
      "storage/drain",
      {
        token: owner.hostEpoch,
        reason: "disable",
        remainingMs: 10000,
        checkpoints: [],
        writes: [],
      },
      signal(),
    ),
  ).rejects.toThrow("Host-only method direction.");
});

it("T5 projections preserve original admission timestamps and await pending work", async () => {
  const f = fixture(),
    bytes = new Uint8Array([1]);
  const begun = await f.service.request(p, "storage/beginWrite", input(bytes), signal());
  if (!begun.ok) throw new Error("begin failed");
  const first = f.service.admittedWrites(owner)[0]!;
  expect(first.created).toBe(0);
  expect(first.progress).toBe(0);
  let release!: () => void;
  f.deps.engine.append = async () => {
    await new Promise<void>((r) => (release = r));
    return 1;
  };
  const writing = f.service.request(
    p,
    "storage/writeChunk",
    { write: begun.value.write, offset: 0, data: "AQ==" },
    signal(),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const projected = f.service.admittedWrites(owner)[0]!;
  let settled = false;
  void projected.pending.then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await writing;
  expect(f.service.admittedWrites(owner)[0]!.ticket.id).toBe(first.ticket.id);
  expect(f.service.admittedWrites({ ...owner, generation: 2 })).toEqual([]);
  await f.service.close();
});
it("T5 releases proactive sealed pins after a known commit without retaining read slots", async () => {
  const f = fixture(),
    bytes = new Uint8Array();
  f.deps.retainForRecovery = true;
  f.deps.evidence.retainSealed = async () => ({ pin: "sealed-pin", expiresMonotonicMs: 30000 });
  f.deps.read.close = vi.fn(async () => {});
  const begun = await f.service.request(p, "storage/beginWrite", input(bytes), signal());
  if (!begun.ok) throw new Error("begin failed");
  expect(
    (await f.service.request(p, "storage/sealWrite", { write: begun.value.write }, signal())).ok,
  ).toBe(true);
  expect(f.service.admittedWrites(owner)[0]!.retained?.pin).toBe("sealed-pin");
  expect(
    (await f.service.request(p, "storage/commitWrite", { write: begun.value.write }, signal())).ok,
  ).toBe(true);
  await f.service.close();
  expect(f.deps.read.close).toHaveBeenCalledWith(owner, "sealed-pin");
  expect(f.service.admittedWrites(owner)[0]!.retained).toBeUndefined();
});
it("T5 projects a pending reserve promise before beginWrite acknowledges admission", async () => {
  const f = fixture();
  let release!: () => void;
  f.deps.engine.reserve = async () => {
    await new Promise<void>((r) => (release = r));
  };
  const pending = f.service.request(p, "storage/beginWrite", input(new Uint8Array()), signal());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  let settled = false;
  void f.service.admittedWrites(owner)[0]!.pending.then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect((await pending).ok).toBe(true);
});

it("fractional monotonic clocks produce schema-valid write/read results without rounding admission", async () => {
  const f = fixture();
  let now = 0.25;
  f.deps.now = () => (now += 0.125);
  f.deps.wall = () => 100000 + Math.floor(now);
  const begun = await f.service.request(p, "storage/beginWrite", input(Buffer.from("x")), signal());
  storageRequestSchemas["storage/beginWrite"].result.parse(begun);
  if (!begun.ok) throw new Error("begin failed");
  const admitted = f.service.admittedWrites(owner)[0]!;
  expect(admitted.created % 1).not.toBe(0);
  expect(admitted.ticket.deadlineMonotonicMs).toBe(admitted.created + 120000);
  expect(begun.value.expiresAt).toBe(Math.floor(f.deps.wall() + admitted.created + 30000 - now));
  const chunk = { write: begun.value.write, offset: 0, data: "eA==" };
  const written = await f.service.request(p, "storage/writeChunk", chunk, signal());
  storageRequestSchemas["storage/writeChunk"].result.parse(written);
  const progressed = f.service.admittedWrites(owner)[0]!;
  expect(progressed.progress).toBeGreaterThan(admitted.progress);
  expect(await f.service.request(p, "storage/writeChunk", chunk, signal())).toEqual(written);
  expect(f.service.admittedWrites(owner)[0]!.progress).toBe(progressed.progress);
  const sealed = await f.service.request(
    p,
    "storage/sealWrite",
    { write: begun.value.write },
    signal(),
  );
  storageRequestSchemas["storage/sealWrite"].result.parse(sealed);
  const status = await f.service.request(
    p,
    "storage/writeStatus",
    { write: begun.value.write },
    signal(),
  );
  storageRequestSchemas["storage/writeStatus"].result.parse(status);
  await f.service.request(p, "storage/commitWrite", { write: begun.value.write }, signal());
  const committed = f.records.get(begun.value.id)!;
  const opened = await f.service.request(
    p,
    "storage/openRead",
    {
      id: committed.id,
      expectedRevision: committed.revision,
      schemaVersion: 1,
    },
    signal(),
  );
  storageRequestSchemas["storage/openRead"].result.parse(opened);
  expect(opened.ok).toBe(true);
  await f.service.close();
});

it("fractional idle deadlines admit until the exact original boundary and clamp old status to zero", async () => {
  const f = fixture();
  let now = 0.375;
  f.deps.now = () => now;
  f.deps.wall = () => 0;
  const begun = await f.begin(Buffer.from("x"));
  now = 30000.25;
  expect(
    await f.service.request(p, "storage/writeStatus", { write: begun.write }, signal()),
  ).toMatchObject({ ok: true, value: { state: "receiving", expiresAt: 0 } });
  now = 30000.375;
  expect(
    await f.service.request(
      p,
      "storage/writeChunk",
      { write: begun.write, offset: 0, data: "eA==" },
      signal(),
    ),
  ).toMatchObject({ ok: false });
  expect(f.append).not.toHaveBeenCalled();
  const expired = await f.service.request(
    p,
    "storage/writeStatus",
    { write: begun.write },
    signal(),
  );
  storageRequestSchemas["storage/writeStatus"].result.parse(expired);
  expect(expired).toMatchObject({ ok: true, value: { state: "expired", expiresAt: 0 } });
});
