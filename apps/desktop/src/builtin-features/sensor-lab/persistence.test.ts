import { expect, it, vi } from "vitest";
import type { RecordMeta } from "@kobrixa/plugin-protocol";
import {
  RecordingWriter,
  type LabStorage,
  type SaveOptions,
} from "../../../../../plugins/sensor-lab/src/persistence.js";
import { recording } from "./data.test.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ok = <T>(value: T) => ({ ok: true as const, value });
function setup() {
  let metadata: RecordMeta;
  let state = "receiving";
  let receivedBytes = 0;
  const beginWrite = vi.fn<LabStorage["beginWrite"]>(async (p) => {
    metadata = {
      ...p,
      id: id(10),
      revision: "1",
      createdAt: 0,
      updatedAt: 0,
      checkpoint: "none",
      interrupted: false,
    };
    state = "receiving";
    receivedBytes = 0;
    return ok({ write: id(11), id: id(10), expiresAt: 10000 });
  });
  const writeChunk = vi.fn<LabStorage["writeChunk"]>(async (p) => {
    receivedBytes += Buffer.from(p.data, "base64").length;
    return ok({ receivedBytes, expiresAt: 10000 });
  });
  const sealWrite = vi.fn<LabStorage["sealWrite"]>(async () => {
    state = "sealed";
    return ok({ write: id(11), id: id(10), state: "sealed", receivedBytes, expiresAt: 10000 });
  });
  const commitWrite = vi.fn<LabStorage["commitWrite"]>(async () => {
    state = "committed";
    return ok({
      record: metadata,
      receipt: {
        revision: metadata.revision,
        commitId: id(12),
        durability: "file-and-directory-sync",
      },
    });
  });
  const writeStatus = vi.fn<LabStorage["writeStatus"]>(async () =>
    ok({
      write: id(11),
      id: id(10),
      state: state as "receiving" | "sealed" | "committed",
      receivedBytes,
      expiresAt: 10000,
    }),
  );
  const storage = {
    beginWrite,
    writeChunk,
    sealWrite,
    commitWrite,
    writeStatus,
    list: vi.fn<LabStorage["list"]>(async () => ok({ entries: [] })),
    quota: vi.fn<LabStorage["quota"]>(async () =>
      ok({
        recordCount: 0,
        reservedCreates: 0,
        committedBytes: 0,
        reservedBytes: 0,
        pinnedBytes: 0,
        temporaryBytes: 0,
        sourceLimitBytes: 536870912,
        sourceLimitRecords: 256,
        hostAvailableBytes: 1073741824,
        writeSlotsAvailable: 2,
        exportSlotsAvailable: 2,
      }),
    ),
  } as unknown as LabStorage;
  const model = { ...recording(), id: id(1) };
  return {
    storage,
    beginWrite,
    writeChunk,
    sealWrite,
    commitWrite,
    writeStatus,
    model,
    writer: new RecordingWriter(storage),
  };
}
it("keeps payload identity separate from host identity and replaces the confirmed revision", async () => {
  const f = setup();
  const first = await f.writer.save(f.model);
  expect(first.id).toBe(id(10));
  const bytes = Buffer.concat(f.writeChunk.mock.calls.map(([p]) => Buffer.from(p.data, "base64")));
  expect(JSON.parse(bytes.toString()).id).toBe(id(1));
  await f.writer.save({ ...f.model, name: "next" });
  expect(f.beginWrite.mock.calls[1]![0].target).toEqual({
    mode: "replace",
    id: id(10),
    expectedRevision: first.revision,
  });
});
it("reconciles an uncertain commit with the original write before another CAS", async () => {
  const f = setup();
  f.commitWrite.mockRejectedValueOnce(new Error("reply lost"));
  await expect(f.writer.save(f.model)).rejects.toThrow();
  expect(f.writer.current).toBeUndefined();
  expect(f.writer.committedWrite).toBeUndefined();
  expect(f.writer.pendingWrite).toBe(id(11));
  const drain = new AbortController();
  await f.writer.reconcile({ signal: drain.signal });
  expect(f.beginWrite).toHaveBeenCalledTimes(1);
  expect(f.commitWrite.mock.calls[1]).toEqual([{ write: id(11) }, drain.signal]);
  expect(f.writer.current?.id).toBe(id(10));
  expect(f.writer.committedWrite).toBe(id(11));
});
it("fences an unknown begin result instead of creating another logical record", async () => {
  const f = setup();
  f.beginWrite.mockRejectedValueOnce(new Error("lost begin"));
  await expect(f.writer.save(f.model)).rejects.toThrow();
  await expect(f.writer.save(f.model)).rejects.toThrow();
  expect(f.beginWrite).toHaveBeenCalledTimes(1);
});
it("uses the independent drain client and carries original checkpoint and token", async () => {
  const f = setup();
  const other = setup();
  await f.writer.save(f.model);
  const signal = new AbortController().signal;
  await f.writer.save(
    { ...f.model, reason: "manual", endedAt: 10 },
    {
      storage: other.storage,
      signal,
      checkpoint: { handle: id(30), phase: "final" },
      drainToken: id(31),
    },
  );
  expect(other.beginWrite).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { mode: "replace", id: id(10), expectedRevision: "1" },
      checkpoint: { handle: id(30), phase: "final" },
      drainToken: id(31),
    }),
    signal,
  );
  expect(other.storage.quota).not.toHaveBeenCalled();
  expect(other.storage.list).not.toHaveBeenCalled();
  expect(other.commitWrite).toHaveBeenCalledWith({ write: id(11), drainToken: id(31) }, signal);
});
it("retains immutable bytes across a chunk failure and resumes at confirmed offset", async () => {
  const f = setup();
  f.writeChunk.mockRejectedValueOnce(new Error("chunk reply lost"));
  await expect(f.writer.save(f.model)).rejects.toThrow();
  f.model.name = "mutated after start";
  await f.writer.reconcile();
  expect(f.beginWrite).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(Buffer.from(f.writeChunk.mock.calls[1]![0].data, "base64").toString()).name,
  ).toBe("trial");
});
it("rejects overlapping save and a foreign model identity without changing the head", async () => {
  const f = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const original = f.commitWrite.getMockImplementation()!;
  f.commitWrite.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  const job = f.writer.save(f.model);
  await vi.waitFor(() => expect(f.commitWrite).toHaveBeenCalledTimes(1));
  await expect(f.writer.save(f.model)).rejects.toThrow(/busy/i);
  release();
  await job;
  await expect(f.writer.save({ ...f.model, id: id(2) })).rejects.toThrow(/identity/i);
});
it("rejects full history and quota before starting a write", async () => {
  const f = setup();
  vi.mocked(f.storage.list).mockResolvedValueOnce(
    ok({ entries: Array(50).fill({}) as RecordMeta[] }),
  );
  await expect(f.writer.save(f.model)).rejects.toThrow(/history/i);
  expect(f.beginWrite).not.toHaveBeenCalled();
  const quota = await f.storage.quota({});
  if (!quota.ok) throw new Error("quota fixture");
  vi.mocked(f.storage.quota).mockResolvedValueOnce(ok({ ...quota.value, writeSlotsAvailable: 0 }));
  await expect(f.writer.save(f.model)).rejects.toThrow(/quota/i);
  expect(f.beginWrite).not.toHaveBeenCalled();
});
it("splits bounded chunks and verifies staged bytes with the committed digest", async () => {
  const f = setup();
  const frame = f.model.frames[0]!;
  const frames = Array.from({ length: 3600 }, (_, sequence) => ({ ...frame, sequence }));
  await f.writer.save({ ...f.model, frames, frameCount: frames.length });
  expect(f.writeChunk.mock.calls.length).toBeGreaterThan(1);
  let offset = 0;
  for (const [chunk] of f.writeChunk.mock.calls) {
    expect(chunk.offset).toBe(offset);
    const bytes = Buffer.from(chunk.data, "base64");
    expect(bytes.length).toBeLessThanOrEqual(262144);
    offset += bytes.length;
  }
  expect(f.writer.current?.byteLength).toBe(offset);
});
it("does not advance the confirmed head for a mismatched receipt", async () => {
  const f = setup();
  const original = f.commitWrite.getMockImplementation()!;
  f.commitWrite.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    if (!result.ok) throw Error("fixture");
    return ok({ ...result.value, record: { ...result.value.record, sha256: "0".repeat(64) } });
  });
  await expect(f.writer.save(f.model)).rejects.toThrow(/receipt/i);
  expect(f.writer.current).toBeUndefined();
  expect(f.writer.committedWrite).toBeUndefined();
  expect(f.writer.pendingWrite).toBe(id(11));
  await f.writer.reconcile();
  expect(f.beginWrite).toHaveBeenCalledTimes(1);
  expect(f.writer.current?.id).toBe(id(10));
  expect(f.writer.committedWrite).toBe(id(11));
});

