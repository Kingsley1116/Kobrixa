/**
 * Shared file tree sync: host project ↔ room Y.Doc ↔ guest mirror.
 *
 * - The host seeds `tree`, `files` and `meta.entry` from its project once the room is synced.
 * - Remote document changes are written to the local workspace (the host's real project or
 *   a guest's `userData/collab/<room>` mirror) through the normal workspace API, so builds,
 *   the simulator and uploads keep working on plain files. The document is the source of
 *   truth while in a room: write conflicts are retried with the document content. Local
 *   content replaced that way (or guest-only files moved to the trash) is reported through
 *   `notices`; the workspace keeps the previous text in Local History.
 * - Local file-tree actions (create, move/rename, trash) are mirrored into the document by
 *   `recordCreate` / `recordMove` / `recordTrash`; viewers cannot mutate the tree.
 *
 * Editor bindings (Monaco ↔ Y.Text) live elsewhere; local text edits reach disk through the
 * app's regular save flow, remote ones through this class.
 */
import * as Y from "yjs";
import { COLLAB_LIMITS, collabPathSchema, type TreeEntry } from "@kobrixa/collab-protocol";
import type {
  KobrixaApi,
  WorkspaceEntry,
  WorkspaceMutationResult,
  WorkspaceSummary,
} from "../../shared/api.js";
import type { CollabApi, CollabConnection, CollabSharePreview } from "../../shared/collab.js";
import type { WorkspaceFileSnapshot } from "../../shared/workspace-files.js";
import type { CollabStore } from "./store.js";
import { canEdit, sharedTypes, type CollabSession, type SharedTypes } from "./types.js";

export type FileSyncWorkspaceApi = Pick<
  KobrixaApi["workspace"],
  "readFile" | "write" | "refresh" | "createEntry" | "moveEntry" | "trashEntry"
>;

export type CollabFileSyncPhase = "idle" | "seeding" | "syncing" | "error";

/** Why a file is not part of the shared document. */
export type CollabSkipReason = CollabSharePreview["skipped"][number]["reason"];

/** What failed; the renderer maps codes to localized copy. */
export type CollabFileSyncErrorCode = "seed" | "read" | "write" | "busy" | "tree" | "sync";

/**
 * Local data the room replaced:
 * - `replaced`: files whose local text differed from the room version and was overwritten
 *   (the previous text is in Local History).
 * - `trashed`: guest-only files moved to the OS trash when joining.
 */
export type CollabFileSyncNoticeKind = "replaced" | "trashed";

export interface CollabFileSyncNotice {
  id: number;
  kind: CollabFileSyncNoticeKind;
  files: readonly string[];
}

export interface CollabFileSyncSnapshot {
  phase: CollabFileSyncPhase;
  /** Debounced or in-flight disk operations. */
  pendingWrites: number;
  /** Files left out of the shared document (too many or too large). */
  skipped: readonly string[];
  /** Reason for each entry of `skipped`. */
  skipReasons: Readonly<Record<string, CollabSkipReason>>;
  /** Undismissed reports of local content the room replaced, at most one per kind. */
  notices: readonly CollabFileSyncNotice[];
  /** Untranslated detail of the last failure, for diagnostics. */
  error?: string | undefined;
  errorCode?: CollabFileSyncErrorCode | undefined;
  /** File the failure concerns, when there is one. */
  errorFile?: string | undefined;
}

export interface CollabFileSyncOptions {
  /** Delay before a remote text change is written to disk. */
  debounceMs?: number;
  /** Current summary of the synced workspace; falls back to `workspace.refresh`. */
  summary?: () => WorkspaceSummary | undefined;
  /** Unsaved editor contents to include in the initial host document. */
  seedContent?: (file: string) => string | undefined;
  /** Called after this sync wrote a file to disk. */
  onDiskWrite?: (file: string, snapshot: WorkspaceFileSnapshot) => void;
  /** Called after this sync created, moved or trashed entries on disk. */
  onTreeChange?: (result: WorkspaceMutationResult) => void;
  /** Room versions recognised by a previous sync of the same room (see `versions`). */
  versions?: Map<string, Set<number>>;
  /** True when the app itself wrote (or accepted) this disk revision, e.g. by saving. */
  knownRevision?: (file: string, revision: string | null) => boolean;
}

const editableFile = /\.(bp|bpi|bpm|json)$/i;
const MANIFEST = "kobrixa.json";
const MAX_WRITE_ATTEMPTS = 3;
/** Room versions remembered per file (see `#seen`); every keystroke adds one. */
const SEEN_VERSIONS = 4096;

function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index < 0 ? "" : entryPath.slice(0, index);
}

function nameOf(entryPath: string): string {
  return entryPath.slice(entryPath.lastIndexOf("/") + 1);
}

