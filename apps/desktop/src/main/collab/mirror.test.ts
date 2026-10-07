import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { trashItem: vi.fn() },
}));

import { WorkspaceService } from "../workspace/workspace.js";
import { CollabMirrors, registerCollabMirrorIpc } from "./mirror.js";

const roomId = "room_0123456789abcdef";

describe("collaboration mirrors", () => {
  let userData: string;
  let workspaces: WorkspaceService;
  let mirrors: CollabMirrors;

  beforeEach(async () => {
    userData = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-mirror-")));
    workspaces = new WorkspaceService({ userDataPath: () => userData });
    mirrors = new CollabMirrors(workspaces, () => userData);
  });

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it("creates an empty mirror workspace without inventing a manifest", async () => {
    const summary = await mirrors.open(roomId, "Robot");
    const directory = path.join(userData, "collab", roomId);
    expect(summary.locationLabel).toBe(directory);
    expect(summary.files).toEqual([]);
    expect(summary.manifest).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);

    const write = await workspaces.write(summary.id, "main.bp", "LCD.Clear()\n", null);
    expect(write.status).toBe("saved");
    // Reopening reuses the registered workspace.
    const again = await mirrors.open(roomId, "Robot");
    expect(again.id).toBe(summary.id);
    expect(again.files).toEqual(["main.bp"]);
  });

  it("removes the mirror and closes its workspace", async () => {
    const summary = await mirrors.open(roomId, "Robot");
    await writeFile(path.join(userData, "collab", roomId, "main.bp"), "x");
    await mirrors.remove(roomId);
    await expect(stat(path.join(userData, "collab", roomId))).rejects.toThrow();
    expect(() => workspaces.readFile(summary.id, "main.bp")).toThrow("Unknown workspace");
    // Removing a missing mirror is a no-op.
    await expect(mirrors.remove(roomId)).resolves.toBeUndefined();
  });

  it("rejects room ids that could escape the mirror folder", async () => {
    for (const bad of ["../escape-0123456789", "a/b/c/d/e/f/g/h/i/j/k/l", "short", "", 42])
      await expect(mirrors.open(bad, "Robot")).rejects.toThrow();
    await expect(mirrors.remove("../../../../etc/passwd")).rejects.toThrow();
    await expect(mirrors.open(roomId, "x".repeat(500))).rejects.toThrow();
  });

  it("registers both IPC channels", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerCollabMirrorIpc(
      (channel, action) =>
        handlers.set(channel, action as (event: unknown, ...args: unknown[]) => unknown),
      workspaces,
      () => userData,
    );
    expect([...handlers.keys()].sort()).toEqual(["collab:open-mirror", "collab:remove-mirror"]);
    const summary = (await handlers.get("collab:open-mirror")!({}, roomId, "Robot")) as {
      id: string;
    };
    expect(summary.id).toMatch(/[0-9a-f-]{36}/);
    await handlers.get("collab:remove-mirror")!({}, roomId);
    await expect(stat(path.join(userData, "collab", roomId))).rejects.toThrow();
  });
});