it("snapshots options and checkpoint before save awaits while preserving the original signal", async () => {
  const f = setup();
  await f.writer.save(f.model);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.beginWrite.getMockImplementation()!;
  f.beginWrite.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  const controller = new AbortController();
  const options: SaveOptions = {
    storage: f.storage,
    signal: controller.signal,
    checkpoint: { handle: id(30), phase: "final" },
    drainToken: id(31),
  };
  const job = f.writer.save(f.model, options);
  options.storage = setup().storage;
  options.signal = new AbortController().signal;
  options.checkpoint!.handle = id(99);
  options.checkpoint!.phase = "checkpoint";
  options.drainToken = id(99);
  release();
  await job;
  expect(f.beginWrite.mock.lastCall).toEqual([
    expect.objectContaining({ checkpoint: { handle: id(30), phase: "final" }, drainToken: id(31) }),
    controller.signal,
  ]);
  expect(f.commitWrite.mock.lastCall).toEqual([
    { write: id(11), drainToken: id(31) },
    controller.signal,
  ]);
});

it("snapshots reconcile options before status awaits and rejects a changed checkpoint", async () => {
  const f = setup();
  await f.writer.save(f.model);
  f.commitWrite.mockRejectedValueOnce(new Error("reply lost"));
  await expect(
    f.writer.save(f.model, { checkpoint: { handle: id(30), phase: "final" }, drainToken: id(31) }),
  ).rejects.toThrow();
  await expect(
    f.writer.reconcile({ checkpoint: { handle: id(99), phase: "final" } }),
  ).rejects.toMatchObject({ code: "drain" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.writeStatus.getMockImplementation()!;
  f.writeStatus.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  const signal = new AbortController().signal;
  const options: SaveOptions = { storage: f.storage, signal, drainToken: id(31) };
  const job = f.writer.reconcile(options);
  options.storage = setup().storage;
  options.signal = new AbortController().signal;
  options.drainToken = id(99);
  release();
  await job;
  expect(f.commitWrite.mock.lastCall).toEqual([{ write: id(11), drainToken: id(31) }, signal]);
});

it.each(["expired", "failed"] as const)(
  "does not reset a confirmed %s replacement",
  async (state) => {
    const f = setup();
    await f.writer.save(f.model);
    f.commitWrite.mockRejectedValueOnce(new Error("reply lost"));
    await expect(f.writer.save(f.model)).rejects.toThrow();
    const pending = f.writer.pendingWrite;
    f.writeStatus.mockResolvedValueOnce(
      ok({ write: id(11), id: id(10), state, receivedBytes: 0, expiresAt: 0 }),
    );
    await expect(f.writer.save(f.model)).rejects.toMatchObject({ code: "terminal" });
    expect(f.writer.pendingWrite).toBe(pending);
    expect(f.writer.terminalWrite?.state).toBe(state);
    expect(f.beginWrite).toHaveBeenCalledTimes(2);
  },
);