function within(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remap(entryPath: string, source: string, target: string): string {
  return entryPath === source ? target : `${target}${entryPath.slice(source.length)}`;
}

function depth(entryPath: string): number {
  return entryPath.split("/").length;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Non-cryptographic 53-bit string hash (cyrb53), used to recognise earlier room versions. */
function hashText(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Returns the limit `content` would break, checking the room budget with replacement bytes subtracted. */
export function shareLimit(
  files: Y.Map<Y.Text>,
  file: string,
  content: string,
): CollabSkipReason | undefined {
  const bytes = byteLength(content);
  if (!validPath(file, "file")) return "format";
  if (bytes > COLLAB_LIMITS.fileBytes) return "size";
  if (!files.has(file) && files.size >= COLLAB_LIMITS.files) return "count";
  let total = bytes;
  for (const [path, text] of files) {
    if (path !== file) total += byteLength(text.toString());
    if (total > COLLAB_LIMITS.roomFileBytes) return "total";
  }
  return undefined;
}

/** Checks the UTF-8 room budget with replacement bytes subtracted. */
export function canShareFile(files: Y.Map<Y.Text>, file: string, content: string): boolean {
  return shareLimit(files, file, content) === undefined;
}

function validPath(entryPath: string, kind: TreeEntry["kind"]): boolean {
  return (
    collabPathSchema.safeParse(entryPath).success &&
    (kind === "directory" || editableFile.test(entryPath))
  );
}

function treeKind(value: unknown): TreeEntry["kind"] | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) return undefined;
  return value.kind === "file" || value.kind === "directory" ? value.kind : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Entry kinds of a summary. The service omits folders that only contain other folders, so
 * every ancestor is added as a directory.
 */
function entryKinds(summary: WorkspaceSummary): Map<string, WorkspaceEntry["kind"]> {
  const kinds = new Map<string, WorkspaceEntry["kind"]>();
  for (const entry of summary.entries) {
    kinds.set(entry.path, entry.kind);
    for (let parent = parentOf(entry.path); parent; parent = parentOf(parent))
      kinds.set(parent, "directory");
  }
  return kinds;
}

/** Replaces `text` with `next` by editing only the changed middle section. */
export function applyMinimalDiff(text: Y.Text, next: string): boolean {
  const current = text.toString();
  if (current === next) return false;
  let start = 0;
  const limit = Math.min(current.length, next.length);
  while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < limit - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  )
    end++;
  // Never split a surrogate pair.
  if (start > 0 && /[\uD800-\uDBFF]/.test(current[start - 1] ?? "")) start--;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(current[current.length - end] ?? "")) end--;
  const removed = current.length - start - end;
  if (removed > 0) text.delete(start, removed);
  const inserted = next.slice(start, next.length - end);
  if (inserted) text.insert(start, inserted);
  return true;
}

