import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showOpenDialog = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog },
  shell: { trashItem: vi.fn() },
}));

import { WorkspaceService } from "./workspace.js";
import type { WorkspaceView } from "../../shared/api.js";

describe.sequential("workspace file management", () => {
  let root: string;
  let userData: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kobrixa-workspace-"));
    userData = await mkdtemp(path.join(tmpdir(), "kobrixa-user-data-"));
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "build"));
    await writeFile(
      path.join(root, "kobrixa.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        name: "robot",
        language: "bp",
        entry: "src/main.bp",
        target: "ev3-native",
        assets: ["assets/**/*"],
        outputDir: "build",
      })}\n`,
    );
    await writeFile(path.join(root, "src", "main.bp"), "LCD.Clear()\n");
    await writeFile(path.join(root, "assets", "brick.png"), "image");
    await writeFile(path.join(root, "build", "generated.json"), "{}");
    showOpenDialog.mockReset();
    showOpenDialog.mockResolvedValue({ filePaths: [root] });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  });

  async function openService() {
    const service = new WorkspaceService({
      userDataPath: () => userData,
      trashItem: (target) => rm(target, { recursive: true, force: true }),
    });
    const workspace = await service.open();
    if (!workspace) throw new Error("Expected workspace");
    return { service, workspace };
  }

  it("lists editable files, their ancestors, and empty folders", async () => {
    const { workspace } = await openService();
    expect(workspace.files).toEqual(["kobrixa.json", "src/main.bp"]);
    expect(workspace.entries).toEqual([
      { path: "kobrixa.json", kind: "file" },
      { path: "src", kind: "directory" },
      { path: "src/lib", kind: "directory" },
      { path: "src/main.bp", kind: "file" },
    ]);
  });

  const view = (workspaceId: string): WorkspaceView => ({
    workspaceId,
    files: ["src/main.bp", "kobrixa.json"],
    activeFile: "src/main.bp",
    selectedTreePath: "src/main.bp",
    expandedTreePaths: ["", "src"],
    locations: {
      "src/main.bp": { line: 2, column: 3, endLine: 2, endColumn: 5, scrollTop: 80, scrollLeft: 0 },
    },
  });

  it("deduplicates directory, manifest and symlink openings by their real root", async () => {
    const { service, workspace } = await openService();
    showOpenDialog.mockResolvedValueOnce({ filePaths: [path.join(root, "kobrixa.json")] });
    expect((await service.open())?.id).toBe(workspace.id);
    const alias = path.join(userData, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    showOpenDialog.mockResolvedValueOnce({ filePaths: [alias] });
    expect((await service.open())?.id).toBe(workspace.id);
  });

  it("restores project order, entry selection, editor locations and existing drafts with new registered ids", async () => {
    const { service, workspace } = await openService();
    await service.selectEntry(workspace.id, "src/main.bp");
    await service.saveDraft(workspace.id, "src/main.bp", "unsaved\n");
    await service.saveSession({ projects: [view(workspace.id)], activeWorkspaceId: workspace.id });
    const restoredService = new WorkspaceService({ userDataPath: () => userData });
    const restored = await restoredService.restoreSession();
    const id = restored.workspaces[0]!.id;
    expect(id).not.toBe(workspace.id);
    expect(restored.issues).toEqual([]);
    expect(restored.activeWorkspaceId).toBe(id);
    expect(restored.projects[0]).toMatchObject({ ...view(id) });
    expect(restored.workspaces[0]!.drafts).toEqual({ "src/main.bp": "unsaved\n" });
    expect(restoredService.projectInput(id).selectedEntry).toBe("src/main.bp");
    restoredService.close(id);
    expect(() => restoredService.projectInput(id)).toThrow("Unknown workspace");
    expect((await service.restoreSession()).workspaces[0]!.drafts).toHaveProperty("src/main.bp");
  });

  it("skips unavailable projects and reports damaged session metadata without deleting drafts", async () => {
    const { service, workspace } = await openService();
    await service.saveDraft(workspace.id, "src/main.bp", "recovery");
    await service.saveSession({ projects: [view(workspace.id)] });
    const sessionPath = path.join(userData, "workspace-session.json");
    const stored = JSON.parse(await readFile(sessionPath, "utf8"));
    stored.projects.unshift({
      ...stored.projects[0],
      inputPath: path.join(root, "missing"),
      workspaceId: "00000000-0000-4000-8000-000000000009",
    });
    await writeFile(sessionPath, JSON.stringify(stored));
    const restored = await service.restoreSession();
    expect(restored.workspaces).toHaveLength(1);
    expect(restored.issues).toHaveLength(1);
    await writeFile(sessionPath, "invalid json");
    expect(await service.restoreSession()).toMatchObject({
      projects: [],
      workspaces: [],
      issues: [expect.any(String)],
    });
    expect((await service.open())!.drafts["src/main.bp"]).toBe("recovery");
  });

  it("serializes metadata writes and rejects unknown ids and relative path escapes", async () => {
    const { service, workspace } = await openService();
    await Promise.all([
      service.saveSession({ projects: [view(workspace.id)] }),
      service.saveSession({ projects: [] }),
    ]);
    expect((await service.restoreSession()).projects).toEqual([]);
    expect(() =>
      service.saveSession({ projects: [view("00000000-0000-4000-8000-000000000009")] }),
    ).toThrow("Unknown workspace");
    expect(() =>
      service.saveSession({ projects: [{ ...view(workspace.id), files: ["../outside.bp"] }] }),
    ).toThrow();
  });

  it("retries session writes after a storage failure without losing registered projects", async () => {
    const { service, workspace } = await openService();
    await rm(userData, { recursive: true, force: true });
    await writeFile(userData, "not a directory");
    await expect(service.saveSession({ projects: [view(workspace.id)] })).rejects.toThrow();
    expect(service.projectInput(workspace.id).inputPath).toBe(await realpath(root));
    await rm(userData);
    await mkdir(userData);
    await service.saveSession({ projects: [view(workspace.id)] });
    expect((await service.restoreSession()).projects).toHaveLength(1);
  });

  it("only gives the diagnostics worker inputs for a registered workspace", async () => {
    const { service, workspace } = await openService();
    expect(() => service.projectInput("unknown")).toThrow("Unknown workspace");
    expect(service.projectInput(workspace.id)).toEqual({ inputPath: await realpath(root) });
    await service.selectEntry(workspace.id, "src/main.bp");
    expect(service.projectInput(workspace.id)).toEqual({
      inputPath: await realpath(root),
      selectedEntry: "src/main.bp",
    });
  });

  it("creates entries and rejects invalid names and collisions", async () => {
    const { service, workspace } = await openService();
    const created = await service.createEntry(workspace.id, "src", "file", "helper.bp");
    expect(created.workspace.files).toContain("src/helper.bp");
    await service.createEntry(workspace.id, "", "directory", "tests");
    await expect(service.createEntry(workspace.id, "src", "file", "helper.bp")).rejects.toThrow(
      "already exists",
    );
    await expect(service.createEntry(workspace.id, "src", "file", "photo.png")).rejects.toThrow(
      ".bp",
    );
    await expect(service.createEntry(workspace.id, "", "directory", "assets")).rejects.toThrow(
      "hidden",
    );
  });

  it("supports case-only renames without replacing another file", async () => {
    const { service, workspace } = await openService();
    await service.createEntry(workspace.id, "src", "file", "helper.bp");
    const result = await service.moveEntry(workspace.id, "src/helper.bp", "src/Helper.bp");
    expect(result.workspace.files).toContain("src/Helper.bp");
    expect(await readFile(path.join(root, "src", "Helper.bp"), "utf8")).toBe("");
  });

  it("moves the build entry, updates the manifest, and migrates its draft", async () => {
    const { service, workspace } = await openService();
    await service.saveDraft(workspace.id, "src/main.bp", "LCD.Update()\n");
    const result = await service.moveEntry(workspace.id, "src", "source");
    expect(result.moved["src/main.bp"]).toBe("source/main.bp");
    expect(result.workspace.drafts).toEqual({ "source/main.bp": "LCD.Update()\n" });
    expect(result.workspace.manifest?.entry).toBe("source/main.bp");
    expect(JSON.parse(await readFile(path.join(root, "kobrixa.json"), "utf8"))).toMatchObject({
      entry: "source/main.bp",
    });
  });

  it("blocks an entry move while the manifest has a draft", async () => {
    const { service, workspace } = await openService();
    await service.saveDraft(workspace.id, "kobrixa.json", "{}\n");
    await expect(service.moveEntry(workspace.id, "src/main.bp", "main.bp")).rejects.toThrow(
      "kobrixa.json",
    );
  });

  it("protects the entry and refuses folders with hidden contents", async () => {
    const { service, workspace } = await openService();
    await writeFile(path.join(root, "src", "notes.txt"), "hidden");
    await expect(service.moveEntry(workspace.id, "src", "source")).rejects.toThrow("hidden");
    await expect(service.trashEntry(workspace.id, "src/main.bp")).rejects.toThrow("build entry");
    await expect(service.trashEntry(workspace.id, "kobrixa.json")).rejects.toThrow("protected");
    await expect(service.moveEntry(workspace.id, "src/main.bp", "src/main.json")).rejects.toThrow(
      "BASIC PLUS",
    );
  });

  it("moves a non-entry file to Trash and clears its draft", async () => {
    const { service, workspace } = await openService();
    await service.createEntry(workspace.id, "src", "file", "helper.bp");
    await service.saveDraft(workspace.id, "src/helper.bp", "draft\n");
    const result = await service.trashEntry(workspace.id, "src/helper.bp");
    expect(result.removed).toContain("src/helper.bp");
    expect(result.workspace.files).not.toContain("src/helper.bp");
    expect(result.workspace.drafts).not.toHaveProperty("src/helper.bp");
  });
});
