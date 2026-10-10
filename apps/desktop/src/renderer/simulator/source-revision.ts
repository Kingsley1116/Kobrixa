export interface SourceTracker {
  readonly files: ReadonlyMap<string, { content: string; saved: string }>;
  /** Bumps on every edit the compiler would see; opening, saving or closing a clean tab does not. */
  readonly version: number;
}

/** Folds the current open documents into the tracker, so only real source changes mark a program stale. */
export function trackSources(
  previous: SourceTracker | undefined,
  tabs: readonly { file: string; content: string; saved: string }[],
): SourceTracker {
  let changed = false;
  const files = new Map<string, { content: string; saved: string }>();
  for (const { file, content, saved } of tabs) {
    const old = previous?.files.get(file);
    // A newly opened tab matters only if it differs from disk, e.g. a restored draft.
    if (previous && (old ? old.content !== content : content !== saved)) changed = true;
    files.set(file, { content, saved });
  }
  // Closing a tab with unsaved edits discards them, so the compiled text goes back to disk.
  for (const [file, old] of previous?.files ?? [])
    if (!files.has(file) && old.content !== old.saved) changed = true;
  return { files, version: (previous?.version ?? 0) + (changed ? 1 : 0) };
}
