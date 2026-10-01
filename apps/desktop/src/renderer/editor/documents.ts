/** Document text is read lazily from Monaco, independently of React snapshots. */
export interface DocumentBuffer {
  getValue(): string;
  getValueLength(): number;
  getVersionId(): number;
  getAlternativeVersionId(): number;
  setValue(value: string): void;
}
export interface DocumentTab {
  file: string;
  content: string;
  saved: string;
  dirty?: boolean;
}
interface Document {
  file: string;
  text: string;
  saved: string;
  dirty: boolean;
  revision: number;
  buffer?: DocumentBuffer | undefined;
  cleanVersion?: number | undefined;
  observedVersion?: number | undefined;
  cached?: { version: number; text: string } | undefined;
}
export class Documents {
  private documents = new Map<string, Document>();
  private snapshot: DocumentTab[] = [];
  private paths: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly changes = new Set<() => void>();
  revision = 0;
  readonly getSnapshot = (): DocumentTab[] => this.snapshot;
  readonly getOpenFiles = (): string[] => this.paths;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly onChange = (listener: () => void) => {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  };
  version(file: string): number {
    return this.documents.get(file)?.revision ?? -1;
  }
  reader(file: string): () => string {
    const document = this.documents.get(file);
    return () => (document ? this.read(document) : "");
  }
  private read(document: Document): string {
    if (!document.buffer) return document.text;
    const version = document.buffer.getVersionId();
    if (document.cached?.version !== version)
      document.cached = { version, text: document.buffer.getValue() };
    return document.cached.text;
  }
  bind(file: string, buffer: DocumentBuffer): void {
    const document = this.documents.get(file);
    if (!document || document.buffer === buffer) return;
    const content = this.read(document);
    if (content !== buffer.getValue()) buffer.setValue(content);
    document.buffer = buffer;
    document.observedVersion = buffer.getVersionId();
    document.cached = undefined;
    document.cleanVersion = document.dirty ? undefined : buffer.getAlternativeVersionId();
  }
  unbind(file: string): void {
    const document = this.documents.get(file);
    if (!document?.buffer) return;
    document.text = this.read(document);
    document.buffer = undefined;
    document.cached = undefined;
    document.cleanVersion = undefined;
  }
  changed(file: string): void {
    const document = this.documents.get(file);
    if (!document?.buffer) return;
    const wasDirty = document.dirty;
    document.cached = undefined;
    document.observedVersion = document.buffer.getVersionId();
    document.dirty =
      document.buffer.getAlternativeVersionId() !== document.cleanVersion &&
      (document.buffer.getValueLength() !== document.saved.length ||
        this.read(document) !== document.saved);
    if (!document.dirty) document.cleanVersion = document.buffer.getAlternativeVersionId();
    document.revision++;
    this.revision++;
    if (wasDirty !== document.dirty) this.publish();
    for (const listener of this.changes) listener();
  }
  replace(tabs: DocumentTab[]): void {
    const next = new Map<string, Document>();
    let changed = false;
    for (const tab of tabs) {
      const previous = this.documents.get(tab.file);
      const content = tab.content;
      if (previous) {
        if (previous.buffer && previous.observedVersion !== previous.buffer.getVersionId()) {
          previous.observedVersion = previous.buffer.getVersionId();
          previous.revision++;
          changed = true;
        }
        const before = this.read(previous);
        if (before !== content) {
          previous.buffer?.setValue(content);
          previous.observedVersion = previous.buffer?.getVersionId();
          previous.text = content;
          previous.cached = undefined;
          previous.revision++;
          changed = true;
        }
        if (previous.saved !== tab.saved) changed = true;
        if (previous.dirty !== (content !== tab.saved)) changed = true;
        previous.saved = tab.saved;
        previous.dirty = content !== tab.saved;
        previous.cleanVersion = previous.dirty
          ? undefined
          : previous.buffer?.getAlternativeVersionId();
        next.set(tab.file, previous);
      } else {
        next.set(tab.file, {
          file: tab.file,
          text: content,
          saved: tab.saved,
          dirty: content !== tab.saved,
          revision: 0,
        });
        changed = true;
      }
    }
    for (const file of this.documents.keys())
      if (!next.has(file)) {
        this.unbind(file);
        changed = true;
      }
    this.documents = next;
    const paths = [...next.keys()];
    if (paths.length !== this.paths.length || paths.some((path, i) => path !== this.paths[i])) {
      this.paths = paths;
      changed = true;
    }
    if (!changed) return;
    this.revision++;
    this.publish();
    for (const listener of this.changes) listener();
  }
  private publish(): void {
    // Use the same lazy cache for readers retained by a pending save or draft.
    const readDocument = (document: Document) => this.read(document);
    this.snapshot = [...this.documents.values()].map((document) => ({
      file: document.file,
      saved: document.saved,
      dirty: document.dirty,
      get content() {
        return document.buffer ? readDocument(document) : document.text;
      },
    }));
    for (const listener of this.listeners) listener();
  }
}

export class CursorStore {
  private value = { line: 1, column: 1 };
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = () => this.value;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly update = (value: { line: number; column: number }): void => {
    if (value.line === this.value.line && value.column === this.value.column) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  };
}
