import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceOperationError, type DeviceSession, type RemoteEntry } from "@kobrixa/device";
import { FileBatchManager } from "./file-batch.js";
import type { FileBatchRequest, FileBatchSnapshot } from "../shared/api.js";
const ROOT = "/home/root/lms2012/prjs";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kobrixa-batch-"));
  directories.push(dir);
  const files = new Map<string, Buffer | null>([[ROOT, null]]);
  const writes: string[] = [],
    events: FileBatchSnapshot[] = [];
  let locked = false;
  const abort = new AbortController();
  const session = {
    descriptor: { id: "mock", name: "EV3", transport: "mock" as const },
    connected: true,
    list: vi.fn(async (directory: string): Promise<RemoteEntry[]> => {
      if (files.get(directory) !== null)
        throw new DeviceOperationError("not-found", "Missing folder");
      return [...files]
        .filter(([p]) => p !== directory && path.posix.dirname(p) === directory)
        .map(([p, value]) => ({
          path: p,
          name: path.posix.basename(p),
          kind: value === null ? "directory" : "file",
          ...(value === null
            ? {}
            : { size: value.length, checksum: createHash("md5").update(value).digest("hex") }),
        }));
    }),
    uploadStream: vi.fn(async (p: string, _size: number, chunks: AsyncIterable<Uint8Array>) => {
      writes.push(p);
      const parts: Uint8Array[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      files.set(p, Buffer.concat(parts));
    }),
    download: vi.fn(async (p: string, sink: (chunk: Uint8Array) => Promise<void>) => {
      await sink(files.get(p)! as Buffer);
    }),
    createDirectory: vi.fn(async (p: string) => {
      writes.push(p);
      files.set(p, null);
    }),
    delete: vi.fn(async (p: string) => {
      writes.push(p);
      for (const key of files.keys()) if (key === p || key.startsWith(`${p}/`)) files.delete(key);
    }),
    upload: vi.fn(),
    rename: vi.fn(),
    disconnect: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
  } satisfies DeviceSession;
  const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [dir] })) };
  const changed = vi.fn();
  const manager = new FileBatchManager(
    async (_id, work) => {
      if (locked) throw new Error("busy");
      locked = true;
      try {
        return await work(session, abort.signal);
      } finally {
        locked = false;
      }
    },
    dialog,
    (event) => events.push(event),
    changed,
  );
  const request: FileBatchRequest = {
    sessionId: "session",
    requestId: "request",
    path: ROOT,
    action: "upload",
    paths: [],
    source: "folders",
    locale: "en",
  };
  const prepare = (patch: Partial<FileBatchRequest> = {}, owner = 1) =>
    manager.prepare({ ...request, ...patch }, owner);
  return {
    dir,
    files,
    writes,
    events,
    session,
    dialog,
    manager,
    prepare,
    changed,
    abort,
    locked: () => locked,
  };
}
describe("prepared EV3 batches", () => {
  it("preserves nested/empty folders and empty files, and reserves the device through confirmation", async () => {
    const h = await setup();
    await mkdir(path.join(h.dir, "robot", "empty"), { recursive: true });
    await writeFile(path.join(h.dir, "robot", "main.rbf"), "program");
    await writeFile(path.join(h.dir, "robot", "zero.rbf"), "");
    h.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(h.dir, "robot"), path.join(h.dir, "robot", "empty")],
    });
    const plan = await h.prepare();
    expect(plan.phase).toBe("ready");
    expect(plan.items).toHaveLength(4);
    expect(h.locked()).toBe(true);
    expect(h.writes).toEqual([]);
    const result = await h.manager.execute(plan, "skip", 1);
    expect(result.phase).toBe("complete");
    expect(h.locked()).toBe(false);
    expect(h.files.get(`${ROOT}/robot/empty`)).toBeNull();
    expect(h.files.get(`${ROOT}/robot/zero.rbf`)).toEqual(Buffer.alloc(0));
    expect(h.files.get(`${ROOT}/robot/main.rbf`)?.toString()).toBe("program");
  });
  it("merges folders, preserves extra contents and supports explicit skip/replace", async () => {
    const h = await setup();
    await mkdir(path.join(h.dir, "robot"));
    await writeFile(path.join(h.dir, "robot", "same"), "new");
    h.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(h.dir, "robot")],
    });
    h.files.set(`${ROOT}/robot`, null);
    h.files.set(`${ROOT}/robot/same`, Buffer.from("old"));
    h.files.set(`${ROOT}/robot/extra`, Buffer.from("keep"));
    let plan = await h.prepare();
    expect(plan.items.filter((i) => i.conflict)).toHaveLength(1);
    expect((await h.manager.execute(plan, "skip", 1)).items.at(-1)?.status).toBe("skipped");
    expect(h.files.get(`${ROOT}/robot/same`)?.toString()).toBe("old");
    plan = await h.prepare();
    await h.manager.execute(plan, "replace", 1);
    expect(h.files.get(`${ROOT}/robot/same`)?.toString()).toBe("new");
    expect(h.files.get(`${ROOT}/robot/extra`)?.toString()).toBe("keep");
  });
  it("blocks preflight type conflicts, unsupported names and symbolic links without writing", async () => {
    const h = await setup();
    await writeFile(path.join(h.dir, "a"), "a");
    await writeFile(path.join(h.dir, "bad#name"), "x");
    await symlink(path.join(h.dir, "a"), path.join(h.dir, "link"));
    h.files.set(`${ROOT}/a`, null);
    h.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(h.dir, "a"), path.join(h.dir, "bad#name"), path.join(h.dir, "link")],
    });
    const plan = await h.prepare();
    expect(plan.phase).toBe("failed");
    expect(plan.issues).toHaveLength(3);
    expect(h.writes).toEqual([]);
  });
  it("refuses duplicate destinations and protected storage roots", async () => {
    const h = await setup();
    await mkdir(path.join(h.dir, "one"));
    await mkdir(path.join(h.dir, "two"));
    await writeFile(path.join(h.dir, "one", "same"), "1");
    await writeFile(path.join(h.dir, "two", "same"), "2");
    h.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(h.dir, "one", "same"), path.join(h.dir, "two", "same")],
    });
    expect((await h.prepare()).phase).toBe("failed");
    expect((await h.prepare({ action: "delete", paths: [`${ROOT}/SD_Card`] })).phase).toBe(
      "failed",
    );
    expect(h.writes).toEqual([]);
  });
  it("stops at new conflicts and at the first failed write, leaving later items pending", async () => {
    const h = await setup();
    for (const name of ["a", "b", "c"]) await writeFile(path.join(h.dir, name), name);
    h.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["a", "b", "c"].map((n) => path.join(h.dir, n)),
    });
    let plan = await h.prepare();
    h.files.set(`${ROOT}/b`, Buffer.from("unexpected"));
    let result = await h.manager.execute(plan, "replace", 1);
    expect(result.items.map((i) => i.status)).toEqual(["succeeded", "failed", "pending"]);
    expect(h.writes).toEqual([`${ROOT}/a`]);
    h.files.delete(`${ROOT}/b`);
    h.writes.length = 0;
    plan = await h.prepare();
    h.session.uploadStream.mockRejectedValueOnce(new DeviceOperationError("transfer", "disk full"));
    result = await h.manager.execute(plan, "replace", 1);
    expect(result.items.map((i) => i.status)).toEqual(["failed", "pending", "pending"]);
    expect(h.session.uploadStream).toHaveBeenCalledTimes(2);
  });
  it("waits for the current transfer before stopping and refuses duplicate/foreign execution", async () => {
    const h = await setup();
    for (const name of ["a", "b"]) await writeFile(path.join(h.dir, name), name);
    h.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["a", "b"].map((n) => path.join(h.dir, n)),
    });
    const plan = await h.prepare(),
      gate = deferred<void>();
    await expect(h.manager.execute(plan, "replace", 2)).rejects.toThrow("expired");
    await expect(h.manager.execute({ ...plan, requestId: "stale" }, "replace", 1)).rejects.toThrow(
      "expired",
    );
    h.session.uploadStream.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const execution = h.manager.execute(plan, "replace", 1);
    await vi.waitFor(() => expect(h.session.uploadStream).toHaveBeenCalledOnce());
    await expect(h.manager.execute(plan, "replace", 1)).rejects.toThrow("confirmation");
    await h.manager.stop(plan, 1);
    expect(h.locked()).toBe(true);
    gate.resolve();
    const result = await execution;
    expect(result.phase).toBe("stopped");
    expect(result.items.map((i) => i.status)).toEqual(["succeeded", "pending"]);
    expect(h.locked()).toBe(false);
  });
  it("releases a cancelled confirmation and a disconnected waiting plan", async () => {
    const h = await setup();
    h.files.set(`${ROOT}/a`, Buffer.from("a"));
    const plan = await h.prepare({ action: "delete", paths: [`${ROOT}/a`] });
    await h.manager.stop(plan, 1);
    expect(h.locked()).toBe(false);
    expect(h.writes).toEqual([]);
    const next = await h.prepare({ action: "delete", paths: [`${ROOT}/a`] });
    h.abort.abort();
    await vi.waitFor(() => expect(h.locked()).toBe(false));
    await expect(h.manager.execute(next, "skip", 1)).rejects.toThrow("expired");
  });
  it("abandons a prepared plan when its owning window leaves, without deleting anything", async () => {
    const h = await setup();
    h.files.set(`${ROOT}/a`, Buffer.from("keep"));
    const plan = await h.prepare({ action: "delete", paths: [`${ROOT}/a`] });
    h.manager.abandonOwner(1);
    await vi.waitFor(() => expect(h.locked()).toBe(false));
    expect(h.writes).toEqual([]);
    await expect(h.manager.execute(plan, "replace", 1)).rejects.toThrow("expired");
  });
  it("downloads nested/empty contents and validates before replacing a local file", async () => {
    const h = await setup();
    h.files.set(`${ROOT}/robot`, null);
    h.files.set(`${ROOT}/robot/empty`, null);
    h.files.set(`${ROOT}/robot/zero`, Buffer.alloc(0));
    h.files.set(`${ROOT}/robot/a`, Buffer.from("remote"));
    let plan = await h.prepare({ action: "download", paths: [`${ROOT}/robot`] });
    expect((await h.manager.execute(plan, "skip", 1)).phase).toBe("complete");
    expect(await readFile(path.join(h.dir, "robot", "a"), "utf8")).toBe("remote");
    expect(await readdir(path.join(h.dir, "robot", "empty"))).toEqual([]);
    h.files.set(`${ROOT}/robot/a`, Buffer.from("next"));
    plan = await h.prepare({
      action: "download",
      path: `${ROOT}/robot`,
      paths: [`${ROOT}/robot/a`],
    });
    await writeFile(path.join(h.dir, "a"), "new conflict");
    expect((await h.manager.execute(plan, "replace", 1)).phase).toBe("failed");
    expect(await readFile(path.join(h.dir, "a"), "utf8")).toBe("new conflict");
    plan = await h.prepare({
      action: "download",
      path: `${ROOT}/robot`,
      paths: [`${ROOT}/robot/a`],
    });
    h.session.download.mockImplementationOnce(async (_p, sink) => {
      await sink(Buffer.from("bad"));
    });
    expect((await h.manager.execute(plan, "replace", 1)).phase).toBe("failed");
    expect(await readFile(path.join(h.dir, "a"), "utf8")).toBe("new conflict");
    expect((await readdir(h.dir)).some((n) => n.endsWith(".part"))).toBe(false);
  });
  it("deletes a selected folder recursively only after confirmation, stopping at a failure", async () => {
    const h = await setup();
    h.files.set(`${ROOT}/a`, null);
    h.files.set(`${ROOT}/a/child`, Buffer.from("x"));
    h.files.set(`${ROOT}/b`, Buffer.from("b"));
    const plan = await h.prepare({
      action: "delete",
      paths: [`${ROOT}/a`, `${ROOT}/a/child`, `${ROOT}/b`],
    });
    expect(plan.items).toHaveLength(2);
    expect(h.writes).toEqual([]);
    h.session.delete.mockRejectedValueOnce(new DeviceOperationError("permission", "Denied"));
    const result = await h.manager.execute(plan, "skip", 1);
    expect(result.items.map((i) => i.status)).toEqual(["failed", "pending"]);
    expect(h.files.has(`${ROOT}/a/child`)).toBe(true);
  });
});
