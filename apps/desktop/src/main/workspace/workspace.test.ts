import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

  it("searches registered workspaces without writing history or replacing dirty overlays", async () => {
    const { service, workspace } = await openService();
    await service.readFile(workspace.id, "src/main.bp");
    const previousHistory = await service.history(workspace.id, "src/main.bp");
    await writeFile(path.join(root, "src/main.bp"), "external motor");
    await writeFile(path.join(root, "src/lib/closed.bpi"), "closed motor");
    const request = {
      query: "motor",
      caseSensitive: false,
      wholeWord: true,
      overlays: { "src/main.bp": "unsaved motor motor" },
    };
    const result = await service.search(workspace.id, request);
    expect(result).toMatchObject({ matchCount: 3, truncated: false, skipped: [] });
    expect(result.files.map((file) => file.path)).toEqual(["src/lib/closed.bpi", "src/main.bp"]);
    expect(await service.history(workspace.id, "src/main.bp")).toEqual(previousHistory);
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("external motor");
    await expect(service.search("unknown", request)).rejects.toThrow("Unknown workspace");
    service.close(workspace.id);
    await expect(service.search(workspace.id, request)).rejects.toThrow("Unknown workspace");
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

  it("rejects stale saves and records both observed versions of an external edit", async () => {
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    await writeFile(path.join(root, "src/main.bp"), "external edit\n");
    const result = await service.write(workspace.id, "src/main.bp", "my edit\n", original.revision);
    expect(result.status).toBe("conflict");
    expect(result.snapshot.content).toBe("external edit\n");
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("external edit\n");
    const entries = await service.history(workspace.id, "src/main.bp");
    expect(
      await Promise.all(
        entries.map((entry) => service.historyContent(workspace.id, "src/main.bp", entry.id)),
      ),
    ).toEqual(["external edit\n", "LCD.Clear()\n"]);
    expect(
      await service.write(workspace.id, "src/main.bp", "my edit\n", result.snapshot.revision),
    ).toMatchObject({ status: "saved", snapshot: { content: "my edit\n" } });
  });

  it("serializes simultaneous saves so only one matching base revision wins", async () => {
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    const results = await Promise.all([
      service.write(workspace.id, "src/main.bp", "first", original.revision),
      service.write(workspace.id, "src/main.bp", "second", original.revision),
    ]);
    expect(results.map((result) => result.status)).toEqual(["saved", "conflict"]);
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("first");
    expect((await readdir(path.join(root, "src"))).some((file) => file.endsWith(".tmp"))).toBe(
      false,
    );
    // @ts-expect-error A renderer must never bypass the expected revision.
    await expect(service.write(workspace.id, "src/main.bp", "unconditional")).rejects.toThrow(
      "base revision",
    );
  });

  it("rechecks the disk after staging and does not archive an uncommitted proposal", async () => {
    const service = new WorkspaceService({
      userDataPath: () => userData,
      beforeCommit: async () => {
        await writeFile(path.join(root, "src/main.bp"), "late edit");
      },
    });
    const workspace = (await service.open())!;
    const original = await service.readFile(workspace.id, "src/main.bp");
    expect(
      await service.write(workspace.id, "src/main.bp", "proposal", original.revision),
    ).toMatchObject({ status: "conflict", snapshot: { content: "late edit" } });
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("late edit");
    const entries = await service.history(workspace.id, "src/main.bp");
    const contents = await Promise.all(
      entries.map((entry) => service.historyContent(workspace.id, "src/main.bp", entry.id)),
    );
    expect(contents).not.toContain("proposal");
    expect(contents).toContain("LCD.Clear()\n");
    expect((await readdir(path.join(root, "src"))).some((file) => file.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("distinguishes deletion from empty contents and only recreates a reviewed missing file", async () => {
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    await rm(path.join(root, "src/main.bp"));
    const refresh = await service.refresh(workspace.id, { "src/main.bp": original.revision });
    expect(refresh.files["src/main.bp"]).toEqual({ content: null, revision: null });
    expect(refresh.workspace.files).not.toContain("src/main.bp");
    expect(refresh.workspace.manifest?.entry).toBe("src/main.bp");
    expect(await service.write(workspace.id, "src/main.bp", "", original.revision)).toMatchObject({
      status: "conflict",
    });
    const result = await service.write(workspace.id, "src/main.bp", "", null);
    expect(result.status).toBe("saved");
    expect(result.snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.snapshot.content).toBe("");
    expect(await service.readFile(workspace.id, "src/missing.bp")).toEqual({
      content: null,
      revision: null,
    });
  });

  it("refreshes unopened dependencies and the tree without hiding a deleted standalone entry", async () => {
    const { service, workspace } = await openService();
    const first = await service.refresh(workspace.id, {});
    expect(first.changed).toBe(true);
    expect((await service.refresh(workspace.id, {})).changed).toBe(false);
    await writeFile(path.join(root, "src/lib/helper.bp"), "one");
    const added = await service.refresh(workspace.id, {});
    expect(added.changed).toBe(true);
    expect(added.workspace.files).toContain("src/lib/helper.bp");
    expect(added.files).toEqual({});
    await writeFile(path.join(root, "src/lib/helper.bp"), "two");
    expect((await service.refresh(workspace.id, {})).changed).toBe(true);
    expect((await service.refresh(workspace.id, {})).changed).toBe(false);
    const standalone = path.join(userData, "alone.bp");
    await writeFile(standalone, "LCD.Clear()");
    showOpenDialog.mockResolvedValueOnce({ filePaths: [standalone] });
    const single = (await service.open())!;
    const snapshot = await service.readFile(single.id, "alone.bp");
    await rm(standalone);
    const deleted = await service.refresh(single.id, { "alone.bp": snapshot.revision });
    expect(deleted.workspace.implicit).toBe(true);
    expect(deleted.workspace.manifest?.entry).toBe("alone.bp");
    expect(deleted.files["alone.bp"]?.content).toBeNull();
  });

  it("detects successive same-sized external edits and does not repeat unchanged bodies", async () => {
    const { service, workspace } = await openService();
    let snapshot = await service.readFile(workspace.id, "src/main.bp");
    for (const content of ["aaa", "bbb", "ccc"]) {
      await writeFile(path.join(root, "src/main.bp"), content);
      const refresh = await service.refresh(workspace.id, { "src/main.bp": snapshot.revision });
      snapshot = refresh.files["src/main.bp"]!;
      expect(snapshot.content).toBe(content);
      expect(
        (await service.refresh(workspace.id, { "src/main.bp": snapshot.revision })).files,
      ).toEqual({});
    }
    expect((await service.history(workspace.id, "src/main.bp")).length).toBe(4);
  });

  it("persists draft base revisions and saved history across process restarts", async () => {
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    const saved = await service.write(workspace.id, "src/main.bp", "saved", original.revision);
    await service.saveDraft(workspace.id, "src/main.bp", "unsaved", saved.snapshot.revision);
    const restarted = await openService();
    expect(restarted.workspace.drafts["src/main.bp"]).toBe("unsaved");
    expect(restarted.workspace.draftRevisions?.["src/main.bp"]).toBe(saved.snapshot.revision);
    const entries = await restarted.service.history(restarted.workspace.id, "src/main.bp");
    expect(
      await restarted.service.historyContent(restarted.workspace.id, "src/main.bp", entries[1]!.id),
    ).toBe(original.content);
    await restarted.service.saveDraft(restarted.workspace.id, "src/missing.bp", "new", null);
    expect(
      (await restarted.service.refresh(restarted.workspace.id, {})).workspace.draftRevisions?.[
        "src/missing.bp"
      ],
    ).toBeNull();
  });

  it("keeps history through renames and snapshots files before moving them to Trash", async () => {
    const { service, workspace } = await openService();
    await service.createEntry(workspace.id, "src", "file", "helper.bp");
    const original = await service.readFile(workspace.id, "src/helper.bp");
    await service.write(workspace.id, "src/helper.bp", "keep me", original.revision);
    await service.saveDraft(workspace.id, "src/helper.bp", "draft", original.revision);
    const renamed = await service.moveEntry(workspace.id, "src/helper.bp", "src/lib/renamed.bp");
    expect(renamed.workspace.draftRevisions?.["src/lib/renamed.bp"]).toBe(original.revision);
    const history = await service.history(workspace.id, "src/lib/renamed.bp");
    expect(history).toHaveLength(2);
    await service.trashEntry(workspace.id, "src/lib");
    const retained = await service.history(workspace.id, "src/lib/renamed.bp");
    expect(await service.historyContent(workspace.id, "src/lib/renamed.bp", retained[0]!.id)).toBe(
      "keep me",
    );
  });

  it("leaves source unchanged when mandatory pre-save history cannot be written", async () => {
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    await rm(userData, { recursive: true });
    await writeFile(userData, "unavailable");
    await expect(
      service.write(workspace.id, "src/main.bp", "new", original.revision),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe(original.content);
  });

  it("confines snapshots, drafts and history access to normalized non-symlink project files", async () => {
    const { service, workspace } = await openService();
    const outside = path.join(userData, "outside.bp");
    await writeFile(outside, "private");
    await symlink(outside, path.join(root, "src/linked.bp"));
    for (const file of [
      "../outside.bp",
      "src/../main.bp",
      "src/linked.bp",
      "/outside.bp",
      "assets/image.png",
    ]) {
      await expect(service.readFile(workspace.id, file)).rejects.toThrow();
      await expect(service.write(workspace.id, file, "overwrite", null)).rejects.toThrow();
      await expect(service.history(workspace.id, file)).rejects.toThrow();
    }
    expect(await readFile(outside, "utf8")).toBe("private");
  });

  it("restores a missing standalone source and its draft after restarting", async () => {
    const source = path.join(root, "src/main.bp");
    showOpenDialog.mockResolvedValueOnce({ filePaths: [source] });
    const { service, workspace } = await openService();
    const snapshot = await service.readFile(workspace.id, "main.bp");
    await service.saveDraft(workspace.id, "main.bp", "recover this", snapshot.revision);
    await service.saveSession({
      projects: [{ ...view(workspace.id), files: ["main.bp"], activeFile: "main.bp" }],
    });
    await rm(source);
    const restarted = new WorkspaceService({ userDataPath: () => userData });
    const restored = await restarted.restoreSession();
    expect(restored.issues).toEqual([]);
    const recovered = restored.workspaces[0]!;
    expect(recovered.drafts["main.bp"]).toBe("recover this");
    expect(recovered.draftRevisions?.["main.bp"]).toBe(snapshot.revision);
    expect(recovered.manifest?.entry).toBe("main.bp");
    expect(await restarted.readFile(recovered.id, "main.bp")).toEqual({
      content: null,
      revision: null,
    });
    expect((await restarted.write(recovered.id, "main.bp", "recover this", null)).status).toBe(
      "saved",
    );
  });

  it("reports a committed save accurately when auxiliary storage fails afterwards", async () => {
    const service = new WorkspaceService({
      userDataPath: () => userData,
      beforeCommit: async () => {
        await rm(userData, { recursive: true });
        await writeFile(userData, "storage unavailable");
      },
    });
    const workspace = (await service.open())!;
    const original = await service.readFile(workspace.id, "src/main.bp");
    const result = await service.write(workspace.id, "src/main.bp", "committed", original.revision);
    expect(result).toMatchObject({
      status: "saved",
      warning: expect.any(String),
      snapshot: { content: "committed" },
    });
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("committed");
  });

  it("does not rename source paths when history migration fails", async () => {
    const { service, workspace } = await openService();
    await rm(userData, { recursive: true });
    await writeFile(userData, "storage unavailable");
    await expect(
      service.moveEntry(workspace.id, "src/main.bp", "src/renamed.bp"),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("LCD.Clear()\n");
    expect(JSON.parse(await readFile(path.join(root, "kobrixa.json"), "utf8")).entry).toBe(
      "src/main.bp",
    );
  });

  it("guards automatic manifest changes during an entry rename", async () => {
    const target = path.join(root, "kobrixa.json");
    const external = `${JSON.stringify({ ...JSON.parse(await readFile(target, "utf8")), name: "external change" })}\n`;
    const service = new WorkspaceService({
      userDataPath: () => userData,
      beforeCommit: async () => {
        await writeFile(target, external);
      },
    });
    const workspace = (await service.open())!;
    await expect(service.moveEntry(workspace.id, "src/main.bp", "src/renamed.bp")).rejects.toThrow(
      "changed externally",
    );
    expect(await readFile(target, "utf8")).toBe(external);
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("LCD.Clear()\n");
    expect((await readdir(path.join(root, "src"))).includes("renamed.bp")).toBe(false);
  });

  it("loads persisted disabled history before saves and retains conflict protection", async () => {
    await writeFile(
      path.join(userData, "file-settings.json"),
      JSON.stringify({ localHistoryEnabled: false, externalChangesEnabled: false }),
    );
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    const saved = await service.write(
      workspace.id,
      "src/main.bp",
      "saved without history",
      original.revision,
    );
    expect(saved.status).toBe("saved");
    expect(await service.history(workspace.id, "src/main.bp")).toEqual([]);
    await writeFile(path.join(root, "src/main.bp"), "external");
    expect(
      await service.write(workspace.id, "src/main.bp", "stale", saved.snapshot.revision),
    ).toMatchObject({ status: "conflict", snapshot: { content: "external" } });
    expect(await service.history(workspace.id, "src/main.bp")).toEqual([]);
    expect((await readdir(userData)).includes("local-history")).toBe(false);
  });

  it("changes history policy at runtime while preserving access to earlier versions", async () => {
    const { service, workspace } = await openService();
    const original = await service.readFile(workspace.id, "src/main.bp");
    const saved = await service.write(workspace.id, "src/main.bp", "recorded", original.revision);
    const recorded = await service.history(workspace.id, "src/main.bp");
    await service.setPreferences({ localHistoryEnabled: false, externalChangesEnabled: false });
    const unrecorded = await service.write(
      workspace.id,
      "src/main.bp",
      "unrecorded",
      saved.snapshot.revision,
    );
    expect(unrecorded.status).toBe("saved");
    expect(await service.history(workspace.id, "src/main.bp")).toEqual(recorded);
    expect(await service.historyContent(workspace.id, "src/main.bp", recorded[0]!.id)).toBe(
      "recorded",
    );
    await service.setPreferences({
      localHistoryEnabled: true,
      localHistoryVersions: 20,
      localHistorySnapshotMiB: 1,
    });
    await service.write(
      workspace.id,
      "src/main.bp",
      "recording again",
      unrecorded.snapshot.revision,
    );
    expect(await service.history(workspace.id, "src/main.bp")).toHaveLength(4);
    const restarted = await openService();
    expect(await restarted.service.getPreferences()).toMatchObject({
      localHistoryEnabled: true,
      externalChangesEnabled: false,
      localHistoryVersions: 20,
      localHistorySnapshotMiB: 1,
    });
  });

  it("uses configured snapshot size for new versions without deleting earlier large snapshots", async () => {
    const { service, workspace } = await openService();
    await service.setPreferences({ localHistorySnapshotMiB: 5 });
    const original = await service.readFile(workspace.id, "src/main.bp");
    const large = "x".repeat(2 * 1024 * 1024 + 1);
    const saved = await service.write(workspace.id, "src/main.bp", large, original.revision);
    const entries = await service.history(workspace.id, "src/main.bp");
    expect(entries[0]!.size).toBe(large.length);
    await service.setPreferences({ localHistorySnapshotMiB: 1 });
    const newLarge = `${large}changed`;
    expect(
      (await service.write(workspace.id, "src/main.bp", newLarge, saved.snapshot.revision)).status,
    ).toBe("saved");
    expect(await service.history(workspace.id, "src/main.bp")).toEqual(entries);
    expect(await service.historyContent(workspace.id, "src/main.bp", entries[0]!.id)).toBe(large);
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe(newLarge);
  });
});
