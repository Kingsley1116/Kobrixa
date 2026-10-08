import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { COLLAB_LIMITS, collabPathSchema } from "@kobrixa/collab-protocol";
import type {
  CollabJoinChange,
  CollabJoinResolution,
  CollabLocalErrorCode,
  CollabPrepareResult,
  CollabSharePreview,
} from "../../shared/collab.js";
import { dialog } from "electron";
import type { WorkspaceSummary } from "../../shared/api.js";
import { isIgnoredWorkspacePath } from "../workspace/search.js";
import type { WorkspaceService } from "../workspace/workspace.js";
import type { CollabService } from "./service.js";
import { CollabMirrors } from "./mirror.js";

/** Carries a {@link CollabLocalErrorCode} across IPC as the error message. */
export class CollabLocalError extends Error {
  constructor(readonly code: CollabLocalErrorCode) {
    super(code);
    this.name = "CollabLocalError";
  }
}

/** Files added, changed or removed in `current` relative to `baseline`, by path. */
export function compareFingerprints(
  current: Record<string, string>,
  baseline: Record<string, string>,
): CollabJoinChange[] {
  const changes: CollabJoinChange[] = [];
  for (const file of [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()) {
    if (!Object.hasOwn(baseline, file)) changes.push({ path: file, change: "added" });
    else if (!Object.hasOwn(current, file)) changes.push({ path: file, change: "removed" });
    else if (current[file] !== baseline[file]) changes.push({ path: file, change: "changed" });
  }
  return changes;
}

/** Protects local projects before a room's authoritative document can overwrite them. */
export class CollabProjects {
  private bindings = new Map<string, string>();
  /** Host project roots chosen in the folder picker but not yet confirmed by a join. */
  private located = new Map<string, string>();
  private mirrors: CollabMirrors;
  constructor(
    private service: CollabService,
    private workspaces: WorkspaceService,
    private directory: string,
  ) {
    this.mirrors = new CollabMirrors(workspaces, () => directory);
  }

  async preview(workspaceId: string): Promise<CollabSharePreview> {
    const summary = (await this.workspaces.refresh(workspaceId, {})).workspace;
    const result: CollabSharePreview = { shared: [], skipped: [] };
    let total = 0;
    const files: string[] = [];
    const root = await this.workspaces.projectRoot(workspaceId);
    const scan = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (isIgnoredWorkspacePath(file, summary.manifest?.outputDir ?? "build")) continue;
        if (entry.isDirectory()) await scan(file);
        else files.push(file);
      }
    };
    await scan("");
    for (const file of files.sort()) {
      let reason: CollabSharePreview["skipped"][number]["reason"] | undefined;
      if (
        !summary.files.includes(file) ||
        !/\.(bp|bpi|bpm|json)$/i.test(file) ||
        !collabPathSchema.safeParse(file).success
      )
        reason = "format";
      else if (result.shared.length >= COLLAB_LIMITS.files) reason = "count";
      else {
        const bytes = Buffer.byteLength(
          summary.drafts[file] ?? (await this.workspaces.read(workspaceId, file)),
        );
        if (bytes > COLLAB_LIMITS.fileBytes) reason = "size";
        else if (total + bytes > COLLAB_LIMITS.roomFileBytes) reason = "total";
        else total += bytes;
      }
      if (reason) result.skipped.push({ path: file, reason });
      else result.shared.push(file);
    }
    return result;
  }

  async bindCreated(roomId: string, workspaceId: string): Promise<void> {
    const identity = this.service.identities.get(this.service.serverUrl(), roomId);
    if (!identity) throw new CollabLocalError("identity-unsupported");
    const summary = (await this.workspaces.refresh(workspaceId, {})).workspace;
    await this.service.identities.set({
      ...identity,
      workspaceRoot: await this.workspaces.projectRoot(workspaceId),
      baseline: await this.fingerprint(summary),
    });
  }

  /**
   * Opens the room's project. Local changes since the last sync are reported as
   * a conflict until the caller chooses a `resolution`; "keep-copy" saves a
   * separate copy first and aborts if that fails.
   */
  async prepare(
    roomId: string,
    _selectedWorkspace?: string,
    resolution?: CollabJoinResolution,
  ): Promise<CollabPrepareResult> {
    const restored = await this.service.resumeRoom(roomId);
    if (!restored.ok) return { status: "error", error: restored.error };
    const identity = this.service.identities.get(this.service.serverUrl(), roomId);
    if (!identity) return { status: "error", error: "identity-missing" };
    const host = restored.value.role === "host";
    let summary: WorkspaceSummary;
    if (host) {
      // A folder located while asking about a conflict is reused only for the answer.
      if (!resolution) this.located.delete(roomId);
      const saved = (resolution && this.located.get(roomId)) || identity.workspaceRoot;
      if (!saved) return { status: "error", error: "project-location-missing" };
      try {
        summary = await this.workspaces.openDirectory(saved);
      } catch {
        const choice = await dialog.showOpenDialog({
          title: "Locate the original shared project / 選擇原本分享的專案",
          properties: ["openDirectory"],
        });
        if (choice.canceled || !choice.filePaths[0]) return { status: "cancelled" };
        summary = await this.workspaces.openDirectory(choice.filePaths[0]);
      }
    } else summary = await this.mirrors.open(roomId, restored.value.projectName);
    const root = await this.workspaces.projectRoot(summary.id);
    this.bindings.set(roomId, summary.id);
    const changes = compareFingerprints(await this.fingerprint(summary), identity.baseline ?? {});
    let backupPath: string | undefined;
    if (changes.length) {
      if (!resolution) {
        if (host) this.located.set(roomId, root);
        return { status: "conflict", changes };
      }
      if (resolution === "keep-copy") {
        try {
          backupPath = await this.saveCopy(roomId);
        } catch {
          return { status: "error", error: "backup-failed" };
        }
      }
    }
    this.located.delete(roomId);
    await this.service.identities.set({
      ...identity,
      workspaceRoot: root,
    });
    return { status: "ready", workspace: summary, ...(backupPath ? { backupPath } : {}) };
  }

  async checkpoint(roomId: string): Promise<void> {
    const id = this.bindings.get(roomId);
    const identity = this.service.identities.get(this.service.serverUrl(), roomId);
    if (!id || !identity) return;
    const summary = (await this.workspaces.refresh(id, {})).workspace;
    await this.service.identities.set({ ...identity, baseline: await this.fingerprint(summary) });
  }

  async saveCopy(roomId: string): Promise<string> {
    let id = this.bindings.get(roomId);
    if (!id) {
      const identity = this.service.identities.get(this.service.serverUrl(), roomId);
      if (!identity?.workspaceRoot) throw new CollabLocalError("project-unavailable");
      id = (await this.workspaces.openDirectory(identity.workspaceRoot)).id;
    }
    const root = await this.workspaces.projectRoot(id);
    const summary = (await this.workspaces.refresh(id, {})).workspace;
    const target = path.join(this.directory, "collab-backups", `${roomId}-${randomUUID()}`);
    if (!path.relative(root, target).startsWith("..")) throw new CollabLocalError("backup-failed");
    await mkdir(path.dirname(target), { recursive: true });
    await cp(root, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (source) => !(await lstat(source)).isSymbolicLink(),
    });
    for (const [file, content] of Object.entries(summary.drafts)) {
      const destination = path.resolve(target, file);
      const relative = path.relative(target, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new CollabLocalError("backup-failed");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    return target;
  }

  private async fingerprint(summary: WorkspaceSummary): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const file of [...new Set([...summary.files, ...Object.keys(summary.drafts)])].sort()) {
      const content = summary.drafts[file] ?? (await this.workspaces.read(summary.id, file));
      hashes[file] = createHash("sha256").update(content).digest("hex");
    }
    return hashes;
  }
}
