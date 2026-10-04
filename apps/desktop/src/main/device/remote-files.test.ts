import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "@kobrixa/device";
import { remoteFileOperation } from "./remote-files.js";
import type { RemoteFileRequest } from "../../shared/api.js";
const ROOT = "/home/root/lms2012/prjs";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kobrixa-transfer-"));
  directories.push(dir);
  const local = path.join(dir, "sample.rbf");
  await writeFile(local, "original");
  const session = {
    descriptor: { id: "mock", name: "EV3", transport: "mock" as const },
    connected: true,
    list: vi.fn(async () => [
      { name: "sample.rbf", path: `${ROOT}/sample.rbf`, kind: "file" as const, size: 3 },
    ]),
    uploadStream: vi.fn(async (_path: string, _size: number, chunks: AsyncIterable<Uint8Array>) => {
      for await (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
    }),
    download: vi.fn(async (_path: string, sink: (chunk: Uint8Array) => Promise<void>) => {
      await sink(Uint8Array.of(1, 2, 3));
    }),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
    disconnect: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    readMonitor: vi.fn(),
    readInputModes: vi.fn(),
    setInputMode: vi.fn(),
  } satisfies DeviceSession;
  const dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [local] })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: local })),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  };
  const changed = vi.fn();
  const request: RemoteFileRequest = {
    action: "list",
    path: ROOT,
    locale: "en",
    sessionId: "s",
    requestId: "r",
  };
  const perform = (patch: Partial<RemoteFileRequest>) =>
    remoteFileOperation(
      { ...request, ...patch },
      session,
      new AbortController().signal,
      dialog,
      changed,
      vi.fn(),
    );
  return { dir, local, session, dialog, changed, perform };
}
describe("native EV3 file operations", () => {
  it("requires overwrite confirmation and leaves the EV3 untouched when declined", async () => {
    const h = await setup();
    expect((await h.perform({ action: "upload" })).cancelled).toBe(true);
    expect(h.dialog.showMessageBox).toHaveBeenCalled();
    expect(h.session.uploadStream).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
    h.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await h.perform({ action: "upload" });
    expect(h.session.uploadStream).toHaveBeenCalledOnce();
    expect(h.changed).toHaveBeenCalledWith([`${ROOT}/sample.rbf`]);
  });
  it("delivers a completed download atomically", async () => {
    const h = await setup();
    await h.perform({ action: "download", path: `${ROOT}/sample.rbf` });
    expect([...(await readFile(h.local))]).toEqual([1, 2, 3]);
    expect(await readdir(h.dir)).toEqual(["sample.rbf"]);
  });
  it("cleans partial downloads without replacing an existing file", async () => {
    const h = await setup();
    h.session.download.mockImplementation(async (_path, sink) => {
      await sink(Uint8Array.of(1));
      throw new Error("connection lost");
    });
    await expect(h.perform({ action: "download", path: `${ROOT}/sample.rbf` })).rejects.toThrow(
      "connection lost",
    );
    expect(await readFile(h.local, "utf8")).toBe("original");
    expect(await readdir(h.dir)).toEqual(["sample.rbf"]);
  });
  it("rejects a changed length before delivering the destination", async () => {
    const h = await setup();
    h.session.download.mockImplementation(async (_path, sink) => {
      await sink(Uint8Array.of(1));
    });
    await expect(h.perform({ action: "download", path: `${ROOT}/sample.rbf` })).rejects.toThrow(
      "size changed",
    );
    expect(await readFile(h.local, "utf8")).toBe("original");
  });
  it("rejects a same-length download when its checksum differs", async () => {
    const h = await setup();
    h.session.list.mockImplementation(async () => [
      {
        name: "sample.rbf",
        path: `${ROOT}/sample.rbf`,
        kind: "file",
        size: 3,
        checksum: "0".repeat(32),
      },
    ]);
    await expect(h.perform({ action: "download", path: `${ROOT}/sample.rbf` })).rejects.toThrow(
      "verification failed",
    );
    expect(await readFile(h.local, "utf8")).toBe("original");
    expect(await readdir(h.dir)).toEqual(["sample.rbf"]);
  });
  it("confirms recursive deletion and forbids storage-root mutation before dialogs", async () => {
    const h = await setup();
    await h.perform({ action: "delete", path: `${ROOT}/folder` });
    expect(h.session.delete).not.toHaveBeenCalled();
    h.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await h.perform({ action: "delete", path: `${ROOT}/folder` });
    expect(h.session.delete).toHaveBeenCalledOnce();
    await expect(h.perform({ action: "delete", path: `${ROOT}/SD_Card` })).rejects.toThrow(
      "Storage roots",
    );
    await expect(h.perform({ action: "rename", path: ROOT, name: "bad" })).rejects.toThrow(
      "Storage roots",
    );
  });
  it("validates paths and child names in the main process", async () => {
    const h = await setup();
    await expect(h.perform({ path: "/etc" })).rejects.toThrow("projects area");
    await expect(h.perform({ action: "mkdir", name: "../escape" })).rejects.toThrow();
    await expect(h.perform({ action: "mkdir", name: "sample.rbf" })).rejects.toThrow(
      "already exists",
    );
    expect(h.session.createDirectory).not.toHaveBeenCalled();
    await h.perform({ action: "mkdir", name: "folder" });
    expect(h.session.createDirectory).toHaveBeenCalledWith(
      `${ROOT}/folder`,
      expect.any(AbortSignal),
    );
    await expect(h.perform({ path: `${ROOT}/missing` })).rejects.toThrow("no longer exists");
  });
});
