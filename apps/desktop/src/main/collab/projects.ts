import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { COLLAB_LIMITS, collabPathSchema } from "@kobrixa/collab-protocol";
import type { CollabSharePreview } from "../../shared/collab.js";
import { dialog } from "electron";
import type { WorkspaceSummary } from "../../shared/api.js";
import { isIgnoredWorkspacePath } from "../workspace/search.js";
import type { WorkspaceService } from "../workspace/workspace.js";
import type { CollabService } from "./service.js";
import { CollabMirrors } from "./mirror.js";

/** Protects local projects before a room's authoritative document can overwrite them. */
export class CollabProjects {
  private bindings = new Map<string, string>();
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
    if (!identity) throw new Error("The server does not support saved room identities.");
    const summary = (await this.workspaces.refresh(workspaceId, {})).workspace;
    await this.service.identities.set({
      ...identity,
      workspaceRoot: await this.workspaces.projectRoot(workspaceId),
      baseline: await this.fingerprint(summary),
    });
  }

  async prepare(roomId: string, _selectedWorkspace?: string): Promise<WorkspaceSummary | null> {
    const restored = await this.service.resumeRoom(roomId);
    if (!restored.ok) throw new Error(restored.error);
    const identity = this.service.identities.get(this.service.serverUrl(), roomId);
    if (!identity) throw new Error("Saved room access is unavailable.");
    let summary: WorkspaceSummary;
    if (restored.value.role === "host") {
      if (identity.workspaceRoot) {
        try {
          summary = await this.workspaces.openDirectory(identity.workspaceRoot);
        } catch {
          const choice = await dialog.showOpenDialog({
            title: "Locate the original shared project / 選擇原本分享的專案",
            properties: ["openDirectory"],
          });
          if (choice.canceled || !choice.filePaths[0]) return null;
          summary = await this.workspaces.openDirectory(choice.filePaths[0]);
        }
      } else {
        throw new Error(
          "The original project location was not saved. Open your preserved project and create a new room. / 原專案位置未保存，請開啟保留的專案並建立新房間。",
        );
      }
    } else summary = await this.mirrors.open(roomId, restored.value.projectName);
    const root = await this.workspaces.projectRoot(summary.id);
    this.bindings.set(roomId, summary.id);
    const current = await this.fingerprint(summary);
    if (
      (Object.keys(current).length || Object.keys(identity.baseline ?? {}).length) &&
      JSON.stringify(current) !== JSON.stringify(identity.baseline ?? {})
    ) {
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: "Keep local changes / 保留本機修改",
        message:
          "Local files or drafts changed since the last room sync. / 本機檔案或草稿與上次同步不同。",
        detail:
          "A separate copy must be saved before joining. / 加入前會先保存獨立副本，成功後才同步房間內容。",
        buttons: ["Keep a copy and join / 保留副本後加入", "Cancel / 取消"],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer.response !== 0) return null;
      await this.saveCopy(roomId);
    }
    await this.service.identities.set({
      ...identity,
      workspaceRoot: root,
    });
    return summary;
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
      if (!identity?.workspaceRoot) throw new Error("Open the shared project first.");
      id = (await this.workspaces.openDirectory(identity.workspaceRoot)).id;
    }
    const root = await this.workspaces.projectRoot(id);
    const summary = (await this.workspaces.refresh(id, {})).workspace;
    const target = path.join(this.directory, "collab-backups", `${roomId}-${randomUUID()}`);
    if (!path.relative(root, target).startsWith(".."))
      throw new Error("The backup must be outside the project.");
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
        throw new Error("Invalid draft path.");
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
