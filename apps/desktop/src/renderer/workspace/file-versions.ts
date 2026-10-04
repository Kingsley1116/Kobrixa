import type { WorkspaceFileSnapshot } from "../../shared/workspace-files.js";

/** The accepted disk baseline is independent of unsaved editor text. */
export class FileVersions {
  private readonly baselines = new Map<string, WorkspaceFileSnapshot>();
  readonly conflicts = new Map<string, WorkspaceFileSnapshot>();
  generation = 0;

  baseline(file: string): WorkspaceFileSnapshot | undefined {
    return this.baselines.get(file);
  }

  known(): Record<string, string | null> {
    return Object.fromEntries(
      [...this.baselines].map(([file, base]) => [
        file,
        (this.conflicts.get(file) ?? base).revision,
      ]),
    );
  }

  accept(file: string, snapshot: WorkspaceFileSnapshot): void {
    this.baselines.set(file, snapshot);
    this.conflicts.delete(file);
    this.generation++;
  }

  recover(
    file: string,
    snapshot: WorkspaceFileSnapshot,
    draft: string | undefined,
    draftRevision: string | null | undefined,
  ): void {
    this.accept(file, snapshot);
    if (
      draft !== undefined &&
      (snapshot.content === null ||
        (draft !== snapshot.content &&
          (draftRevision === undefined || draftRevision !== snapshot.revision)))
    ) {
      if (draftRevision !== undefined)
        this.baselines.set(file, { ...snapshot, revision: draftRevision });
      this.reject(file, snapshot);
    }
  }

  reject(file: string, snapshot: WorkspaceFileSnapshot): void {
    this.conflicts.set(file, snapshot);
    this.generation++;
  }

  /** A previously observed conflict always needs an explicit resolution. */
  observe(
    file: string,
    snapshot: WorkspaceFileSnapshot,
    local: { content: string; saved: string } | undefined,
    autoReload = true,
  ): "unchanged" | "reload" | "conflict" {
    const previous = this.conflicts.get(file) ?? this.baselines.get(file);
    if (previous && previous.revision === snapshot.revision) return "unchanged";
    if (
      !autoReload ||
      snapshot.content === null ||
      this.conflicts.has(file) ||
      (local && local.content !== local.saved && local.content !== snapshot.content)
    ) {
      this.reject(file, snapshot);
      return "conflict";
    }
    this.accept(file, snapshot);
    return "reload";
  }

  forget(file: string): void {
    this.baselines.delete(file);
    this.conflicts.delete(file);
    this.generation++;
  }

  remap(moved: Record<string, string>): void {
    for (const map of [this.baselines, this.conflicts]) {
      const entries = [...map];
      for (const [file] of entries) if (moved[file]) map.delete(file);
      for (const [file, snapshot] of entries) if (moved[file]) map.set(moved[file]!, snapshot);
    }
    this.generation++;
  }
}
