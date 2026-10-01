import type { BasicPlusSymbol } from "@kobrixa/basic-plus";
import type { editor, IDisposable, Position } from "monaco-editor";
import type { WorkspaceSummary } from "../../shared/api.js";
import type {
  CompletionSyncReply,
  CompletionSyncRequest,
  CompletionUpdate,
} from "../../shared/completion-sync.js";
import {
  CompletionCache,
  structuralCompletionChange,
  type CompletionChange,
} from "./completion-cache.js";

const basic = (file: string) => /\.(bp|bpi|bpm)$/i.test(file);
interface BoundModel {
  model: editor.ITextModel;
  version: number;
  history: CompletionChange[];
  subscription: IDisposable;
}

/** Completion has its own revision stream and bounded, non-starving scheduler. */
export class CompletionSession {
  private workspace: WorkspaceSummary | undefined;
  private session = crypto.randomUUID();
  private revision = 0;
  private generation = 0;
  private base: number | null = null;
  private refresh = true;
  private updates: CompletionUpdate[] = [];
  private models = new Map<string, BoundModel>();
  private readonly cache = new CompletionCache();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstQueued: number | undefined;
  private running = false;
  private due = false;
  private failures = 0;
  constructor(
    private readonly sync: (
      workspaceId: string,
      request: CompletionSyncRequest,
    ) => Promise<CompletionSyncReply>,
  ) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  configure(workspace: WorkspaceSummary | undefined): void {
    const previous = this.workspace;
    this.workspace = workspace;
    if (workspace?.id !== previous?.id) {
      clearTimeout(this.timer);
      this.firstQueued = undefined;
      this.due = false;
      for (const state of this.models.values()) state.subscription.dispose();
      this.models.clear();
      this.cache.clear();
      this.updates = [];
      this.session = crypto.randomUUID();
      this.revision = 0;
      this.base = null;
      this.refresh = true;
      this.failures = 0;
    } else if (workspace) {
      const filesChanged = previous?.files !== workspace.files;
      const draftFiles = new Set([
        ...Object.keys(previous?.drafts ?? {}),
        ...Object.keys(workspace.drafts),
      ]);
      let changed = filesChanged;
      for (const file of draftFiles) {
        if (
          !basic(file) ||
          this.models.has(file) ||
          previous?.drafts[file] === workspace.drafts[file]
        )
          continue;
        changed = true;
        const text = workspace.drafts[file];
        this.updates.push(
          text === undefined
            ? { kind: "remove", file }
            : { kind: "reset", file, document: { version: 0, text: text.replace(/^\uFEFF/, "") } },
        );
      }
      if (!changed) return;
      this.cache.clear();
      this.generation++;
      this.refresh = true;
    }
    if (workspace) this.schedule();
  }
  bind(file: string, model: editor.ITextModel): void {
    if (!basic(file) || this.models.get(file)?.model === model) return;
    this.unbind(file);
    const state: BoundModel = {
      model,
      version: model.getVersionId(),
      history: [],
      subscription: model.onDidChangeContent((event) => {
        const change: CompletionChange = {
          before: state.version,
          version: event.versionId,
          changes: event.changes,
          flush: event.isFlush || event.isEolChange,
          structural: structuralCompletionChange(model, event),
        };
        state.version = event.versionId;
        state.history.push(change);
        if (state.history.length > 512) state.history.shift();
        this.cache.changed(file, change);
        if (change.flush) this.resetDocument(file, model);
        else
          this.updates.push({
            kind: "edit",
            file,
            before: change.before,
            version: change.version,
            changes: event.changes.map((c) => ({
              offset: c.rangeOffset,
              length: c.rangeLength,
              text: c.text,
            })),
          });
        this.failures = 0;
        this.schedule();
      }),
    };
    this.models.set(file, state);
    this.resetDocument(file, model);
    this.schedule();
  }
  unbind(file: string, model?: editor.ITextModel): void {
    const state = this.models.get(file);
    if (!state || (model && model !== state.model)) return;
    state.subscription.dispose();
    this.models.delete(file);
    this.cache.clear();
    const draft = this.workspace?.drafts[file];
    this.updates.push(
      draft === undefined
        ? { kind: "remove", file }
        : { kind: "reset", file, document: { version: 0, text: draft.replace(/^\uFEFF/, "") } },
    );
    this.refresh = true;
    this.schedule();
  }
  symbols(file: string, position: Position): BasicPlusSymbol[] | undefined {
    return this.cache.symbols(file, position);
  }
  enrich(symbols: Record<string, BasicPlusSymbol>): void {
    this.cache.enrich(symbols);
  }
  request(): void {
    if (!this.running && (this.base === null || this.updates.length || this.refresh)) {
      clearTimeout(this.timer);
      this.due = true;
      void this.run();
    }
  }
  private resetDocument(file: string, model: editor.ITextModel): void {
    this.updates = this.updates.filter((u) => u.file !== file);
    this.updates.push({
      kind: "reset",
      file,
      document: { version: model.getVersionId(), text: model.getValue() },
    });
  }
  private schedule(): void {
    if (!this.workspace) return;
    this.firstQueued ??= Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.due = true;
        void this.run();
      },
      Math.max(0, Math.min(50, this.firstQueued + 150 - Date.now())),
    );
  }
  private async run(): Promise<void> {
    if (this.running || !this.due || !this.workspace) return;
    this.due = false;
    this.firstQueued = undefined;
    clearTimeout(this.timer);
    const session = this.session;
    const generation = this.generation;
    const requestedModels = new Map(this.models);
    let updates = this.updates;
    this.updates = [];
    if (this.base === null) {
      updates = Object.entries(this.workspace.drafts)
        .filter(([file]) => basic(file) && !this.models.has(file))
        .map(([file, text]) => ({
          kind: "reset",
          file,
          document: { version: 0, text: text.replace(/^\uFEFF/, "") },
        }));
      for (const [file, { model }] of this.models)
        updates.push({
          kind: "reset",
          file,
          document: { version: model.getVersionId(), text: model.getValue() },
        });
    }
    const request: CompletionSyncRequest = {
      session,
      revision: ++this.revision,
      baseRevision: this.base,
      refresh: this.refresh,
      updates,
    };
    this.refresh = false;
    this.running = true;
    try {
      const result = await this.sync(this.workspace.id, request);
      if (session !== this.session) return;
      if (result.kind === "resync") throw new Error("Completion documents need resynchronization.");
      if (result.session !== session || result.revision !== request.revision)
        throw new Error("Completion version mismatch.");
      this.base = request.revision;
      this.failures = 0;
      if (generation !== this.generation) return;
      this.cache.update(result.index);
      for (const [file, state] of this.models) {
        const version = result.versions[file];
        const history = state.history.filter((h) => h.version > (version ?? -1));
        const matches =
          version === state.version ||
          (history.length > 0 &&
            history[0]!.before === version &&
            history.at(-1)!.version === state.version);
        // Missing model versions must not adopt ranges from a different incarnation.
        if (matches && requestedModels.get(file) === state)
          this.cache.attach(file, state.model, history);
        else this.cache.invalidate(file);
        state.history = history;
      }
      for (const listener of this.listeners) listener();
    } catch {
      if (session === this.session) {
        this.base = null;
        this.refresh = true;
        // One automatic recovery; subsequent edits/manual requests can retry again.
        if (++this.failures <= 1) this.due = true;
      }
    } finally {
      this.running = false;
      if (this.due) void this.run();
    }
  }
  dispose(): void {
    this.configure(undefined);
    this.listeners.clear();
  }
}
