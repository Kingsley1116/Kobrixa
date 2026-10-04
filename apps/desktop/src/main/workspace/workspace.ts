import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { app, dialog, shell } from "electron";
import {
  loadProject,
  parseManifest,
  resolveInside,
  type ProjectManifest,
  type SourceProject,
} from "@kobrixa/compiler";
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

import type {
  LocalHistoryEntry,
  WorkspaceFileSnapshot,
  WorkspaceRefreshResult,
  WorkspaceWriteResult,
} from "../../shared/workspace-files.js";
import { LocalHistory } from "./history.js";
import { FilePreferencesStore } from "./preferences.js";
import type { FilePreferences } from "../../shared/file-preferences.js";

export interface WorkspaceProjectInput {
  inputPath: string;
  selectedEntry?: string;
}

interface CachedFile {
  snapshot: WorkspaceFileSnapshot;
  stamp: string | null;
}

interface WorkspaceRecord {
  id: string;
  inputPath: string;
  root: string;
  selectedEntry?: string;
  observed: Map<string, CachedFile>;
  singleFile: boolean;
  refreshSignature?: string;
}

interface WorkspaceDependencies {
  userDataPath?: () => string;
  trashItem?: (target: string) => Promise<void>;
  /** Test seam for edits arriving during staging. */
  beforeCommit?: () => Promise<void>;
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
  readonly #history: LocalHistory;
  readonly #preferences: FilePreferencesStore;
  readonly #operations = new Map<string, Promise<unknown>>();
  readonly #beforeCommit: (() => Promise<void>) | undefined;
  private sessionWrites: Promise<void> = Promise.resolve();

