import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalHistoryEntry } from "../../shared/workspace-files.js";
import { DEFAULT_FILE_PREFERENCES } from "../../shared/file-preferences.js";

export const HISTORY_LIMITS = {
  versions: Number(DEFAULT_FILE_PREFERENCES.localHistoryVersions),
  ageMs: DEFAULT_FILE_PREFERENCES.localHistoryDays * 24 * 60 * 60 * 1000,
  snapshotBytes: DEFAULT_FILE_PREFERENCES.localHistorySnapshotMiB * 1024 * 1024,
  workspaceBytes: DEFAULT_FILE_PREFERENCES.localHistoryWorkspaceMiB * 1024 * 1024,
};

type Limits = typeof HISTORY_LIMITS;
export interface HistoryPolicy extends Limits {
  enabled: boolean;
}

type PolicySource = Limits | (() => Promise<HistoryPolicy>);
interface StoredEntry extends LocalHistoryEntry {
  filename: string;
  revision: string;
  directory: string;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const storedName = /^(\d+)_([0-9a-f-]{36})_(save|external|delete)_(\d+)_([0-9a-f]{64})\.txt$/;

/** Immutable snapshots: filenames hold metadata so pruning never reads source bodies. */
export class LocalHistory {
  private lastTimestamp = 0;
  constructor(
    private readonly userDataPath: () => string,
    private readonly policySource: PolicySource = HISTORY_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  private async policy(): Promise<HistoryPolicy> {
    return typeof this.policySource === "function"
      ? this.policySource()
      : { ...this.policySource, enabled: true };
  }

  private workspaceDirectory(root: string): string {
    return path.join(this.userDataPath(), "local-history", hash(root));
  }

  private directory(root: string, file: string): string {
    return path.join(this.workspaceDirectory(root), hash(file));
  }

  private async entries(directory: string): Promise<StoredEntry[]> {
    let names: string[];
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("Invalid history directory.");
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: StoredEntry[] = [];
    for (const filename of names) {
      const match = storedName.exec(filename);
      if (!match) continue;
      const [, time, id, reason, size, revision] = match;
      const stat = await lstat(path.join(directory, filename));
      if (!stat.isFile() || stat.size !== Number(size)) continue;
      entries.push({
        id: id!,
        timestamp: Number(time),
        reason: reason as LocalHistoryEntry["reason"],
        size: Number(size),
        revision: revision!,
        filename,
        directory,
      });
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  }

  async list(root: string, file: string): Promise<LocalHistoryEntry[]> {
    await this.prune(root, await this.policy());
    return (await this.entries(this.directory(root, file))).map(
      ({ id, timestamp, reason, size }) => ({
        id,
        timestamp,
        reason,
        size,
      }),
    );
  }

  async content(root: string, file: string, id: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid history entry.");
    const policy = await this.policy();
    await this.prune(root, policy);
    const entry = (await this.entries(this.directory(root, file))).find((value) => value.id === id);
    if (!entry || entry.timestamp < this.now() - policy.ageMs)
      throw new Error("History entry is no longer available.");
    const content = await readFile(path.join(entry.directory, entry.filename), "utf8");
    if (hash(content) !== entry.revision) throw new Error("History entry is damaged.");
    return content;
  }

  async append(
    root: string,
    file: string,
    content: string,
    reason: LocalHistoryEntry["reason"],
  ): Promise<void> {
    const policy = await this.policy();
    if (!policy.enabled) return;
    await this.prune(root, policy);
    const size = Buffer.byteLength(content, "utf8");
    if (size > policy.snapshotBytes) return;
    const directory = this.directory(root, file);
    const entries = await this.entries(directory);
    const revision = hash(content);
    const latest = entries[0];
    if (latest?.revision === revision && latest.timestamp >= this.now() - policy.ageMs) {
      const stored = await readFile(path.join(directory, latest.filename), "utf8");
      if (hash(stored) === revision) return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const timestamp = Math.max(
      this.now(),
      (entries[0]?.timestamp ?? 0) + 1,
      this.lastTimestamp + 1,
    );
    this.lastTimestamp = timestamp;
    const filename = `${timestamp}_${randomUUID()}_${reason}_${size}_${revision}.txt`;
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(directory, filename));
    } finally {
      await rm(temporary, { force: true });
    }
    await this.prune(root, policy);
  }

  /** Copy before changing source paths so a storage error cannot strand a rename. */
  async copy(root: string, source: string, target: string): Promise<void> {
    await this.prune(root, await this.policy());
    const entries = await this.entries(this.directory(root, source));
    if (!entries.length) return;
    const destination = this.directory(root, target);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const temporary = path.join(destination, `${randomUUID()}.tmp`);
      try {
        await copyFile(path.join(entry.directory, entry.filename), temporary);
        await rename(temporary, path.join(destination, entry.filename));
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  async remove(root: string, file: string): Promise<void> {
    await rm(this.directory(root, file), { recursive: true, force: true });
    await this.prune(root, await this.policy());
  }

  async move(root: string, source: string, target: string): Promise<void> {
    await this.copy(root, source, target);
    await this.remove(root, source);
  }

  private async prune(root: string, policy: HistoryPolicy): Promise<void> {
    const workspace = this.workspaceDirectory(root);
    let directories;
    try {
      directories = await readdir(workspace, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const keep: StoredEntry[] = [];
    const expired = this.now() - policy.ageMs;
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^[0-9a-f]{64}$/.test(directory.name)) continue;
      const entries = await this.entries(path.join(workspace, directory.name));
      let count = 0;
      for (const entry of entries) {
        if (entry.timestamp < expired || count++ >= policy.versions)
          await rm(path.join(entry.directory, entry.filename), { force: true });
        else keep.push(entry);
      }
    }
    keep.sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
    let bytes = 0;
    for (const entry of keep) {
      bytes += entry.size;
      if (bytes > policy.workspaceBytes)
        await rm(path.join(entry.directory, entry.filename), { force: true });
    }
  }
}
