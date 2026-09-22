import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir, realpath, open, mkdir, rename, unlink, link } from "node:fs/promises";
import path from "node:path";
import {
  DeviceOperationError,
  managedPath,
  remoteChild,
  normalizeDeviceError,
  type DeviceSession,
  type RemoteEntry,
} from "@kobrixa/device";
import type { Dialog } from "electron";
import type {
  FileBatchRequest,
  FileBatchRef,
  FileBatchSnapshot,
  FileBatchItem,
} from "../shared/api.js";

type NativeDialog = Pick<Dialog, "showOpenDialog">;
type Run = <T>(
  id: string,
  work: (session: DeviceSession, signal: AbortSignal) => Promise<T>,
) => Promise<T>;
interface Entry {
  view: FileBatchItem;
  remote: string;
  local?: string;
  original?: RemoteEntry;
  localStamp?: string;
  targetStamp?: string;
}
interface Task {
  owner: number;
  request: FileBatchRequest;
  snapshot: FileBatchSnapshot;
  entries: Entry[];
  decide: (policy: "skip" | "replace" | undefined) => void;
  done: Promise<void>;
}
const localStamp = (s: Awaited<ReturnType<typeof lstat>>): string =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const exists = async (p: string) => {
  try {
    return await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};
function fail(message: string): never {
  throw new DeviceOperationError("transfer", message);
}
function uniqueRoots(paths: string[], separator: string): string[] {
  return [...new Set(paths)]
    .sort((a, b) => a.length - b.length)
    .filter(
      (p, i, all) => !all.slice(0, i).some((parent) => p.startsWith(`${parent}${separator}`)),
    );
}
/** Main-process plans own all local paths. A single device reservation spans preparation and confirmation. */
export class FileBatchManager {
  private tasks = new Map<string, Task>();
  constructor(
    private run: Run,
    private dialog: NativeDialog,
    private publish: (snapshot: FileBatchSnapshot) => void,
    private changed: (request: FileBatchRequest, paths: string[]) => void,
  ) {}

  async prepare(request: FileBatchRequest, owner: number): Promise<FileBatchSnapshot> {
    const snapshot: FileBatchSnapshot = {
      ...request,
      planId: randomUUID(),
      phase: "checking",
      items: [],
      issues: [],
      stopRequested: false,
    };
    let prepared!: (snapshot: FileBatchSnapshot) => void;
    const result = new Promise<FileBatchSnapshot>((resolve) => {
      prepared = resolve;
    });
    let decide!: Task["decide"];
    const decision = new Promise<"skip" | "replace" | undefined>((resolve) => {
      decide = resolve;
    });
    const task: Task = { owner, request, snapshot, entries: [], decide, done: Promise.resolve() };
    this.tasks.set(snapshot.planId, task);
    const emit = () => this.publish(structuredClone(snapshot));
    task.done = this.run(request.sessionId, async (session, signal) => {
      const aborted = () => {
        snapshot.stopRequested = true;
        decide(undefined);
      };
      signal.addEventListener("abort", aborted, { once: true });
      try {
        emit();
        const selected = await this.scan(task, session, signal);
        signal.throwIfAborted();
        if (!selected || snapshot.stopRequested) snapshot.phase = "cancelled";
        else snapshot.phase = snapshot.issues.length ? "failed" : "ready";
        emit();
        prepared(structuredClone(snapshot));
        if (snapshot.phase !== "ready") return;
        const policy = await decision;
        signal.throwIfAborted();
        if (!policy || snapshot.stopRequested) {
          snapshot.phase = "cancelled";
          emit();
          return;
        }
        snapshot.phase = "running";
        emit();
        for (const entry of task.entries) {
          if (snapshot.stopRequested) break;
          snapshot.currentId = entry.view.id;
          snapshot.progress = undefined;
          entry.view.status = "running";
          emit();
          try {
            signal.throwIfAborted();
            let lastProgress = 0;
            const progress = (transferred: number, total: number) => {
              snapshot.progress = { transferred, total };
              if (transferred === total || Date.now() - lastProgress >= 100) {
                lastProgress = Date.now();
                emit();
              }
            };
            entry.view.status = await this.process(task, entry, policy, session, signal, progress);
            emit();
          } catch (error) {
            entry.view.status = "failed";
            entry.view.message = normalizeDeviceError(error).message;
            snapshot.phase = "failed";
            emit();
            throw error;
          }
        }
        snapshot.phase = snapshot.stopRequested ? "stopped" : "complete";
        snapshot.progress = undefined;
        snapshot.currentId = undefined;
        emit();
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    })
      .catch((error) => {
        if (
          snapshot.phase === "checking" &&
          snapshot.stopRequested &&
          normalizeDeviceError(error).category === "cancelled"
        ) {
          snapshot.phase = "cancelled";
          emit();
          prepared(structuredClone(snapshot));
          return;
        }
        snapshot.phase = "failed";
        const message = normalizeDeviceError(error).message;
        if (!snapshot.items.some((item) => item.status === "failed")) snapshot.issues.push(message);
        emit();
        prepared(structuredClone(snapshot));
      })
      .finally(() => {
        this.tasks.delete(snapshot.planId);
      });
    return result;
  }
  private require(ref: FileBatchRef, owner: number): Task {
    const task = this.tasks.get(ref.planId);
    if (
      !task ||
      task.owner !== owner ||
      task.request.sessionId !== ref.sessionId ||
      task.request.requestId !== ref.requestId
    )
      throw new Error("Unknown or expired file operation.");
    return task;
  }
  async execute(
    ref: FileBatchRef,
    policy: "skip" | "replace",
    owner: number,
  ): Promise<FileBatchSnapshot> {
    const task = this.require(ref, owner);
    if (task.snapshot.phase !== "ready")
      throw new Error("File operation is not awaiting confirmation.");
    // Change phase before resolving the gate so a second execute cannot reuse it.
    task.snapshot.phase = "running";
    task.decide(policy);
    await task.done;
    return structuredClone(task.snapshot);
  }
  async stop(ref: FileBatchRef, owner: number): Promise<void> {
    const task = this.require(ref, owner);
    task.snapshot.stopRequested = true;
    task.decide(undefined);
    this.publish(structuredClone(task.snapshot));
    if (task.snapshot.phase !== "running") await task.done;
  }
  abandonOwner(owner: number): void {
    for (const task of this.tasks.values())
      if (task.owner === owner) {
        task.snapshot.stopRequested = true;
        task.decide(undefined);
      }
  }
  private async scan(task: Task, session: DeviceSession, signal: AbortSignal): Promise<boolean> {
    const { request: r, snapshot: s } = task;
    const base = managedPath(r.path);
    const zh = r.locale === "zh-TW";
    const targets = new Set<string>();
    const check = () => {
      signal.throwIfAborted();
      if (s.stopRequested) throw new DeviceOperationError("cancelled", "Preparation stopped.");
    };
    const add = (
      entry: Omit<Entry, "view">,
      label: string,
      kind: FileBatchItem["kind"],
      size?: number,
      conflict = false,
    ) => {
      const target = r.action === "download" ? entry.local! : entry.remote;
      // Case folding also catches ambiguous targets on default macOS/Windows filesystems.
      const key = r.action === "download" ? target.toLowerCase() : target;
      if (targets.has(key)) fail(`Duplicate destination: ${label}`);
      targets.add(key);
      const view: FileBatchItem = {
        id: randomUUID(),
        label,
        kind,
        conflict,
        status: "pending",
        ...(size === undefined ? {} : { size }),
      };
      task.entries.push({ ...entry, view });
      s.items.push(view);
    };
    const issue = async (label: string, work: () => Promise<void>) => {
      try {
        check();
        await work();
      } catch (e) {
        if (signal.aborted || s.stopRequested) throw e;
        const error = normalizeDeviceError(e);
        if (["connection", "timeout"].includes(error.category)) throw e;
        s.issues.push(`${label}: ${error.message}`);
      }
    };
    const listings = new Map<string, Promise<RemoteEntry[]>>();
    const listing = (directory: string): Promise<RemoteEntry[]> => {
      let pending = listings.get(directory);
      if (!pending) {
        pending = session.list(directory, signal);
        listings.set(directory, pending);
      }
      return pending;
    };
    const remoteAt = async (p: string): Promise<RemoteEntry | undefined> =>
      (await listing(path.posix.dirname(p))).find((e) => e.path === p);
    if (r.action === "upload") {
      const selection = await this.dialog.showOpenDialog({
        title: zh
          ? r.source === "files"
            ? "上傳檔案至 EV3"
            : "上傳資料夾至 EV3"
          : r.source === "files"
            ? "Upload files to EV3"
            : "Upload folders to EV3",
        properties: [r.source === "files" ? "openFile" : "openDirectory", "multiSelections"],
      });
      if (selection.canceled || !selection.filePaths.length) return false;
      const walk = async (local: string, remote: string, parentExists: boolean): Promise<void> => {
        check();
        const info = await lstat(local);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
          fail(`Unsupported item (links are not followed): ${local}`);
        const existing = parentExists ? await remoteAt(remote) : undefined;
        const kind = info.isDirectory() ? "directory" : "file";
        if (existing && existing.kind !== kind) fail(`File/folder type conflict: ${remote}`);
        add(
          {
            local,
            remote,
            localStamp: localStamp(info),
            ...(existing ? { original: existing } : {}),
          },
          path.posix.relative(base, remote),
          kind,
          info.isFile() ? info.size : undefined,
          existing?.kind === "file",
        );
        if (info.isDirectory())
          for (const name of (await readdir(local)).sort())
            await issue(path.join(local, name), () =>
              walk(path.join(local, name), remoteChild(remote, name), Boolean(existing)),
            );
      };
      const sources = await Promise.all(
        selection.filePaths.map(async (p) =>
          path.join(await realpath(path.dirname(p)), path.basename(p)),
        ),
      );
      for (const local of uniqueRoots(sources, path.sep))
        await issue(local, () => walk(local, remoteChild(base, path.basename(local)), true));
    } else {
      const roots = uniqueRoots(
        r.paths.map((p) => managedPath(p, true)),
        "/",
      );
      if (!roots.length) fail("Select at least one item.");
      if (roots.some((p) => path.posix.dirname(p) !== base))
        fail("Select items from the current folder.");
      let localBase = "";
      if (r.action === "download") {
        const selection = await this.dialog.showOpenDialog({
          title: zh ? "選擇下載目的資料夾" : "Choose download folder",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selection.canceled || !selection.filePaths[0]) return false;
        localBase = await realpath(selection.filePaths[0]);
      }
      const walk = async (remote: string, local: string, parentExists: boolean): Promise<void> => {
        check();
        managedPath(remote, true);
        const entry = await remoteAt(remote);
        if (!entry) fail(`Source no longer exists: ${remote}`);
        const info = parentExists ? await exists(local) : undefined;
        if (info?.isSymbolicLink() || (info && !info.isFile() && !info.isDirectory()))
          fail(`Unsupported destination: ${local}`);
        if (info && info.isDirectory() !== (entry.kind === "directory"))
          fail(`File/folder type conflict: ${local}`);
        add(
          { remote, local, original: entry, ...(info ? { targetStamp: localStamp(info) } : {}) },
          path.posix.relative(base, remote),
          entry.kind,
          entry.size,
          Boolean(info?.isFile()),
        );
        if (entry.kind === "directory")
          for (const child of await listing(remote))
            await issue(child.path, () =>
              walk(remoteChild(remote, child.name), path.join(local, child.name), Boolean(info)),
            );
      };
      for (const remote of roots)
        await issue(remote, async () => {
          if (r.action === "delete") {
            const entry = await remoteAt(remote);
            if (!entry) fail(`Source no longer exists: ${remote}`);
            // One recursive delete is one indivisible queue item.
            add(
              { remote, original: entry },
              path.posix.relative(base, remote),
              entry.kind,
              entry.size,
            );
          } else await walk(remote, path.join(localBase, path.posix.basename(remote)), true);
        });
    }
    return true;
  }
  private async process(
    task: Task,
    entry: Entry,
    policy: "skip" | "replace",
    session: DeviceSession,
    signal: AbortSignal,
    progress: (transferred: number, total: number) => void,
  ): Promise<"succeeded" | "skipped"> {
    const { action } = task.request;
    const remote = managedPath(entry.remote, true);
    const current = (await session.list(path.posix.dirname(remote), signal)).find(
      (e) => e.path === remote,
    );
    if (action !== "upload") {
      if (
        !current ||
        current.kind !== entry.original?.kind ||
        current.size !== entry.original.size ||
        current.checksum !== entry.original.checksum
      )
        fail(`Source changed; check again: ${entry.view.label}`);
    } else if (
      current &&
      (!entry.original ||
        current.kind !== entry.original.kind ||
        current.checksum !== entry.original.checksum ||
        current.size !== entry.original.size)
    )
      fail(`Destination changed; check conflicts again: ${entry.view.label}`);
    if (action === "delete") {
      this.changed(task.request, [remote]);
      await session.delete(remote, signal);
      return "succeeded";
    }
    const local = entry.local!;
    await assertLocalParents(local);
    if (action === "upload") {
      const info = await lstat(local);
      if (info.isSymbolicLink() || localStamp(info) !== entry.localStamp)
        fail(`Source changed; check again: ${entry.view.label}`);
      if (entry.view.kind === "directory") {
        if (!current) {
          this.changed(task.request, [remote]);
          await session.createDirectory(remote, signal);
        }
      } else {
        if (entry.view.conflict && policy === "skip") return "skipped";
        const source = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (localStamp(await source.stat()) !== entry.localStamp)
            fail(`Source changed: ${entry.view.label}`);
          const chunks = async function* () {
            for (;;) {
              signal.throwIfAborted();
              const buffer = new Uint8Array(64 * 1024);
              const { bytesRead } = await source.read(buffer);
              if (!bytesRead) break;
              yield buffer.subarray(0, bytesRead);
            }
          };
          this.changed(task.request, [remote]);
          await session.uploadStream(remote, info.size, chunks(), signal, progress);
          if (localStamp(await source.stat()) !== entry.localStamp)
            fail(
              `Source changed during upload; remote file may be incomplete: ${entry.view.label}`,
            );
        } finally {
          await source.close();
        }
      }
    } else {
      const info = await exists(local);
      if (
        info?.isSymbolicLink() ||
        (info && !entry.targetStamp) ||
        (info && entry.view.kind === "file" && localStamp(info) !== entry.targetStamp) ||
        (info && info.isDirectory() !== (entry.view.kind === "directory"))
      )
        fail(`Destination changed; check conflicts again: ${entry.view.label}`);
      if (entry.view.kind === "directory") {
        if (!info) await mkdir(local);
      } else {
        if (entry.view.conflict && policy === "skip") return "skipped";
        await downloadFile(
          session,
          remote,
          local,
          current!,
          signal,
          progress,
          info ? localStamp(info) : undefined,
        );
      }
    }
    return "succeeded";
  }
}
async function assertLocalParents(target: string): Promise<void> {
  let parent = path.dirname(target);
  for (;;) {
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory())
      fail(`Destination/source parent changed: ${parent}`);
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}
async function downloadFile(
  session: DeviceSession,
  remote: string,
  local: string,
  entry: RemoteEntry,
  signal: AbortSignal,
  progress: (transferred: number, total: number) => void,
  approvedStamp?: string,
): Promise<void> {
  const temporary = path.join(path.dirname(local), `.kobrixa-${randomUUID()}.part`);
  const output = await open(temporary, "wx", 0o600);
  let received = 0;
  const checksum = createHash("md5");
  try {
    await session.download(
      remote,
      async (chunk) => {
        checksum.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) fail("Unable to write downloaded file.");
          offset += bytesWritten;
          received += bytesWritten;
        }
      },
      signal,
      progress,
    );
    if (
      (entry.size !== undefined && entry.size !== received) ||
      (entry.checksum && entry.checksum !== checksum.digest("hex"))
    )
      fail("Download verification failed; destination was not replaced.");
    signal.throwIfAborted();
    await output.sync();
  } catch (error) {
    await output.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await output.close();
  try {
    await assertLocalParents(local);
    const latest = await exists(local);
    if (
      latest &&
      (latest.isSymbolicLink() || !latest.isFile() || localStamp(latest) !== approvedStamp)
    )
      fail("Destination changed during download; check again.");
    if (approvedStamp) await rename(temporary, local);
    else {
      await link(temporary, local);
      await unlink(temporary);
    } // No unapproved replacement if a file appears during download.
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