  constructor(dependencies: WorkspaceDependencies = {}) {
    this.#userDataPath = dependencies.userDataPath ?? (() => app.getPath("userData"));
    this.#trashItem = dependencies.trashItem ?? ((target) => shell.trashItem(target));
    this.#preferences = new FilePreferencesStore(this.#userDataPath);
    this.#history = new LocalHistory(this.#userDataPath, async () => {
      const preferences = await this.#preferences.get();
      return {
        enabled: preferences.localHistoryEnabled,
        versions: preferences.localHistoryVersions,
        ageMs: preferences.localHistoryDays * 24 * 60 * 60 * 1000,
        snapshotBytes: preferences.localHistorySnapshotMiB * 1024 * 1024,
        workspaceBytes: preferences.localHistoryWorkspaceMiB * 1024 * 1024,
      };
    });
    this.#beforeCommit = dependencies.beforeCommit;
  }

  getPreferences(): Promise<FilePreferences> {
    return this.#preferences.get();
  }

  setPreferences(patch: Partial<FilePreferences>): Promise<FilePreferences> {
    return this.#preferences.set(patch);
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
        const workspace = await this.register(view.inputPath, view.selectedEntry, true);
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
    const snapshot = await this.readFile(id, file);
    if (snapshot.content === null) throw new Error("The project file no longer exists.");
    return snapshot.content;
  }

  readFile(id: string, file: string): Promise<WorkspaceFileSnapshot> {
    return this.serial(id, async (record) => this.observe(record, file));
  }

  refresh(id: string, known: Record<string, string | null>): Promise<WorkspaceRefreshResult> {
    return this.serial(id, async (record) => {
      const files: Record<string, WorkspaceFileSnapshot> = {};
      for (const [file, revision] of Object.entries(known)) {
        const snapshot = await this.observe(record, file);
        if (snapshot.revision !== revision) files[file] = snapshot;
      }
      const workspace = await this.summary(record);
      const signatureParts: string[] = [];
      for (const entry of workspace.entries) {
        signatureParts.push(`${entry.kind}:${entry.path}`);
        if (entry.kind !== "file") continue;
        try {
          const stat = await lstat(path.join(record.root, entry.path), { bigint: true });
          signatureParts.push(
            `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          signatureParts.push("missing");
        }
      }
      const signature = createHash("sha256").update(signatureParts.join("\n")).digest("hex");
      const changed = signature !== record.refreshSignature;
      record.refreshSignature = signature;
      return { workspace, files, changed };
    });
  }

  write(
    id: string,
    file: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<WorkspaceWriteResult> {
    return this.serial(id, (record) => this.writeContents(record, file, content, expectedRevision));
  }

  private async writeContents(
    record: WorkspaceRecord,
    file: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<WorkspaceWriteResult> {
    if (expectedRevision !== null && !/^[0-9a-f]{64}$/.test(expectedRevision ?? ""))
      throw new Error("A base revision is required to save a file.");
    const target = await this.fileTarget(record, file);
    let current = await this.observe(record, file, true);
    if (current.revision !== expectedRevision) return { status: "conflict", snapshot: current };
    if (current.content !== null)
      await this.#history.append(record.root, file, current.content, "save");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await this.#beforeCommit?.();
      // History and staging both yield to external processes. Validate again at commit.
      await this.fileTarget(record, file);
      current = await this.observe(record, file, true);
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: current };
      if (expectedRevision === null) {
        // A file created after the missing-file check must never be replaced.
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return { status: "conflict", snapshot: await this.observe(record, file, true) };
        }
      } else await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    const snapshot = this.snapshot(content);
    // Do not bind a post-save stat to these bytes: another editor may already have replaced them.
    record.observed.set(file, { snapshot, stamp: null });
    let warning: string | undefined;
    try {
      await this.writeDraft(record, file, undefined);
      await this.#history.append(record.root, file, content, "save");
    } catch {
      warning =
        "File saved, but local history or draft cleanup could not finish. / 檔案已儲存，但本機歷史或草稿清理未能完成。";
    }
    return { status: "saved", snapshot, ...(warning ? { warning } : {}) };
  }

  history(id: string, file: string): Promise<LocalHistoryEntry[]> {
    return this.serial(id, async (record) => {
      await this.fileTarget(record, file);
      return this.#history.list(record.root, file);
    });
  }

  historyContent(id: string, file: string, entryId: string): Promise<string> {
    return this.serial(id, async (record) => {
      await this.fileTarget(record, file);
      return this.#history.content(record.root, file, entryId);
    });
  }

  async saveDraft(
    id: string,
    file: string,
    content: string | undefined,
    baseRevision?: string | null,
  ): Promise<void> {
    return this.serial(id, async (record) => {
      await this.fileTarget(record, file);
      await this.writeDraft(record, file, content, baseRevision);
    });
  }

  private serial<T>(id: string, action: (record: WorkspaceRecord) => Promise<T>): Promise<T> {
    const record = this.require(id);
    const key = record.root;
    const previous = this.#operations.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => {
        this.require(id);
        return action(record);
      });
    this.#operations.set(key, operation);
    void operation
      .finally(() => {
        if (this.#operations.get(key) === operation) this.#operations.delete(key);
      })
      .catch(() => undefined);
    return operation;
  }

  private async fileTarget(record: WorkspaceRecord, file: string): Promise<string> {
    this.validateRelativePath(file, false);
    if ((await realpath(record.root)) !== record.root)
      throw new Error("The registered project root changed.");
    if (!editableFile.test(file))
      throw new Error("Only project source and JSON files can be edited.");
    await this.assertNoSymlinkPath(record.root, file);
    return resolveInside(record.root, file);
  }

  private snapshot(content: string | null): WorkspaceFileSnapshot {
    return {
      content,
      revision: content === null ? null : createHash("sha256").update(content).digest("hex"),
    };
  }

  private async observe(
    record: WorkspaceRecord,
    file: string,
    force = false,
  ): Promise<WorkspaceFileSnapshot> {
    const target = await this.fileTarget(record, file);
    const previous = record.observed.get(file);
    let snapshot: WorkspaceFileSnapshot;
    let stamp: string | null = null;
    let stable = false;
    snapshot = this.snapshot(null);
    for (let attempt = 0; attempt < 3 && !stable; attempt += 1) {
      try {
        const stat = await lstat(target, { bigint: true });
        if (!stat.isFile()) throw new Error("The project path is not a regular file.");
        const before = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (!force && previous?.stamp === before) return previous.snapshot;
        snapshot = this.snapshot(await readFile(target, "utf8"));
        const after = await lstat(target, { bigint: true });
        const afterStamp = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`;
        if (before === afterStamp) {
          stamp = before;
          stable = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        snapshot = this.snapshot(null);
        stable = true;
      }
    }
    if (!stable)
      throw new Error(
        "The file is changing externally. Try again after the other editor finishes saving.",
      );
    if (previous && previous.snapshot.revision !== snapshot.revision) {
      if (previous.snapshot.content !== null)
        await this.#history.append(
          record.root,
          file,
          previous.snapshot.content,
          snapshot.content === null ? "delete" : "external",
        );
      if (snapshot.content !== null)
        await this.#history.append(record.root, file, snapshot.content, "external");
    }
    record.observed.set(file, { snapshot, stamp });
    return snapshot;
  }

  createEntry(
    id: string,
    parent: string,
    kind: WorkspaceEntry["kind"],
    name: string,
  ): Promise<WorkspaceMutationResult> {
    return this.serial(id, () => this.createEntryUnlocked(id, parent, kind, name));
  }

  private async createEntryUnlocked(
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

  moveEntry(id: string, source: string, target: string): Promise<WorkspaceMutationResult> {
    return this.serial(id, () => this.moveEntryUnlocked(id, source, target));
  }

  private async moveEntryUnlocked(
    id: string,
    source: string,
    target: string,
  ): Promise<WorkspaceMutationResult> {
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

    const entry = before.manifest?.entry;
    const nextEntry =
      entry && containsPath(source, entry) ? remapPath(entry, source, normalizedTarget) : undefined;
    if (nextEntry && !/\.(bp|bpi|bpm)$/i.test(nextEntry)) {
      throw new Error("The build entry must remain a BASIC PLUS file.");
    }
    const { drafts, revisions } = await this.loadDraftData(record.root);
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
    let writtenManifestRevision: string | null | undefined;
    let plannedManifest: { content: string; revision: string | null } | undefined;
    if (nextEntry && !before.implicit) {
      const snapshot = await this.observe(record, "kobrixa.json", true);
      if (snapshot.content === null)
        throw new Error("The project manifest was removed externally.");
      originalManifest = snapshot.content;
      const manifest = JSON.parse(snapshot.content) as Record<string, unknown>;
      if (manifest.entry !== entry)
        throw new Error("The project entry changed externally. Refresh before renaming.");
      manifest.entry = nextEntry;
      plannedManifest = {
        content: `${JSON.stringify(manifest, null, 2)}\n`,
        revision: snapshot.revision,
      };
    }
    // Retain originals until both source and metadata changes have completed.
    for (const [oldFile, newFile] of Object.entries(moved)) {
      if (editableFile.test(oldFile)) await this.#history.copy(record.root, oldFile, newFile);
    }

    await this.renameCaseAware(sourceTarget, destinationTarget, caseOnlyRename);
    try {
      if (plannedManifest) {
        const saved = await this.writeContents(
          record,
          "kobrixa.json",
          plannedManifest.content,
          plannedManifest.revision,
        );
        if (saved.status === "conflict")
          throw new Error("The project manifest changed externally. Refresh before renaming.");
        writtenManifestRevision = saved.snapshot.revision;
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
        await this.writeDraft(
          record,
          remapPath(draftFile, source, normalizedTarget),
          content,
          revisions[draftFile],
        );
        await this.writeDraft(record, draftFile, undefined);
      }
      const workspace = await this.summary(record);
      for (const [oldFile, newFile] of Object.entries(moved)) {
        if (!editableFile.test(oldFile)) continue;
        // The destination already has copies; cleanup cannot invalidate a completed rename.
        await this.#history.remove(record.root, oldFile).catch(() => undefined);
        const observed = record.observed.get(oldFile);
        if (observed) record.observed.set(newFile, { ...observed, stamp: null });
        record.observed.delete(oldFile);
      }
      return { workspace, moved, removed: [] };
    } catch (error) {
      record.inputPath = originalInputPath;
      if (originalSelectedEntry === undefined) delete record.selectedEntry;
      else record.selectedEntry = originalSelectedEntry;
      await this.renameCaseAware(destinationTarget, sourceTarget, caseOnlyRename).catch(
        () => undefined,
      );
      if (originalManifest !== undefined && writtenManifestRevision !== undefined) {
        await this.writeContents(
          record,
          "kobrixa.json",
          originalManifest,
          writtenManifestRevision,
        ).catch(() => undefined);
      }
      // Copy recovery data back before clearing destination drafts; failed recovery leaves copies.
      for (const [draftFile, content] of Object.entries(drafts)) {
        if (!containsPath(source, draftFile)) continue;
        await this.writeDraft(record, draftFile, content, revisions[draftFile]).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  trashEntry(id: string, entryPath: string): Promise<WorkspaceMutationResult> {
    return this.serial(id, () => this.trashEntryUnlocked(id, entryPath));
  }

  private async trashEntryUnlocked(
    id: string,
    entryPath: string,
  ): Promise<WorkspaceMutationResult> {
    const record = this.require(id);
    const before = await this.summary(record);
    const entry = this.requireVisibleEntry(before, entryPath);
    this.assertMutableSource(entryPath);
    const buildEntry = before.manifest?.entry;
    if (buildEntry && containsPath(entryPath, buildEntry)) {
      throw new Error("The current build entry cannot be deleted.");
    }
    if (entry.kind === "directory") await this.assertDirectoryManageable(record, entryPath);
    await this.assertNoSymlinkPath(record.root, entryPath);
    const target = await resolveInside(record.root, entryPath);
    const removed = before.entries
      .filter((item) => containsPath(entryPath, item.path))
      .map((item) => item.path);
    for (const entry of before.entries) {
      if (entry.kind !== "file" || !containsPath(entryPath, entry.path)) continue;
      const snapshot = await this.observe(record, entry.path, true);
      if (snapshot.content !== null)
        await this.#history.append(record.root, entry.path, snapshot.content, "delete");
    }
    await this.#trashItem(target);
    for (const file of removed) record.observed.delete(file);
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
    baseRevision?: string | null,
  ): Promise<void> {
    const directory = this.draftDirectory(record.root);
    const target = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.json`);
    if (content === undefined) await rm(target, { force: true });
    else {
      await mkdir(directory, { recursive: true });
      await this.atomicWrite(
        target,
        JSON.stringify({ file, content, ...(baseRevision !== undefined ? { baseRevision } : {}) }),
      );
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

  private async register(
    inputPath: string,
    selectedEntry?: string,
    restoring = false,
  ): Promise<WorkspaceSummary> {
    let missingStandalone = false;
    try {
      inputPath = await realpath(inputPath);
    } catch (error) {
      if (
        !restoring ||
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        !/\.bp$/i.test(inputPath)
      )
        throw error;
      const parent = await realpath(path.dirname(inputPath));
      if (!(await lstat(parent)).isDirectory()) throw error;
      inputPath = path.join(parent, path.basename(inputPath));
      missingStandalone = true;
    }
    const loaded = await loadProject(inputPath);
    const statRoot =
      loaded.project?.root ??
      (missingStandalone
        ? path.dirname(inputPath)
        : (await lstat(inputPath)).isDirectory()
          ? inputPath
          : path.dirname(inputPath));
    const root = await realpath(statRoot);
    const existing = [...this.#records.values()].find((record) => record.root === root);
    if (existing) return this.summary(existing);
    const record: WorkspaceRecord = {
      id: randomUUID(),
      inputPath,
      root,
      observed: new Map(),
      singleFile:
        missingStandalone || ((await lstat(inputPath)).isFile() && /\.bp$/i.test(inputPath)),
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
    let manifest: ProjectManifest | undefined;
    let implicit = record.singleFile;
    if (!record.singleFile) {
      const snapshot = await this.observe(record, "kobrixa.json");
      implicit = snapshot.content === null;
      if (snapshot.content !== null) {
        try {
          manifest = parseManifest(JSON.parse(snapshot.content)).manifest;
        } catch {
          /* Keep the tree usable while an external editor saves an invalid manifest. */
        }
      }
    }
    const entries = await this.listEntries(record.root, manifest?.outputDir);
    const files = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const candidates = implicit ? files.filter((file) => /\.bp$/i.test(file)) : [];
    if (implicit) {
      const entry = record.singleFile
        ? projectPath(path.relative(record.root, record.inputPath))
        : (record.selectedEntry ?? (candidates.length === 1 ? candidates[0] : undefined));
      if (entry)
        manifest = {
          schemaVersion: 1,
          name: path.basename(entry, path.extname(entry)),
          language: "bp",
          entry,
          target: "ev3-native",
          assets: [],
          outputDir: "build",
        };
    }
    const { drafts, revisions } = await this.loadDraftData(record.root);
    return {
      id: record.id,
      name: manifest?.name ?? path.basename(record.root),
      rootLabel: path.basename(record.root),
      locationLabel: record.root,
      files,
      entries,
      ...(manifest ? { manifest } : {}),
      implicit,
      entryCandidates: implicit && !manifest ? candidates : [],
      drafts,
      draftRevisions: revisions,
    };
  }

  private async listEntries(root: string, outputDirectory = "build"): Promise<WorkspaceEntry[]> {
    const output = projectPath(path.normalize(outputDirectory)).replace(/^\.\//, "");
    const directoryPaths = new Set<string>();
    const files: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      let children;
      try {
        children = await readdir(path.join(root, relative), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (relative && !children.length) directoryPaths.add(relative);
      for (const entry of children) {
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (this.isIgnored(entryPath, output)) continue;
        if (entry.isDirectory()) await visit(entryPath);
        else if (entry.isFile() && editableFile.test(entry.name)) {
          files.push(entryPath);
          let parent = path.posix.dirname(entryPath);
          while (parent !== ".") {
            directoryPaths.add(parent);
            parent = path.posix.dirname(parent);
          }
        }
      }
    };
    await visit("");
    return [
      ...[...directoryPaths].map((entryPath) => ({ path: entryPath, kind: "directory" as const })),
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
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private draftDirectory(root: string): string {
    return path.join(
      this.#userDataPath(),
      "drafts",
      createHash("sha256").update(root).digest("hex"),
    );
  }

  private async loadDrafts(root: string): Promise<Record<string, string>> {
    return (await this.loadDraftData(root)).drafts;
  }

  private async loadDraftData(
    root: string,
  ): Promise<{ drafts: Record<string, string>; revisions: Record<string, string | null> }> {
    const directory = this.draftDirectory(root);
    const drafts: Record<string, string> = {};
    const revisions: Record<string, string | null> = {};
    try {
      for (const file of await readdir(directory)) {
        if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
        try {
          const value: unknown = JSON.parse(await readFile(path.join(directory, file), "utf8"));
          if (
            !value ||
            typeof value !== "object" ||
            !("file" in value) ||
            !("content" in value) ||
            typeof value.file !== "string" ||
            typeof value.content !== "string"
          )
            continue;
          this.validateRelativePath(value.file, false);
          if (file !== `${createHash("sha256").update(value.file).digest("hex")}.json`) continue;
          drafts[value.file] = value.content;
          if (
            "baseRevision" in value &&
            (value.baseRevision === null ||
              (typeof value.baseRevision === "string" && /^[0-9a-f]{64}$/.test(value.baseRevision)))
          )
            revisions[value.file] = value.baseRevision;
        } catch {
          /* One corrupt recovery file must not hide other drafts. */
        }
      }
    } catch {
      /* A new workspace may not have any saved drafts. */
    }
    return { drafts, revisions };
  }

  private require(id: string): WorkspaceRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error("Unknown workspace.");
    return record;
  }
}
