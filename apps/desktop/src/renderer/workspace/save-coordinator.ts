/** Source and draft writes use the same per-file queue. Failures never poison later retries. */
export class FileWriteQueue {
  private tails = new Map<string, Promise<unknown>>();
  enqueue<T>(workspaceId: string, file: string, work: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}\0${file}`;
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.tails.set(key, next);
    const settled = () => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
    void next.then(settled, settled);
    return next;
  }
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.allSettled([...this.tails.values()]);
  }
}
export interface SaveSnapshot {
  content: string;
  saved: string;
}
export async function saveSnapshot(options: {
  read(): SaveSnapshot | undefined;
  format?: ((content: string) => Promise<string>) | undefined;
  apply(before: string, after: string): void;
  write(content: string): Promise<void>;
  commit(content: string): void;
  retainDraft(content: string | undefined): Promise<void>;
}): Promise<void> {
  const snapshot = options.read();
  if (!snapshot) return;
  // Readers may expose a lazy Monaco buffer. Capture the text before any await.
  const before = snapshot.content;
  let content = before;
  try {
    if (options.format) {
      content = await options.format(content);
      if (options.read()?.content !== before)
        throw new Error(
          "Contents changed during formatting. Save again. / 格式化時內容已變更，請再次儲存。",
        );
      if (content !== before) options.apply(before, content);
    }
    await options.write(content);
  } catch (error) {
    // Saving cancels the debounced draft. Preserve the latest buffer even when
    // formatting or the source write fails before that draft reached disk.
    const latest = options.read();
    if (latest && latest.content !== latest.saved) {
      try {
        await options.retainDraft(latest.content);
      } catch {
        // Keep the buffer dirty and report the original failure; never retry forever.
      }
    }
    throw error;
  }
  // Commit exactly what reached disk, never a newer buffer that arrived during I/O.
  const latest = options.read();
  await options.retainDraft(latest && latest.content !== content ? latest.content : undefined);
  options.commit(content);
}