export class CollabFileSync {
  readonly #types: SharedTypes;
  readonly #debounceMs: number;
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last content this sync knows to be on disk, per file. */
  readonly #disk = new Map<string, string>();
  /** Disk revision matching `#disk`, when known. */
  readonly #revisions = new Map<string, string | null>();
  /**
   * Hashes of recent room versions per file. The app saves shared files itself, so a disk
   * revision this sync did not write is only an outside edit if the room never held it.
   */
  readonly #seen: Map<string, Set<number>>;
  readonly #cleanup: (() => void)[] = [];
  #snapshot: CollabFileSyncSnapshot = {
    phase: "idle",
    pendingWrites: 0,
    skipped: [],
    skipReasons: {},
    notices: [],
  };
  #noticeId = 0;
  #queue: Promise<void> = Promise.resolve();
  #inflight = 0;
  #started = false;
  #begun = false;
  #disposed = false;
  #stopping = false;

  constructor(
    readonly session: CollabSession,
    readonly workspaceId: string,
    private readonly api: FileSyncWorkspaceApi,
    private readonly options: CollabFileSyncOptions = {},
  ) {
    this.#types = sharedTypes(session.doc);
    this.#debounceMs = options.debounceMs ?? 300;
    this.#seen = options.versions ?? new Map();
  }

  /** Recent room versions, handed to the sync that replaces this one after a role reset. */
  get versions(): Map<string, Set<number>> {
    return this.#seen;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CollabFileSyncSnapshot => this.#snapshot;

  /** True while local tree/file changes may be pushed into the room. */
  get canMutate(): boolean {
    const snapshot = this.session.getSnapshot();
    return (
      !this.#disposed &&
      !this.#stopping &&
      snapshot.status === "connected" &&
      snapshot.synced &&
      canEdit(snapshot.role)
    );
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    const onFiles = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) =>
      this.#onFiles(events, transaction);
    const onTree = (event: Y.YMapEvent<TreeEntry>, transaction: Y.Transaction) =>
      this.#onTree(event, transaction);
    const onTransaction = (transaction: Y.Transaction) => this.#noteVersions(transaction);
    this.#types.files.observeDeep(onFiles);
    this.#types.tree.observe(onTree);
    this.session.doc.on("afterTransaction", onTransaction);
    this.#cleanup.push(
      () => this.#types.files.unobserveDeep(onFiles),
      () => this.#types.tree.unobserve(onTree),
      () => this.session.doc.off("afterTransaction", onTransaction),
      this.session.subscribe(() => this.#maybeBegin()),
    );
    this.#maybeBegin();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#update({ pendingWrites: this.#inflight });
  }

  /** Detaches observers immediately, then drains the changes already received. */
  async stop(discardPending = false): Promise<void> {
    this.#stopping = true;
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    // Role resets replace a potentially divergent document. Cancel debounced and
    // queued writes, but wait for already-started IPC before the new sync writes.
    if (discardPending) this.dispose();
    await this.flush();
    this.dispose();
  }

  /** Writes debounced changes now and waits until all queued disk work has finished. */
  async flush(): Promise<void> {
    for (const [file, timer] of [...this.#timers]) {
      clearTimeout(timer);
      this.#timers.delete(file);
      this.#enqueue(() => this.#writeFromDoc(file));
    }
    let queue: Promise<void>;
    do {
      queue = this.#queue;
      await queue;
    } while (queue !== this.#queue);
    this.#update({ pendingWrites: this.#timers.size + this.#inflight });
  }

  /** False while a retry cannot run (the room is not connected). */
  get canRetry(): boolean {
    return !this.#disposed && this.session.getSnapshot().status === "connected";
  }

  async retry(): Promise<void> {
    if (!this.canRetry) return;
    this.#update({ phase: "idle", error: undefined, errorCode: undefined, errorFile: undefined });
    await this.#enqueue(() => this.#initialize());
  }

  /** Hides a notice once the user has read it. */
  dismissNotice(id: number): void {
    const notices = this.#snapshot.notices.filter((notice) => notice.id !== id);
    if (notices.length !== this.#snapshot.notices.length) this.#update({ notices });
  }

  // ---- Local workspace → document ----

  /** Mirrors a successful local create into the room. */
  recordCreate(entryPath: string, kind: WorkspaceEntry["kind"], content = ""): boolean {
    if (!this.#begun || !this.canMutate || !validPath(entryPath, kind)) return false;
    if (kind === "file" && !this.#fits(entryPath, content)) return false;
    this.session.doc.transact(() => {
      this.#addAncestors(entryPath);
      this.#types.tree.set(entryPath, { kind });
      if (kind === "file") this.#types.files.set(entryPath, new Y.Text(content));
    }, this);
    if (kind === "file") {
      this.#disk.set(entryPath, content);
      this.#revisions.delete(entryPath);
    }
    return true;
  }

  /**
   * Mirrors a successful local move/rename. The document represents it as a delete and an
   * add in one transaction, keeping each file's text.
   */
  recordMove(result: WorkspaceMutationResult): boolean {
    const moved = Object.entries(result.moved);
    if (!moved.length || !this.#begun || !this.canMutate) return false;
    const kinds = new Map(result.workspace.entries.map((entry) => [entry.path, entry.kind]));
    this.session.doc.transact(() => {
      const texts = new Map<string, string>();
      for (const [source] of moved) {
        const text = this.#types.files.get(source);
        if (text) texts.set(source, text.toString());
      }
      for (const [source] of moved) {
        this.#types.tree.delete(source);
        this.#types.files.delete(source);
      }
      for (const [source, target] of moved) {
        const kind = kinds.get(target) ?? (texts.has(source) ? "file" : "directory");
        if (!validPath(target, kind)) continue;
        this.#addAncestors(target);
        this.#types.tree.set(target, { kind });
        const text = texts.get(source);
        if (text !== undefined) this.#types.files.set(target, new Y.Text(text));
      }
    }, this);
    for (const [source, target] of moved) this.#remapLocal(source, target);
    if (result.workspace.manifest?.entry)
      this.#types.meta.set("entry", result.workspace.manifest.entry);
    // Moving the build entry rewrites kobrixa.json on disk.
    if (this.#types.files.has(MANIFEST)) this.#enqueue(() => this.#pullFile(MANIFEST));
    return true;
  }

  /** Mirrors a successful local trash. */
  recordTrash(removed: readonly string[]): boolean {
    if (!removed.length || !this.#begun || !this.canMutate) return false;
    this.session.doc.transact(() => {
      for (const entryPath of removed) {
        this.#types.tree.delete(entryPath);
        this.#types.files.delete(entryPath);
      }
    }, this);
    for (const entryPath of removed) this.#forget(entryPath);
    return true;
  }

  /**
   * Host only: pulls external disk changes of shared files into the document as minimal
   * diffs. Files for which `skip` returns true (e.g. open in a bound editor) are ignored.
   */
  checkDisk(skip: (file: string) => boolean = () => false): Promise<void> {
    if (!this.#begun || !this.canMutate || this.session.getSnapshot().role !== "host")
      return Promise.resolve();
    return this.#enqueue(async () => {
      for (const [file, entry] of this.#types.tree.entries()) {
        if (this.#disposed) return;
        if (treeKind(entry) !== "file" || skip(file) || this.#timers.has(file)) continue;
        await this.#pullFile(file);
      }
    });
  }

  // ---- Document → local workspace ----

  #maybeBegin(): void {
    if (this.#begun || this.#disposed) return;
    const snapshot = this.session.getSnapshot();
    if (!snapshot.synced || snapshot.status === "closed") return;
    this.#begun = true;
    void this.#enqueue(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    const host = this.session.getSnapshot().role === "host";
    if (host && this.#types.tree.size === 0) await this.#seed();
    else await this.#reconcile(!host);
    if (this.#snapshot.phase !== "error") this.#update({ phase: "syncing" });
  }

  async #seed(): Promise<void> {
    this.#update({ phase: "seeding" });
    try {
      const summary = await this.#summary();
      const skipped: string[] = [];
      const skipReasons: Record<string, CollabSkipReason> = {};
      const skip = (file: string, reason: CollabSkipReason) => {
        skipped.push(file);
        skipReasons[file] = reason;
      };
      const files: [string, string, string | null, string][] = [];
      let roomBytes = 0;
      const directories = summary.entries
        .filter((entry) => entry.kind === "directory" && validPath(entry.path, "directory"))
        .map((entry) => entry.path);
      for (const entry of summary.entries) {
        if (entry.kind !== "file") continue;
        if (!validPath(entry.path, "file")) {
          skip(entry.path, "format");
          continue;
        }
        if (files.length >= COLLAB_LIMITS.files) {
          skip(entry.path, "count");
          continue;
        }
        const snapshot = await this.api.readFile(this.workspaceId, entry.path);
        if (snapshot.content === null) continue;
        const content = this.options.seedContent?.(entry.path) ?? snapshot.content;
        const bytes = byteLength(content);
        if (bytes > COLLAB_LIMITS.fileBytes || roomBytes + bytes > COLLAB_LIMITS.roomFileBytes) {
          skip(entry.path, bytes > COLLAB_LIMITS.fileBytes ? "size" : "total");
          continue;
        }
        files.push([entry.path, content, snapshot.revision, snapshot.content]);
        roomBytes += bytes;
      }
      if (this.#disposed) return;
      this.session.doc.transact(() => {
        // Another host session may have seeded meanwhile; never duplicate content.
        if (this.#types.tree.size > 0) return;
        for (const directory of directories) this.#types.tree.set(directory, { kind: "directory" });
        for (const [file, content] of files) {
          this.#addAncestors(file);
          this.#types.tree.set(file, { kind: "file" });
          this.#types.files.set(file, new Y.Text(content));
        }
        if (summary.manifest?.entry) this.#types.meta.set("entry", summary.manifest.entry);
      }, this);
      for (const [file, , revision, diskContent] of files) {
        this.#disk.set(file, diskContent);
        this.#revisions.set(file, revision);
      }
      this.#update({ skipped, skipReasons });
    } catch (error) {
      this.#fail(error, "seed");
    }
  }

  /** Brings the local workspace in line with the document after joining. */
  async #reconcile(removeExtras: boolean): Promise<void> {
    const entries = await this.#entries().catch((error: unknown) => {
      this.#fail(error, "read");
      return undefined;
    });
    if (!entries) return;
    const desired = new Map<string, TreeEntry["kind"]>();
    for (const [entryPath, value] of this.#types.tree.entries()) {
      const kind = treeKind(value);
      if (kind && validPath(entryPath, kind)) desired.set(entryPath, kind);
    }
    const extras = removeExtras
      ? [...entries.keys()].filter(
          (entryPath) =>
            entryPath !== MANIFEST &&
            desired.get(entryPath) !== entries.get(entryPath) &&
            // Keep folders that still contain shared entries.
            ![...desired.keys()].some(
              (wanted) => wanted !== entryPath && within(entryPath, wanted),
            ),
        )
      : [];
    // Entries whose kind changed must go first; other extras go last, after the shared
    // manifest is written (an implicit project's only entry file cannot be trashed).
    // Guests are told which local entries went to the OS trash.
    this.#notice(
      "trashed",
      await this.#trash(
        extras.filter((entryPath) => desired.has(entryPath)),
        entries,
      ),
    );
    await this.#createDirectories(
      [...desired].filter(([, kind]) => kind === "directory").map(([entryPath]) => entryPath),
      entries,
    );
    // A guest mirror normally just lags the room; joining already offers a copy when it
    // has local changes, so only the host reports replaced files here.
    for (const [file, kind] of desired) {
      if (this.#disposed) return;
      if (kind === "file") await this.#writeFromDoc(file, entries, !removeExtras);
    }
    this.#notice(
      "trashed",
      await this.#trash(
        extras.filter((entryPath) => !desired.has(entryPath)),
        entries,
      ),
    );
  }

  #onFiles(events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void {
    if (!this.#begun || this.#disposed || transaction.local) return;
    const touched = new Set<string>();
    for (const event of events) {
      if (event.target === this.#types.files) {
        for (const [key, change] of event.changes.keys)
          if (change.action !== "delete") touched.add(key);
      } else {
        const key = event.path[0];
        if (typeof key === "string") touched.add(key);
      }
    }
    for (const file of touched) this.#schedule(file);
  }

  #onTree(event: Y.YMapEvent<TreeEntry>, transaction: Y.Transaction): void {
    if (!this.#begun || this.#disposed || transaction.local) return;
    const deleted = new Map<string, TreeEntry["kind"]>();
    const added = new Map<string, TreeEntry["kind"]>();
    for (const [key, change] of event.changes.keys) {
      const before = change.action === "add" ? undefined : treeKind(change.oldValue);
      const after = change.action === "delete" ? undefined : treeKind(this.#types.tree.get(key));
      if (before === after) continue;
      if (before) deleted.set(key, before);
      if (after) added.set(key, after);
    }
    for (const entryPath of deleted.keys()) {
      for (const [file, timer] of [...this.#timers]) {
        if (!within(entryPath, file)) continue;
        clearTimeout(timer);
        this.#timers.delete(file);
      }
    }
    // Capture texts now: renames are detected against the document at transaction time.
    const texts = new Map<string, string>();
    for (const [entryPath, kind] of added) {
      const text = kind === "file" ? this.#types.files.get(entryPath) : undefined;
      if (text) texts.set(entryPath, text.toString());
    }
    if (deleted.size || added.size)
      void this.#enqueue(() => this.#applyTree(deleted, added, texts));
  }

  async #applyTree(
    deleted: Map<string, TreeEntry["kind"]>,
    added: Map<string, TreeEntry["kind"]>,
    texts: Map<string, string>,
  ): Promise<void> {
    const entries = await this.#entries().catch((error: unknown) => {
      this.#fail(error, "read");
      return undefined;
    });
    if (!entries) return;
    for (const [entryPath, kind] of [...added])
      if (!validPath(entryPath, kind)) added.delete(entryPath);
    const moves: [string, string][] = [];
    const consumedSources = new Set<string>();
    const consumedTargets = new Set<string>();
    const children = (map: Map<string, TreeEntry["kind"]>, parent: string) =>
      [...map]
        .filter(([entryPath]) => entryPath !== parent && within(parent, entryPath))
        .map(([entryPath, kind]) => [entryPath.slice(parent.length + 1), kind] as const)
        .sort(([left], [right]) => left.localeCompare(right));
    const topmost = (map: Map<string, TreeEntry["kind"]>, entryPath: string) =>
      ![...map.keys()].some((other) => other !== entryPath && within(other, entryPath));
    // Directory renames: every descendant moved with unchanged content.
    for (const [source, kind] of deleted) {
      if (kind !== "directory" || !topmost(deleted, source) || entries.get(source) !== kind)
        continue;
      const sourceChildren = children(deleted, source);
      for (const [target, targetKind] of added) {
        if (
          targetKind !== "directory" ||
          consumedTargets.has(target) ||
          !topmost(added, target) ||
          entries.has(target)
        )
          continue;
        const targetChildren = children(added, target);
        const same =
          sourceChildren.length === targetChildren.length &&
          sourceChildren.every(([relative, childKind], index) => {
            const [otherRelative, otherKind] = targetChildren[index]!;
            if (relative !== otherRelative || childKind !== otherKind) return false;
            if (childKind !== "file") return true;
            const text = texts.get(`${target}/${relative}`);
            return text !== undefined && text === this.#disk.get(`${source}/${relative}`);
          });
        if (!same) continue;
        moves.push([source, target]);
        for (const [entryPath] of deleted)
          if (within(source, entryPath)) consumedSources.add(entryPath);
        for (const [entryPath] of added)
          if (within(target, entryPath)) consumedTargets.add(entryPath);
        break;
      }
    }
    // File renames: same text as the deleted file had on disk.
    for (const [source, kind] of deleted) {
      if (kind !== "file" || consumedSources.has(source) || entries.get(source) !== "file")
        continue;
      const known = this.#disk.get(source);
      if (known === undefined) continue;
      for (const [target, targetKind] of added) {
        if (targetKind !== "file" || consumedTargets.has(target) || entries.has(target)) continue;
        if (texts.get(target) !== known) continue;
        moves.push([source, target]);
        consumedSources.add(source);
        consumedTargets.add(target);
        break;
      }
    }
    await this.#createDirectories(
      [...added]
        .filter(([entryPath, kind]) => kind === "directory" && !consumedTargets.has(entryPath))
        .map(([entryPath]) => entryPath),
      entries,
    );
    for (const [source, target] of moves) {
      if (this.#disposed) return;
      try {
        await this.#ensureDirectory(parentOf(target), entries);
        const result = await this.api.moveEntry(this.workspaceId, source, target);
        this.#adopt(result, entries);
        for (const [from, to] of Object.entries(result.moved)) this.#remapLocal(from, to);
      } catch (error) {
        this.#fail(error, "tree", target);
        // Fall back to create + trash.
        consumedSources.delete(source);
        for (const [entryPath] of added)
          if (within(target, entryPath)) consumedTargets.delete(entryPath);
      }
    }
    await this.#trash(
      [...deleted.keys()].filter(
        (entryPath) =>
          !consumedSources.has(entryPath) &&
          !this.#types.tree.has(entryPath) &&
          entries.has(entryPath),
      ),
      entries,
    );
    // Directories of failed moves.
    await this.#createDirectories(
      [...added]
        .filter(([entryPath, kind]) => kind === "directory" && !consumedTargets.has(entryPath))
        .map(([entryPath]) => entryPath),
      entries,
    );
    // A target that already exists locally (e.g. a host file that was never shared) is
    // overwritten like any outside edit: the write keeps its text in Local History and
    // `#writeFromDoc` reports it as replaced.
    for (const [file, kind] of added) {
      if (this.#disposed) return;
      if (kind === "file" && !consumedTargets.has(file)) await this.#writeFromDoc(file, entries);
    }
  }

  async #createDirectories(
    directories: string[],
    entries: Map<string, WorkspaceEntry["kind"]>,
  ): Promise<void> {
    for (const directory of [...directories].sort((left, right) => depth(left) - depth(right))) {
      if (this.#disposed) return;
      if (treeKind(this.#types.tree.get(directory)) !== "directory") continue;
      try {
        await this.#ensureDirectory(directory, entries);
      } catch (error) {
        this.#fail(error, "tree", directory);
      }
    }
  }

  async #ensureDirectory(
    directory: string,
    entries: Map<string, WorkspaceEntry["kind"]>,
  ): Promise<void> {
    if (!directory || entries.get(directory) === "directory") return;
    await this.#ensureDirectory(parentOf(directory), entries);
    const result = await this.api.createEntry(
      this.workspaceId,
      parentOf(directory),
      "directory",
      nameOf(directory),
    );
    this.#adopt(result, entries);
  }

  /** Moves entries to the OS trash; returns the top-level paths that were trashed. */
  async #trash(paths: string[], entries: Map<string, WorkspaceEntry["kind"]>): Promise<string[]> {
    const targets = paths.filter(
      (entryPath) => !paths.some((other) => other !== entryPath && within(other, entryPath)),
    );
    const trashed: string[] = [];
    for (const entryPath of targets) {
      if (this.#disposed) break;
      if (!entries.has(entryPath)) continue;
      try {
        const result = await this.api.trashEntry(this.workspaceId, entryPath);
        this.#adopt(result, entries);
        for (const removed of result.removed) this.#forget(removed);
        trashed.push(entryPath);
      } catch (error) {
        this.#fail(error, "tree", entryPath);
      }
    }
    return trashed;
  }

  #schedule(file: string): void {
    const previous = this.#timers.get(file);
    if (previous) clearTimeout(previous);
    this.#timers.set(
      file,
      setTimeout(() => {
        this.#timers.delete(file);
        void this.#enqueue(() => this.#writeFromDoc(file));
      }, this.#debounceMs),
    );
    this.#update({ pendingWrites: this.#timers.size + this.#inflight });
  }

  /** Writes the current document text using a bounded optimistic revision retry. */
  async #writeFromDoc(
    file: string,
    known?: Map<string, WorkspaceEntry["kind"]>,
    report = true,
  ): Promise<void> {
    if (this.#disposed || !validPath(file, "file")) return;
    const currentContent = (): string | undefined =>
      treeKind(this.#types.tree.get(file)) === "file"
        ? this.#types.files.get(file)?.toString()
        : undefined;
    // Disk text that neither this sync, the app nor the room produced is replaced below;
    // report it.
    const baseline = this.#disk.get(file);
    let replaced = false;
    const observe = (disk: WorkspaceFileSnapshot) => {
      if (report && this.#outside(file, disk, baseline, currentContent())) replaced = true;
    };
    let busy = false;
    try {
      let expected = this.#revisions.get(file);
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        let content = currentContent();
        if (content === undefined || this.#disposed) return;
        if (this.#disk.get(file) === content && expected !== undefined) return;
        if (byteLength(content) > COLLAB_LIMITS.fileBytes) {
          this.#skip(file, "size");
          return;
        }
        if (expected === undefined) {
          const snapshot = await this.api.readFile(this.workspaceId, file);
          expected = snapshot.revision;
          observe(snapshot);
          this.#remember(file, snapshot);
        }
        if (expected === null) {
          const entries = known ?? (await this.#entries());
          if (currentContent() === undefined || this.#disposed) return;
          await this.#ensureDirectory(parentOf(file), entries);
          if (currentContent() === undefined || this.#disposed) return;
          if (!entries.has(file)) {
            const result = await this.api.createEntry(
              this.workspaceId,
              parentOf(file),
              "file",
              nameOf(file),
            );
            this.#adopt(result, entries);
          }
          const created = await this.api.readFile(this.workspaceId, file);
          expected = created.revision;
          this.#remember(file, created);
        }
        // A room update can arrive during the disk reads. Never persist an older edit
        // or recreate a file that was deleted while those reads were in flight.
        content = currentContent();
        if (content === undefined || this.#disposed) return;
        if (byteLength(content) > COLLAB_LIMITS.fileBytes) {
          this.#skip(file, "size");
          return;
        }
        if (this.#disk.get(file) === content) return;
        const result = await this.api.write(this.workspaceId, file, content, expected);
        if (this.#disposed) return;
        if (result.status === "saved" || result.snapshot.content === content) {
          this.#remember(file, result.snapshot);
          this.options.onDiskWrite?.(file, result.snapshot);
          if (replaced && result.status === "saved") this.#notice("replaced", [file]);
          return;
        }
        // The shared document is authoritative while in a room, but every retry
        // still checks the observed revision. Repeated deletion is also bounded.
        observe(result.snapshot);
        expected = result.snapshot.revision;
        if (expected === null) known = undefined;
      }
      busy = true;
      throw new Error(`Could not save shared file '${file}': it keeps changing on disk.`);
    } catch (error) {
      this.#fail(error, busy ? "busy" : "write", file);
    }
  }

  /** Reads `file` from disk and applies any change to its Y.Text. */
  async #pullFile(file: string): Promise<void> {
    const text = this.#types.files.get(file);
    if (!text) return;
    try {
      const snapshot = await this.api.readFile(this.workspaceId, file);
      if (snapshot.content === null || this.#disposed) return;
      if (snapshot.revision === this.#revisions.get(file)) return;
      if (!this.#fits(file, snapshot.content)) return;
      this.#remember(file, snapshot);
      if (this.#timers.has(file) || !this.canMutate) return;
      this.session.doc.transact(() => applyMinimalDiff(text, snapshot.content!), this);
    } catch (error) {
      this.#fail(error, "read", file);
    }
  }

  // ---- Helpers ----

  #enqueue(action: () => Promise<void>): Promise<void> {
    this.#inflight++;
    this.#update({ pendingWrites: this.#timers.size + this.#inflight });
    const run = this.#queue.then(async () => {
      try {
        if (!this.#disposed) await action();
      } catch (error) {
        this.#fail(error, "sync");
      } finally {
        this.#inflight--;
        this.#update({ pendingWrites: this.#timers.size + this.#inflight });
      }
    });
    this.#queue = run;
    return run;
  }

  async #summary(): Promise<WorkspaceSummary> {
    return this.options.summary?.() ?? (await this.api.refresh(this.workspaceId, {})).workspace;
  }

  async #entries(): Promise<Map<string, WorkspaceEntry["kind"]>> {
    // Tree work must inspect disk, not a renderer summary that may lag earlier writes.
    return entryKinds((await this.api.refresh(this.workspaceId, {})).workspace);
  }

  #adopt(result: WorkspaceMutationResult, entries: Map<string, WorkspaceEntry["kind"]>): void {
    if (this.#disposed) return;
    entries.clear();
    for (const [entryPath, kind] of entryKinds(result.workspace)) entries.set(entryPath, kind);
    this.options.onTreeChange?.(result);
  }

  #addAncestors(entryPath: string): void {
    for (let parent = parentOf(entryPath); parent; parent = parentOf(parent))
      if (!this.#types.tree.has(parent)) this.#types.tree.set(parent, { kind: "directory" });
  }

  #fits(file: string, content: string): boolean {
    const limit = shareLimit(this.#types.files, file, content);
    if (!limit) return true;
    this.#skip(file, limit);
    return false;
  }

  /** Records a hash of every shared text a transaction changed. */
  #noteVersions(transaction: Y.Transaction): void {
    const files = new Set<string>();
    for (const [type, keys] of transaction.changed) {
      if (type === (this.#types.files as Y.AbstractType<unknown>)) {
        for (const key of keys) if (key !== null) files.add(key);
      } else if (type instanceof Y.Text && type.parent === this.#types.files) {
        const key = type._item?.parentSub;
        if (key) files.add(key);
      }
    }
    for (const file of files) {
      const text = this.#types.files.get(file);
      if (!text) {
        this.#seen.delete(file);
        continue;
      }
      const hashes = this.#seen.get(file) ?? new Set<number>();
      const hash = hashText(text.toString());
      // Re-insert to keep the set ordered from oldest to newest.
      hashes.delete(hash);
      hashes.add(hash);
      if (hashes.size > SEEN_VERSIONS) hashes.delete(hashes.values().next().value!);
      this.#seen.set(file, hashes);
    }
  }

  /** True when `disk` is local content that the room never held and is about to replace. */
  #outside(
    file: string,
    disk: WorkspaceFileSnapshot,
    baseline: string | undefined,
    room: string | undefined,
  ): boolean {
    const content = disk.content;
    if (content === null || room === undefined || content === room || content === baseline)
      return false;
    if (this.options.knownRevision?.(file, disk.revision)) return false;
    return !this.#seen.get(file)?.has(hashText(content));
  }

  #notice(kind: CollabFileSyncNoticeKind, files: readonly string[]): void {
    if (!files.length || this.#disposed) return;
    const notices = [...this.#snapshot.notices];
    const index = notices.findIndex((notice) => notice.kind === kind);
    if (index < 0) notices.push({ id: ++this.#noticeId, kind, files: [...new Set(files)] });
    else {
      const existing = notices[index]!;
      const merged = [...new Set([...existing.files, ...files])];
      if (merged.length === existing.files.length) return;
      notices[index] = { ...existing, files: merged };
    }
    this.#update({ notices });
  }

  #remember(file: string, snapshot: WorkspaceFileSnapshot): void {
    if (snapshot.content === null) this.#forget(file);
    else {
      this.#disk.set(file, snapshot.content);
      this.#revisions.set(file, snapshot.revision);
    }
  }

  #remapLocal(source: string, target: string): void {
    for (const map of [this.#disk, this.#revisions] as Map<string, unknown>[]) {
      for (const [entryPath, value] of [...map]) {
        if (!within(source, entryPath)) continue;
        map.delete(entryPath);
        map.set(remap(entryPath, source, target), value);
      }
    }
  }

  #forget(entryPath: string): void {
    for (const map of [this.#disk, this.#revisions] as Map<string, unknown>[])
      for (const key of [...map.keys()]) if (within(entryPath, key)) map.delete(key);
  }

  #skip(file: string, reason: CollabSkipReason): void {
    if (this.#snapshot.skipped.includes(file)) return;
    this.#update({
      skipped: [...this.#snapshot.skipped, file],
      skipReasons: { ...this.#snapshot.skipReasons, [file]: reason },
    });
  }

  #fail(error: unknown, code: CollabFileSyncErrorCode, file?: string): void {
    this.#update({ phase: "error", error: message(error), errorCode: code, errorFile: file });
  }

  #update(patch: Partial<CollabFileSyncSnapshot>): void {
    const next = { ...this.#snapshot, ...patch };
    if (
      (Object.keys(next) as (keyof CollabFileSyncSnapshot)[]).every(
        (key) => next[key] === this.#snapshot[key],
      )
    )
      return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Guest flow: opens (or reuses) the room's mirror folder and registers it as a project
 * through `adopt` (the app's handler for `workspace.open()` results).
 */
export async function openGuestWorkspace(
  api: Pick<CollabApi, "openMirror">,
  connection: Pick<CollabConnection, "roomId" | "projectName">,
  adopt: (summary: WorkspaceSummary) => Promise<void> = async () => {},
): Promise<WorkspaceSummary> {
  const summary = await api.openMirror(connection.roomId, connection.projectName);
  await adopt(summary);
  return summary;
}

export interface CollabFileSyncBinding {
  session: CollabSession;
  workspaceId: string;
  sync: CollabFileSync;
  /** True while the local participant may not change the shared tree. */
  readOnly: boolean;
}

export interface CollabFileSyncManagerDependencies {
  workspace: FileSyncWorkspaceApi;
  collab: Pick<CollabApi, "openMirror">;
  /** Project the host shares when it starts a room. */
  activeWorkspaceId: () => string | undefined;
  /** Registers a guest mirror as a project session. */
  adopt: (summary: WorkspaceSummary) => Promise<void>;
  summary?: (workspaceId: string) => WorkspaceSummary | undefined;
  seedContent?: (workspaceId: string, file: string) => string | undefined;
  onDiskWrite?: (workspaceId: string, file: string, snapshot: WorkspaceFileSnapshot) => void;
  onTreeChange?: (result: WorkspaceMutationResult) => void;
  knownRevision?: (workspaceId: string, file: string, revision: string | null) => boolean;
  report?: (error: unknown) => void;
  debounceMs?: number;
}

/** Starts and stops a `CollabFileSync` whenever the store's session changes. */
export class CollabFileSyncManager {
  readonly #listeners = new Set<() => void>();
  #binding: CollabFileSyncBinding | null = null;
  #session: CollabSession | null = null;
  #unsubscribeSession: () => void = () => {};
  #draining: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Pick<CollabStore, "subscribe" | "getSnapshot">,
    private readonly dependencies: CollabFileSyncManagerDependencies,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CollabFileSyncBinding | null => this.#binding;

  /** Returns the active sync for `workspaceId`, if that project is shared. */
  for(workspaceId: string | undefined): CollabFileSync | undefined {
    return this.#binding && this.#binding.workspaceId === workspaceId
      ? this.#binding.sync
      : undefined;
  }

  attach(): () => void {
    const unsubscribe = this.store.subscribe(() => void this.#sessionChanged());
    void this.#sessionChanged();
    return () => {
      unsubscribe();
      this.#session = null;
      void this.#stop();
    };
  }

  async #sessionChanged(): Promise<void> {
    const session = this.store.getSnapshot();
    if (session === this.#session) return;
    const previous = this.#binding;
    const replaced =
      !!session &&
      !!previous &&
      session.connection.roomId === previous.session.connection.roomId &&
      session.connection.participantId === previous.session.connection.participantId;
    const retainedWorkspaceId = replaced ? previous.workspaceId : undefined;
    this.#session = session;
    const draining = this.#stop(replaced);
    if (!session) return;
    try {
      await draining;
      if (this.#session !== session) return;
      let workspaceId: string | undefined = retainedWorkspaceId ?? session.connection.workspaceId;
      if (!workspaceId && session.connection.role === "host")
        workspaceId = this.dependencies.activeWorkspaceId();
      else if (!workspaceId) {
        const summary = await this.dependencies.collab.openMirror(
          session.connection.roomId,
          session.connection.projectName,
        );
        if (this.#session !== session) return;
        await this.dependencies.adopt(summary);
        workspaceId = summary.id;
      }
      if (!workspaceId || this.#session !== session) return;
      this.#start(session, workspaceId, replaced && previous ? previous.sync : undefined);
    } catch (error) {
      if (this.#session === session) this.dependencies.report?.(error);
    }
  }

  #start(session: CollabSession, workspaceId: string, previous?: CollabFileSync): void {
    const { dependencies } = this;
    const sync = new CollabFileSync(session, workspaceId, dependencies.workspace, {
      ...(dependencies.debounceMs !== undefined ? { debounceMs: dependencies.debounceMs } : {}),
      ...(dependencies.summary ? { summary: () => dependencies.summary!(workspaceId) } : {}),
      ...(dependencies.seedContent
        ? { seedContent: (file: string) => dependencies.seedContent!(workspaceId, file) }
        : {}),
      onDiskWrite: (file, snapshot) => dependencies.onDiskWrite?.(workspaceId, file, snapshot),
      onTreeChange: (result) => dependencies.onTreeChange?.(result),
      ...(previous ? { versions: previous.versions } : {}),
      ...(dependencies.knownRevision
        ? {
            knownRevision: (file: string, revision: string | null) =>
              dependencies.knownRevision!(workspaceId, file, revision),
          }
        : {}),
    });
    const readOnly = () =>
      session.getSnapshot().status !== "connected" ||
      !session.getSnapshot().synced ||
      !canEdit(session.getSnapshot().role);
    this.#binding = { session, workspaceId, sync, readOnly: readOnly() };
    this.#unsubscribeSession = session.subscribe(() => {
      const binding = this.#binding;
      if (!binding || binding.session !== session || binding.readOnly === readOnly()) return;
      this.#binding = { ...binding, readOnly: readOnly() };
      this.#emit();
    });
    sync.start();
    this.#emit();
  }

  #stop(replacing = false): Promise<void> {
    this.#unsubscribeSession();
    this.#unsubscribeSession = () => {};
    const binding = this.#binding;
    if (!binding) return this.#draining;
    // Keep the project read-only through a role-reset drain; an absent binding
    // would temporarily make the renderer treat it as an ordinary local project.
    this.#binding = replacing ? { ...binding, readOnly: true } : null;
    this.#draining = Promise.all([this.#draining, binding.sync.stop(replacing)]).then(() => {});
    this.#emit();
    return this.#draining;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
