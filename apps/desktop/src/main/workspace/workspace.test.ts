import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("only gives the diagnostics worker inputs for a registered workspace", async () => {
    const { service, workspace } = await openService();
    expect(() => service.projectInput("unknown")).toThrow("Unknown workspace");
    expect(service.projectInput(workspace.id)).toEqual({ inputPath: root });
    await service.selectEntry(workspace.id, "src/main.bp");
    expect(service.projectInput(workspace.id)).toEqual({
      inputPath: root,
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
