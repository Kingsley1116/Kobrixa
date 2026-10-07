import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { CollabProjects } from "./projects.js";
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
    expect(result?.id).toBe(env.summary.id);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
  it("cancels before modifying files and keeps a separate copy including unsaved drafts before joining", async () => {
    const env = await setup();
    await writeFile(path.join(env.project, "main.bp"), "PRINT offline");
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(await env.projects.prepare("saved-room-0000001")).toBeNull();
    expect(await readFile(path.join(env.project, "main.bp"), "utf8")).toBe("PRINT offline");
    const snapshot = await env.workspaces.readFile(env.summary.id, "main.bp");
    await env.workspaces.saveDraft(env.summary.id, "main.bp", "PRINT unsaved", snapshot.revision);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    expect((await env.projects.prepare("saved-room-0000001"))?.id).toBe(env.summary.id);
    const copies = await readdir(path.join(env.directory, "collab-backups"));
    expect(copies).toHaveLength(1);
    expect(
      await readFile(path.join(env.directory, "collab-backups", copies[0]!, "main.bp"), "utf8"),
    ).toBe("PRINT unsaved");
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
    await expect(env.projects.prepare(identity.roomId, env.summary.id)).rejects.toThrow(
      "original project location",
    );
  });
  it("aborts joining if the preservation copy cannot be written", async () => {
    const env = await setup();
    await writeFile(path.join(env.project, "main.bp"), "PRINT keep me");
    await writeFile(path.join(env.directory, "collab-backups"), "blocked");
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    await expect(env.projects.prepare("saved-room-0000001")).rejects.toThrow();
    expect(await readFile(path.join(env.project, "main.bp"), "utf8")).toBe("PRINT keep me");
  });
});
