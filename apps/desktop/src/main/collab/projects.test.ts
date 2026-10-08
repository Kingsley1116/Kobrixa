import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  shell: {},
}));
import { dialog } from "electron";
import { WorkspaceService } from "../workspace/workspace.js";
import { CollabProjects, compareFingerprints } from "./projects.js";
import { loadCollabIdentities } from "./identities.js";
import type { CollabService } from "./service.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "collab-protection-"));
  roots.push(root);
  const project = path.join(root, "project"),
    directory = path.join(root, "data");
  await mkdir(project);
  await mkdir(directory);
  await writeFile(path.join(project, "main.bp"), "PRINT original");
  const workspaces = new WorkspaceService();
  const summary = await workspaces.openDirectory(project);
  const identities = await loadCollabIdentities(directory);
  await identities.set({
    serverUrl: "https://collab.test",
    roomId: "saved-room-0000001",
    participantId: "host-0001",
    credential: "x".repeat(43),
    inviteCode: "ABCD-EFGH-JKLM",
  });
  const service = {
    identities,
    serverUrl: () => "https://collab.test",
    resumeRoom: async () => ({ ok: true, value: { role: "host", projectName: "Original" } }),
  } as unknown as CollabService;
  const projects = new CollabProjects(service, workspaces, directory);
  await projects.bindCreated("saved-room-0000001", summary.id);
  return { root, directory, project, projects, service, workspaces, summary, identities };
}
describe("room project protection", () => {
  it("persists restricted recovery credentials and restores the original project instead of the selected project", async () => {
    const env = await setup();
    // Windows uses the per-user profile ACL; POSIX exposes the owner-only mode bits.
    if (process.platform !== "win32")
      expect((await stat(path.join(env.directory, "collab-identities.json"))).mode & 0o777).toBe(
        0o600,
      );
    const restored = await loadCollabIdentities(env.directory);
    expect(restored.get("https://collab.test", "saved-room-0000001")?.credential).toBe(
      "x".repeat(43),
    );
    expect(restored.get("https://other.test", "saved-room-0000001")).toBeUndefined();
    const other = path.join(env.root, "other");
    await mkdir(other);
    const unrelated = await env.workspaces.openDirectory(other);
    const result = await env.projects.prepare("saved-room-0000001", unrelated.id);
    expect(result).toEqual({
      status: "ready",
      workspace: expect.objectContaining({ id: env.summary.id }),
    });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
  it("reports changed files without modifying them until a resolution is chosen", async () => {
    const env = await setup();
    await writeFile(path.join(env.project, "main.bp"), "PRINT offline");
    await writeFile(path.join(env.project, "extra.bp"), "PRINT new");
    expect(await env.projects.prepare("saved-room-0000001")).toEqual({
      status: "conflict",
      changes: [
        { path: "extra.bp", change: "added" },
        { path: "main.bp", change: "changed" },
      ],
    });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(await readFile(path.join(env.project, "main.bp"), "utf8")).toBe("PRINT offline");
    await expect(readdir(path.join(env.directory, "collab-backups"))).rejects.toThrow();
  });
  it("keeps a separate copy including unsaved drafts before joining", async () => {
    const env = await setup();
    const snapshot = await env.workspaces.readFile(env.summary.id, "main.bp");
    await env.workspaces.saveDraft(env.summary.id, "main.bp", "PRINT unsaved", snapshot.revision);
    const result = await env.projects.prepare("saved-room-0000001", undefined, "keep-copy");
    expect(result).toMatchObject({ status: "ready", workspace: { id: env.summary.id } });
    const copies = await readdir(path.join(env.directory, "collab-backups"));
    expect(copies).toHaveLength(1);
    const backup = path.join(env.directory, "collab-backups", copies[0]!);
    expect(result).toMatchObject({ backupPath: backup });
    expect(await readFile(path.join(backup, "main.bp"), "utf8")).toBe("PRINT unsaved");
  });
  it("replaces local changes without a copy when chosen", async () => {
    const env = await setup();
    await writeFile(path.join(env.project, "main.bp"), "PRINT offline");
    const result = await env.projects.prepare("saved-room-0000001", undefined, "replace");
    expect(result).toEqual({
      status: "ready",
      workspace: expect.objectContaining({ id: env.summary.id }),
    });
    await expect(readdir(path.join(env.directory, "collab-backups"))).rejects.toThrow();
  });
  it("lets the host locate a moved project once and reuses it for the answer", async () => {
    const env = await setup();
    const moved = path.join(env.root, "moved");
    await rename(env.project, moved);
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await env.projects.prepare("saved-room-0000001")).toEqual({ status: "cancelled" });
    await writeFile(path.join(moved, "main.bp"), "PRINT moved");
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [moved] });
    expect(await env.projects.prepare("saved-room-0000001")).toMatchObject({ status: "conflict" });
    expect(await env.projects.prepare("saved-room-0000001", undefined, "replace")).toMatchObject({
      status: "ready",
    });
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(2);
    expect(env.identities.get("https://collab.test", "saved-room-0000001")?.workspaceRoot).toBe(
      await realpath(moved),
    );
  });
  it("forgets a located folder when the conflict is not answered", async () => {
    const env = await setup();
    const moved = path.join(env.root, "moved");
    await rename(env.project, moved);
    await writeFile(path.join(moved, "main.bp"), "PRINT moved");
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [moved] });
    expect(await env.projects.prepare("saved-room-0000001")).toMatchObject({ status: "conflict" });
    // Cancelled: the original location is back, so a fresh attempt opens it, not the picked one.
    await rename(moved, env.project);
    const result = await env.projects.prepare("saved-room-0000001", undefined, undefined);
    expect(result).toMatchObject({ status: "conflict" });
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(await env.projects.prepare("saved-room-0000001", undefined, "replace")).toMatchObject({
      status: "ready",
    });
    expect(env.identities.get("https://collab.test", "saved-room-0000001")?.workspaceRoot).toBe(
      await realpath(env.project),
    );
  });
  it("lists added, changed and removed files by path", () => {
    expect(compareFingerprints({ a: "1", b: "2", d: "4" }, { b: "2", c: "3", d: "5" })).toEqual([
      { path: "a", change: "added" },
      { path: "c", change: "removed" },
      { path: "d", change: "changed" },
    ]);
  });
  it("keeps damaged identity files intact without preventing the app from starting", async () => {
    const env = await setup();
    const file = path.join(env.directory, "collab-identities.json");
    await writeFile(file, "damaged");
    const store = await loadCollabIdentities(env.directory);
    expect(() => store.get("https://collab.test", "saved-room-0000001")).toThrow(
      "not been replaced",
    );
    expect(await readFile(file, "utf8")).toBe("damaged");
  });
  it("never falls back to the selected project when the host binding is absent", async () => {
    const env = await setup();
    const identity = env.identities.get("https://collab.test", "saved-room-0000001")!;
    delete identity.workspaceRoot;
    await env.identities.set(identity);
    expect(await env.projects.prepare(identity.roomId, env.summary.id)).toEqual({
      status: "error",
      error: "project-location-missing",
    });
  });
  it("aborts joining if the preservation copy cannot be written", async () => {
    const env = await setup();
    await writeFile(path.join(env.project, "main.bp"), "PRINT keep me");
    await writeFile(path.join(env.directory, "collab-backups"), "blocked");
    expect(await env.projects.prepare("saved-room-0000001", undefined, "keep-copy")).toEqual({
      status: "error",
      error: "backup-failed",
    });
    expect(await readFile(path.join(env.project, "main.bp"), "utf8")).toBe("PRINT keep me");
  });
});
