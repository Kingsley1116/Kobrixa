import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RecordMeta } from "@kobrixa/plugin-protocol";
import { LabLibrary } from "../../../../../plugins/sensor-lab/src/library.js";
import type { LabStorage } from "../../../../../plugins/sensor-lab/src/persistence.js";
import { recording } from "./data.test.js";
function fixture(raw: unknown = recording(), kind: RecordMeta["kind"] = "sensor-lab.recording") {
  const bytes = Buffer.from(JSON.stringify(raw)),
    id = randomUUID();
  const meta: RecordMeta = {
    id,
    revision: randomUUID(),
    kind,
    schemaVersion: 2,
    label: "Trial",
    mediaType: "application/json",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: 0,
    updatedAt: 0,
    checkpoint: "final",
    interrupted: false,
  };
  const storage = {
    list: vi.fn(async () => ({ ok: true as const, value: { entries: [meta] } })),
    openRead: vi.fn(async () => ({
      ok: true as const,
      value: { read: "read", record: meta, expiresAt: 1000 },
    })),
    readChunk: vi.fn(async ({ offset }: { offset: number }) => {
      const end = Math.min(offset + 100, bytes.length);
      return {
        ok: true as const,
        value: {
          offset,
          nextOffset: end,
          eof: end === bytes.length,
          data: bytes.subarray(offset, end).toString("base64"),
        },
      };
    }),
    closeRead: vi.fn(async () => ({ ok: true as const, value: {} })),
    delete: vi.fn(async () => ({ ok: true as const, value: { deleted: true as const } })),
  };
  return { bytes, meta, storage, library: new LabLibrary(storage as unknown as LabStorage) };
}
it("reads a bounded selected host revision without confusing payload UUID with storage ID", async () => {
  const f = fixture();
  expect(await f.library.read(f.meta)).toEqual(recording());
  expect(f.storage.openRead).toHaveBeenCalledWith(
    { id: f.meta.id, expectedRevision: f.meta.revision, schemaVersion: 2 },
    undefined,
  );
  expect(f.storage.readChunk.mock.calls.length).toBeGreaterThan(1);
  expect(f.storage.closeRead).toHaveBeenCalledWith({ read: "read" });
});
it("rejects hash, metadata and stalled reads and closes each admitted pin", async () => {
  for (const mode of ["hash", "metadata", "stalled"] as const) {
    const f = fixture();
    if (mode === "hash") f.bytes[0] = 0;
    if (mode === "metadata")
      f.storage.openRead.mockResolvedValueOnce({
        ok: true,
        value: { read: "read", expiresAt: 1000, record: { ...f.meta, id: randomUUID() } },
      });
    if (mode === "stalled")
      f.storage.readChunk.mockResolvedValueOnce({
        ok: true,
        value: { offset: 0, nextOffset: 0, eof: false, data: "" },
      });
    await expect(f.library.read(f.meta)).rejects.toThrow();
    expect(f.storage.closeRead).toHaveBeenCalledOnce();
  }
});
it("validates calibration payload before exposing its immutable snapshot", async () => {
  const p = {
    schemaVersion: 2,
    id: randomUUID(),
    name: "Calibration",
    ...recording().channels[0]!,
  };
  const f = fixture(p, "sensor-lab.calibration");
  const result = await f.library.read(f.meta);
  expect(result).toEqual(p);
  expect(Object.isFrozen(result)).toBe(true);
  const invalid = fixture(
    { ...p, calibration: { ...p.calibration, targetA: "bad" } },
    "sensor-lab.calibration",
  );
  await expect(invalid.library.read(invalid.meta)).rejects.toThrow();
  expect(invalid.storage.closeRead).toHaveBeenCalledOnce();
});
it("keeps deletion on selected CAS and refuses active or unresolved targets", async () => {
  const f = fixture();
  await expect(f.library.remove(f.meta, new Set([f.meta.id]))).rejects.toThrow();
  await expect(f.library.remove({ ...f.meta, checkpoint: "open" }, new Set())).rejects.toThrow();
  expect(f.storage.delete).not.toHaveBeenCalled();
  await f.library.remove(f.meta, new Set());
  expect(f.storage.delete).toHaveBeenCalledWith(
    { id: f.meta.id, expectedRevision: f.meta.revision },
    undefined,
  );
});
it("lists a bounded page of the declared kind and rejects foreign schemas", async () => {
  const f = fixture();
  expect((await f.library.list("sensor-lab.recording")).entries).toEqual([f.meta]);
  expect(f.storage.list).toHaveBeenCalledWith(
    { kind: "sensor-lab.recording", limit: 50 },
    undefined,
  );
  await expect(f.library.list("sensor-lab.calibration")).rejects.toThrow();
  f.meta.schemaVersion = 9;
  await expect(f.library.list("sensor-lab.recording")).rejects.toThrow();
});
