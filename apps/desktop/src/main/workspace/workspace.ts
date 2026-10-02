import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, dialog, shell } from "electron";
import { loadProject, resolveInside, type SourceProject } from "@kobrixa/compiler";
import type {
  WorkspaceEntry,
  WorkspaceMutationResult,
  WorkspaceSummary,
  WorkspaceSessionState,
  RestoredWorkspaceSession,
} from "../../shared/api.js";
import {
  storedWorkspaceSessionSchema,
  workspaceSessionSchema,
  workspaceViewSchema,
} from "../../shared/workspace-session.js";

export interface WorkspaceProjectInput {
  inputPath: string;
  selectedEntry?: string;
}

interface WorkspaceRecord {
  id: string;
  inputPath: string;
  root: string;
  selectedEntry?: string;
}

interface WorkspaceDependencies {
  userDataPath?: () => string;
  trashItem?: (target: string) => Promise<void>;
}

const editableFile = /\.(bp|bpi|bpm|json)$/i;

function projectPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function containsPath(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remapPath(value: string, source: string, target: string): string {
  return value === source ? target : `${target}${value.slice(source.length)}`;
}

export class WorkspaceService {
  readonly #records = new Map<string, WorkspaceRecord>();
  readonly #userDataPath: () => string;
  readonly #trashItem: (target: string) => Promise<void>;
  private sessionWrites: Promise<void> = Promise.resolve();

  constructor(dependencies: WorkspaceDependencies = {}) {
    this.#userDataPath = dependencies.userDataPath ?? (() => app.getPath("userData"));
    this.#trashItem = dependencies.trashItem ?? ((target) => shell.trashItem(target));
  }

  async restoreSession(): Promise<RestoredWorkspaceSession> {
    await this.sessionWrites;
    const result: RestoredWorkspaceSession = { projects: [], workspaces: [], issues: [] };
    let stored;
    try {
      stored = storedWorkspaceSessionSchema.parse(
        JSON.parse(
          await readFile(path.join(this.#userDataPath(), "workspace-session.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        result.issues.push("Unable to restore the previous session. / 無法恢復上次的工作狀態。");
      return result;
    }
    for (const view of stored.projects) {
      try {
        const workspace = await this.register(view.inputPath, view.selectedEntry);
        if (result.workspaces.some((item) => item.id === workspace.id)) continue;
        result.workspaces.push(workspace);
        result.projects.push(workspaceViewSchema.parse({ ...view, workspaceId: workspace.id }));
        if (view.workspaceId === stored.activeWorkspaceId) result.activeWorkspaceId = workspace.id;
      } catch {
        result.issues.push(`Unable to reopen / 無法重新開啟：${view.inputPath}`);
      }
    }
    result.activeWorkspaceId ??= result.workspaces[0]?.id;
    return result;
  }

  saveSession(value: WorkspaceSessionState): Promise<void> {
    const state = workspaceSessionSchema.parse(value);
    const projects = state.projects.map((view) => {
      const record = this.require(view.workspaceId);
      return {
        ...view,
        inputPath: record.inputPath,
        ...(record.selectedEntry ? { selectedEntry: record.selectedEntry } : {}),
      };
    });
    if (new Set(projects.map((item) => item.workspaceId)).size !== projects.length)
      return Promise.reject(new Error("Duplicate workspace in session."));
    if (
      state.activeWorkspaceId &&
      !projects.some((item) => item.workspaceId === state.activeWorkspaceId)
    )
      return Promise.reject(new Error("Active workspace is not open."));
    const content = JSON.stringify({ version: 1, ...state, projects });
    const write = this.sessionWrites
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.#userDataPath(), { recursive: true });
        await this.atomicWrite(path.join(this.#userDataPath(), "workspace-session.json"), content);
      });
    this.sessionWrites = write.catch(() => undefined);
    return write;
  }

  close(id: string): void {
    this.require(id);
    this.#records.delete(id);
  }

  async open(): Promise<WorkspaceSummary | undefined> {
    const result = await dialog.showOpenDialog({
      title: "Open Kobrixa project",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Kobrixa", extensions: ["json", "bp"] }],
    });
    const inputPath = result.filePaths[0];
    return inputPath ? this.register(inputPath) : undefined;
  }

  async create(name: string): Promise<WorkspaceSummary | undefined> {
    const safe = name
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!safe) throw new Error("Project name must contain letters or numbers.");
    const result = await dialog.showOpenDialog({
      title: "Choose project location",
      properties: ["openDirectory", "createDirectory"],
    });
    const parent = result.filePaths[0];
    if (!parent) return undefined;
    const root = path.join(parent, safe);
    const sourceDir = path.join(root, "src");
    await mkdir(sourceDir, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      name: safe,
      language: "bp",
      entry: "src/main.bp",
      target: "ev3-native",
      assets: ["assets/**/*"],
      outputDir: "build",
    };
    await writeFile(path.join(root, "kobrixa.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    await writeFile(
      path.join(sourceDir, "main.bp"),
      'LCD.Clear()\nLCD.Text(1, 8, 18, 1, "Hello from Kobrixa")\nLCD.Update()\n',
      { flag: "wx" },
    );
    return this.register(root);
  }

  async selectEntry(id: string, entry: string): Promise<WorkspaceSummary> {
    const record = this.require(id);
    record.selectedEntry = entry;
    return this.summary(record);
  }

  async read(id: string, file: string): Promise<string> {
    const record = this.require(id);
    return readFile(await resolveInside(record.root, file), "utf8");
  }

  async write(id: string, file: string, content: string): Promise<void> {
    const record = this.require(id);
    const target = await resolveInside(record.root, file);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
    await this.saveDraft(id, file, undefined);
  }

  async saveDraft(id: string, file: string, content: string | undefined): Promise<void> {
    const record = this.require(id);
    await resolveInside(record.root, file);
    await this.writeDraft(record, file, content);
  }

  async createEntry(
    id: string,
    parent: string,
    kind: WorkspaceEntry["kind"],
    name: string,
  ): Promise<WorkspaceMutationResult> {
    const record = this.require(id);
    const before = await this.summary(record);
    const parentPath = this.validateDirectory(before, parent);
    const entryName = this.validateName(name, kind);
    const targetPath = projectPath(path.posix.join(parentPath, entryName));
    this.assertVisibleTarget(targetPath, before.manifest?.outputDir ?? "build");
    const target = await resolveInside(record.root, targetPath);
    await this.assertNoSymlinkPath(record.root, parentPath);
    await this.assertAvailable(target);
    if (kind === "directory") await mkdir(target);
    else await writeFile(target, "", { flag: "wx" });
    return { workspace: await this.summary(record), moved: {}, removed: [] };
  }

  async moveEntry(id: string, source: string, target: string): Promise<WorkspaceMutationResult> {
    const record = this.require(id);
    const before = await this.summary(record);
    const sourceEntry = this.requireVisibleEntry(before, source);
    this.assertMutableSource(source);
    const normalizedTarget = this.validateTargetPath(target, sourceEntry.kind);
    this.assertVisibleTarget(normalizedTarget, before.manifest?.outputDir ?? "build");
    if (source === normalizedTarget) return { workspace: before, moved: {}, removed: [] };
    const targetParent = path.posix.dirname(normalizedTarget);
    this.validateDirectory(before, targetParent === "." ? "" : targetParent);
    if (sourceEntry.kind === "directory" && containsPath(source, normalizedTarget)) {
      throw new Error("A folder cannot be moved into itself.");
    }
    if (sourceEntry.kind === "directory") await this.assertDirectoryManageable(record, source);
    await this.assertNoSymlinkPath(record.root, source);
    await this.assertNoSymlinkPath(record.root, targetParent === "." ? "" : targetParent);
    const sourceTarget = await resolveInside(record.root, source);
    const caseOnlyRename =
      source !== normalizedTarget &&
      source.toLocaleLowerCase("en-US") === normalizedTarget.toLocaleLowerCase("en-US");
    const destinationTarget = caseOnlyRename
      ? path.join(
          await resolveInside(record.root, targetParent === "." ? "" : targetParent),
          path.posix.basename(normalizedTarget),
        )
      : await resolveInside(record.root, normalizedTarget);
    if (!caseOnlyRename) await this.assertAvailable(destinationTarget);

    const loaded = await loadProject(record.inputPath, new Map(), record.selectedEntry);
    const entry = loaded.project?.manifest.entry;
    const nextEntry =
      entry && containsPath(source, entry) ? remapPath(entry, source, normalizedTarget) : undefined;
    if (nextEntry && !/\.(bp|bpi|bpm)$/i.test(nextEntry)) {
      throw new Error("The build entry must remain a BASIC PLUS file.");
    }
    const drafts = await this.loadDrafts(record.root);
    if (nextEntry && drafts["kobrixa.json"] !== undefined) {
      throw new Error("Save or discard kobrixa.json changes before moving the entry file.");
    }
    const moved = Object.fromEntries(
      before.entries
        .filter((item) => containsPath(source, item.path))
        .map((item) => [item.path, remapPath(item.path, source, normalizedTarget)]),
    );
    const originalInputPath = record.inputPath;
    const originalSelectedEntry = record.selectedEntry;
    let originalManifest: string | undefined;
    const manifestTarget = path.join(record.root, "kobrixa.json");

    await this.renameCaseAware(sourceTarget, destinationTarget, caseOnlyRename);
    try {
      if (nextEntry && !loaded.implicit) {
        originalManifest = await readFile(manifestTarget, "utf8");
        const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
        manifest.entry = nextEntry;
        await this.atomicWrite(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const relativeInput = projectPath(path.relative(record.root, record.inputPath));
      if (containsPath(source, relativeInput)) {
        record.inputPath = path.join(
          record.root,
          remapPath(relativeInput, source, normalizedTarget),
        );
      }
      if (record.selectedEntry && containsPath(source, record.selectedEntry)) {
        record.selectedEntry = remapPath(record.selectedEntry, source, normalizedTarget);
      }
      for (const [draftFile, content] of Object.entries(drafts)) {
        if (!containsPath(source, draftFile)) continue;
        await this.writeDraft(record, draftFile, undefined);
        await this.writeDraft(record, remapPath(draftFile, source, normalizedTarget), content);
      }
      return { workspace: await this.summary(record), moved, removed: [] };
    } catch (error) {
      record.inputPath = originalInputPath;
      if (originalSelectedEntry === undefined) delete record.selectedEntry;
      else record.selectedEntry = originalSelectedEntry;
      await this.renameCaseAware(destinationTarget, sourceTarget, caseOnlyRename).catch(
        () => undefined,
      );
      if (originalManifest !== undefined) {
        await this.atomicWrite(manifestTarget, originalManifest).catch(() => undefined);
      }
      throw error;
    }
  }

  async trashEntry(id: string, entryPath: string): Promise<WorkspaceMutationResult> {
    const record = this.require(id);
    const before = await this.summary(record);
    const entry = this.requireVisibleEntry(before, entryPath);
    this.assertMutableSource(entryPath);
    const loaded = await loadProject(record.inputPath, new Map(), record.selectedEntry);
    const buildEntry = loaded.project?.manifest.entry;
    if (buildEntry && containsPath(entryPath, buildEntry)) {
      throw new Error("The current build entry cannot be deleted.");
    }
    if (entry.kind === "directory") await this.assertDirectoryManageable(record, entryPath);
    await this.assertNoSymlinkPath(record.root, entryPath);
    const target = await resolveInside(record.root, entryPath);
    const removed = before.entries
      .filter((item) => containsPath(entryPath, item.path))
      .map((item) => item.path);
    await this.#trashItem(target);
    const drafts = await this.loadDrafts(record.root);
    for (const file of Object.keys(drafts)) {
      if (containsPath(entryPath, file)) await this.writeDraft(record, file, undefined);
    }
    return { workspace: await this.summary(record), moved: {}, removed };
  }

  private async writeDraft(
    record: WorkspaceRecord,
    file: string,
    content: string | undefined,
  ): Promise<void> {
    const directory = this.draftDirectory(record.root);
    const target = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.json`);
    if (content === undefined) await rm(target, { force: true });
    else {
      await mkdir(directory, { recursive: true });
      await writeFile(target, JSON.stringify({ file, content }), "utf8");
    }
  }

  projectInput(id: string): WorkspaceProjectInput {
    const { inputPath, selectedEntry } = this.require(id);
    return { inputPath, ...(selectedEntry ? { selectedEntry } : {}) };
  }

  async project(id: string, overlays: ReadonlyMap<string, string>): Promise<SourceProject> {
    const record = this.require(id);
    const result = await loadProject(record.inputPath, overlays, record.selectedEntry);
    if (!result.project)
      throw new Error(
        result.diagnostics.map((item) => item.message).join("\n") ||
          "Choose an entry file before building.",
      );
    return result.project;
  }

  private async register(inputPath: string, selectedEntry?: string): Promise<WorkspaceSummary> {
    inputPath = await realpath(inputPath);
    const loaded = await loadProject(inputPath);
    const statRoot =
      loaded.project?.root ??
      ((await lstat(inputPath)).isDirectory() ? inputPath : path.dirname(inputPath));
    const root = await realpath(statRoot);
    const existing = [...this.#records.values()].find((record) => record.root === root);
    if (existing) return this.summary(existing);
    const record: WorkspaceRecord = {
      id: randomUUID(),
      inputPath,
      root,
      ...(selectedEntry ? { selectedEntry } : {}),
    };
    this.#records.set(record.id, record);
    try {
      return await this.summary(record);
    } catch (error) {
      this.#records.delete(record.id);
      throw error;
    }
  }

  private async summary(record: WorkspaceRecord): Promise<WorkspaceSummary> {
    const loaded = await loadProject(record.inputPath, new Map(), record.selectedEntry);
    const entries = await this.listEntries(record.root, loaded.project?.manifest.outputDir);
    const files = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const drafts = await this.loadDrafts(record.root);
    const manifest = loaded.project?.manifest;
    return {
      id: record.id,
      name: manifest?.name ?? path.basename(record.root),
      rootLabel: path.basename(record.root),
      locationLabel: record.root,
      files,
      entries,
      ...(manifest ? { manifest } : {}),
      implicit: loaded.implicit,
      entryCandidates: loaded.candidates ?? [],
      drafts,
    };
  }

  private async listEntries(root: string, outputDirectory = "build"): Promise<WorkspaceEntry[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const output = projectPath(path.normalize(outputDirectory)).replace(/^\.\//, "");
    const directoryPaths = new Set<string>();
    const files: string[] = [];
    const hasChildren = new Set<string>();
    const actualDirectories: string[] = [];
    for (const entry of entries) {
      const parent = projectPath(path.relative(root, entry.parentPath));
      const entryPath = projectPath(path.relative(root, path.join(entry.parentPath, entry.name)));
      hasChildren.add(parent);
      if (this.isIgnored(entryPath, output)) continue;
      if (entry.isDirectory()) actualDirectories.push(entryPath);
      else if (entry.isFile() && editableFile.test(entry.name)) files.push(entryPath);
    }
    for (const file of files) {
      let parent = path.posix.dirname(file);
      while (parent !== ".") {
        directoryPaths.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    for (const directory of actualDirectories) {
      if (!hasChildren.has(directory)) directoryPaths.add(directory);
    }
    return [
      ...[...directoryPaths].map((entryPath) => ({
        path: entryPath,
        kind: "directory" as const,
      })),
      ...files.map((entryPath) => ({ path: entryPath, kind: "file" as const })),
    ].sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "base" }));
  }

  private isIgnored(entryPath: string, outputDirectory: string): boolean {
    const parts = entryPath.split("/");
    return (
      parts.some((part) => part.startsWith(".") || part === "assets" || part === "node_modules") ||
      containsPath(outputDirectory, entryPath)
    );
  }

  private validateDirectory(summary: WorkspaceSummary, value: string): string {
    const normalized = value === "." ? "" : this.validateRelativePath(value, true);
    if (
      normalized &&
      !summary.entries.some((entry) => entry.kind === "directory" && entry.path === normalized)
    ) {
      throw new Error("The destination folder is not available in the project tree.");
    }
    return normalized;
  }

  private validateName(value: string, kind: WorkspaceEntry["kind"]): string {
    const name = value.trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.startsWith(".") ||
      name === "node_modules" ||
      /[\\/:]/.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new Error("Enter a valid file or folder name.");
    }
    if (kind === "file" && !editableFile.test(name)) {
      throw new Error("Files must use .bp, .bpi, .bpm, or .json.");
    }
    return name;
  }

  private validateTargetPath(value: string, kind: WorkspaceEntry["kind"]): string {
    const normalized = this.validateRelativePath(value, false);
    this.validateName(path.posix.basename(normalized), kind);
    return normalized;
  }

  private assertVisibleTarget(entryPath: string, outputDirectory: string): void {
    const output = projectPath(path.normalize(outputDirectory)).replace(/^\.\//, "");
    if (this.isIgnored(entryPath, output)) {
      throw new Error("That location is hidden from the project tree.");
    }
  }

  private validateRelativePath(value: string, allowEmpty: boolean): string {
    if (value === "" && allowEmpty) return "";
    if (
      !value ||
      path.posix.isAbsolute(value) ||
      value.includes("\\") ||
      value.includes("\0") ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Path must be a normalized project-relative path.");
    }
    return value;
  }

  private requireVisibleEntry(summary: WorkspaceSummary, entryPath: string): WorkspaceEntry {
    const normalized = this.validateRelativePath(entryPath, false);
    const entry = summary.entries.find((item) => item.path === normalized);
    if (!entry) throw new Error("The project entry no longer exists.");
    return entry;
  }

  private assertMutableSource(entryPath: string): void {
    if (entryPath === "kobrixa.json") throw new Error("kobrixa.json is protected.");
  }

  private async assertAvailable(target: string): Promise<void> {
    try {
      await lstat(target);
      throw new Error("A file or folder with that name already exists.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
    let cursor = root;
    for (const segment of relativePath.split("/").filter(Boolean)) {
      cursor = path.join(cursor, segment);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) {
          throw new Error("Symbolic links cannot be managed from the project tree.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async assertDirectoryManageable(
    record: WorkspaceRecord,
    relativePath: string,
  ): Promise<void> {
    const target = await resolveInside(record.root, relativePath);
    const entries = await readdir(target, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        entry.name === "assets" ||
        entry.name === "node_modules" ||
        (entry.isFile() && !editableFile.test(entry.name))
      ) {
        throw new Error("This folder contains files that are hidden from the project tree.");
      }
    }
  }

  private async renameCaseAware(source: string, target: string, caseOnly: boolean): Promise<void> {
    if (!caseOnly) {
      await rename(source, target);
      return;
    }
    const temporary = `${source}.${randomUUID()}.rename`;
    await rename(source, temporary);
    try {
      await rename(temporary, target);
    } catch (error) {
      await rename(temporary, source).catch(() => undefined);
      throw error;
    }
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  }

  private draftDirectory(root: string): string {
    return path.join(
      this.#userDataPath(),
      "drafts",
      createHash("sha256").update(root).digest("hex"),
    );
  }

  private async loadDrafts(root: string): Promise<Record<string, string>> {
    const directory = this.draftDirectory(root);
    try {
      const files = await readdir(directory);
      const drafts: Record<string, string> = {};
      for (const file of files) {
        const value: unknown = JSON.parse(await readFile(path.join(directory, file), "utf8"));
        if (
          value &&
          typeof value === "object" &&
          "file" in value &&
          "content" in value &&
          typeof value.file === "string" &&
          typeof value.content === "string"
        ) {
          drafts[value.file] = value.content;
        }
      }
      return drafts;
    } catch {
      return {};
    }
  }

  private require(id: string): WorkspaceRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error("Unknown workspace.");
    return record;
  }
}
