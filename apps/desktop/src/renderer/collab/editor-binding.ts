import * as Y from "yjs";
import * as monaco from "monaco-editor";
import { canEdit, localPresence, sharedTypes, type CollabSession } from "./types.js";
import { RemoteCursors } from "./remote-cursors.js";
import { textOffsetAt, textPositionAt } from "./text-positions.js";
import { canShareFile } from "./file-sync.js";

// Monaco 0.52 routes both menu and keyboard undo through the model. These
// runtime methods are not included in ITextModel's declaration.
interface UndoableModel extends monaco.editor.ITextModel {
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

/**
 * Two-way binding between a Monaco model and a shared `Y.Text`.
 *
 * - Remote changes are applied with `pushEditOperations` (each in its own undo
 *   element) so the model's undo stack stays consistent with its content. They
 *   are not hidden from other model listeners: the editor's content listener
 *   still runs and updates the document's text and dirty state.
 * - Local changes are written to the `Y.Text` in one transaction per model
 *   event, unless the session role cannot edit; in that case the model is reset
 *   to the shared content instead of diverging.
 * - On creation the shared content wins: when it differs, the model is replaced
 *   once with a single edit.
 */
export class ModelBinding {
  #applyingRemote = false;
  #disposed = false;
  #resyncQueued = false;
  #content: string;
  readonly #undo: Y.UndoManager;
  readonly #nativeUndo: UndoableModel["undo"];
  readonly #nativeRedo: UndoableModel["redo"];
  readonly #subscriptions: monaco.IDisposable[];
  readonly #cursors: RemoteCursors;
  readonly #onText = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === this) {
      this.#content = this.text.toString();
      this.#cursors.render();
      return;
    }
    this.#applyRemote(event.delta);
    this.#cursors.render();
  };

  constructor(
    readonly session: CollabSession,
    readonly file: string,
    readonly text: Y.Text,
    readonly model: monaco.editor.ITextModel,
    private readonly onLimit?: (file: string) => void,
  ) {
    this.#content = text.toString();
    this.#undo = new Y.UndoManager(text, { trackedOrigins: new Set([this]) });
    const undoable = model as UndoableModel;
    this.#nativeUndo = undoable.undo;
    this.#nativeRedo = undoable.redo;
    // Monaco keyboard, menu and command actions all call these model methods.
    // Track only this binding's local transactions so undo preserves peer edits.
    undoable.undo = () => {
      this.#applyHistory("undo");
    };
    undoable.redo = () => {
      this.#applyHistory("redo");
    };
    this.#syncFromText();
    text.observe(this.#onText);
    this.#subscriptions = [
      model.onDidChangeContent((event) => this.#applyLocal(event)),
      model.onWillDispose(() => this.dispose()),
    ];
    this.#cursors = new RemoteCursors(session, file, text, model);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.text.unobserve(this.#onText);
    this.#undo.destroy();
    (this.model as UndoableModel).undo = this.#nativeUndo;
    (this.model as UndoableModel).redo = this.#nativeRedo;
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#cursors.dispose();
  }

  #edit(edits: monaco.editor.IIdentifiedSingleEditOperation[]): void {
    if (edits.length === 0) return;
    this.#applyingRemote = true;
    try {
      this.model.pushStackElement();
      this.model.pushEditOperations(null, edits, () => null);
      this.model.pushStackElement();
    } finally {
      this.#applyingRemote = false;
    }
  }

  /** Replaces the model content with the shared text in one edit, if they differ. */
  #syncFromText(): void {
    this.#content = this.text.toString();
    const content = this.#content
      .replace(/^\uFEFF/, "")
      .replace(/\r\n|\r|\n/g, this.model.getEOL());
    if (this.model.getValue() === content) return;
    this.#edit([{ range: this.model.getFullModelRange(), text: content }]);
  }

  #applyRemote(delta: Y.YTextEvent["delta"]): void {
    if (this.#disposed || this.model.isDisposed()) return;
    // Delta offsets refer to the text before the change; Monaco applies a batch of
    // edits against the current model, so ranges are computed before editing.
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    let index = 0;
    let pending: { start: number; end: number; text: string } | undefined;
    const flush = () => {
      if (!pending) return;
      edits.push({
        range: monaco.Range.fromPositions(
          textPositionAt(this.#content, pending.start),
          textPositionAt(this.#content, pending.end),
        ),
        text: pending.text,
      });
      pending = undefined;
    };
    for (const op of delta) {
      if (op.retain !== undefined) {
        flush();
        index += op.retain;
      } else if (op.insert !== undefined) {
        const inserted = typeof op.insert === "string" ? op.insert : "";
        if (pending?.end === index) pending.text += inserted;
        else {
          flush();
          pending = { start: index, end: index, text: inserted };
        }
      } else if (op.delete !== undefined) {
        if (pending?.end === index) pending.end += op.delete;
        else {
          flush();
          pending = { start: index, end: index + op.delete, text: "" };
        }
        index += op.delete;
      }
    }
    flush();
    this.#edit(edits);
    this.#content = this.text.toString();
    if (
      this.model.getValue() !==
      this.#content.replace(/^\uFEFF/, "").replace(/\r\n|\r|\n/g, this.model.getEOL())
    )
      this.#syncFromText();
  }

  #applyLocal(event: monaco.editor.IModelContentChangedEvent): void {
    if (this.#applyingRemote || this.#disposed || this.#resyncQueued) return;
    if (!canEdit(this.session.getSnapshot().role)) {
      // The server drops viewer updates; restore the shared content instead.
      this.#queueResync();
      return;
    }
    const changes = [...event.changes]
      .sort((a, b) => b.rangeOffset - a.rangeOffset)
      .map((change) => {
        const start = textOffsetAt(this.#content, {
          lineNumber: change.range.startLineNumber,
          column: change.range.startColumn,
        });
        const end = textOffsetAt(this.#content, {
          lineNumber: change.range.endLineNumber,
          column: change.range.endColumn,
        });
        return { start, end, text: change.text };
      });
    // Count the proposed shared content, retaining its BOM and mixed line endings.
    // Monaco normalizes those, so getValue() alone can undercount the wire bytes.
    let content = this.#content;
    for (const change of changes)
      content = content.slice(0, change.start) + change.text + content.slice(change.end);
    if (!canShareFile(sharedTypes(this.session.doc).files, this.file, content)) {
      this.#queueResync();
      this.onLimit?.(this.file);
      return;
    }
    this.text.doc?.transact(() => {
      for (const change of changes) {
        if (change.end > change.start) this.text.delete(change.start, change.end - change.start);
        if (change.text) this.text.insert(change.start, change.text);
      }
    }, this);
    if (
      this.model.getValue() !==
      this.#content.replace(/^\uFEFF/, "").replace(/\r\n|\r|\n/g, this.model.getEOL())
    )
      this.#queueResync();
  }

  #applyHistory(kind: "undo" | "redo"): void {
    if (this.#disposed || this.#resyncQueued || !canEdit(this.session.getSnapshot().role)) return;
    if (!(kind === "undo" ? this.#undo.canUndo() : this.#undo.canRedo())) return;
    // Peer edits may consume the room budget after a local deletion. Preview the
    // same CRDT history operation before it can emit an oversized live update.
    const preview = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(preview, Y.encodeStateAsUpdate(this.session.doc));
      // Redo links are local history metadata and are not encoded in updates.
      // Restore them, including item boundaries, for repeated undo/redo previews.
      preview.transact((transaction) => {
        for (const structs of this.session.doc.store.clients.values())
          for (const item of structs) {
            if (!(item instanceof Y.Item) || !item.redone) continue;
            Y.getItemCleanEnd(
              transaction,
              preview.store,
              Y.createID(item.id.client, item.id.clock + item.length - 1),
            );
            Y.getItemCleanStart(transaction, item.id).redone = item.redone;
          }
      });
      const text = sharedTypes(preview).files.get(this.file)!;
      const history = new Y.UndoManager(text);
      history.undoStack = [...this.#undo.undoStack];
      history.redoStack = [...this.#undo.redoStack];
      history[kind]();
      if (!canShareFile(sharedTypes(this.session.doc).files, this.file, text.toString())) {
        this.onLimit?.(this.file);
        return;
      }
    } finally {
      preview.destroy();
    }
    this.#undo[kind]();
  }

  #queueResync(): void {
    if (this.#resyncQueued) return;
    this.#resyncQueued = true;
    queueMicrotask(() => {
      this.#resyncQueued = false;
      if (!this.#disposed && !this.model.isDisposed()) this.#syncFromText();
    });
  }
}

/** Binds `model` to the shared text of `file`, or returns undefined when the file is not shared. */
export function bindModel(
  session: CollabSession,
  file: string,
  model: monaco.editor.ITextModel,
  onLimit?: (file: string) => void,
): ModelBinding | undefined {
  const text = sharedTypes(session.doc).files.get(file);
  return text instanceof Y.Text ? new ModelBinding(session, file, text, model, onLimit) : undefined;
}

export interface EditorCollabSource {
  /** Models the editor shows or keeps open, keyed by workspace-relative path. */
  models(): Iterable<readonly [string, monaco.editor.ITextModel]>;
  /** Workspace-relative path of the active file. */
  activeFile(): string | undefined;
  /** An edit or history operation exceeded the shared file or room capacity. */
  onLimit?(file: string): void;
}

const PRESENCE_THROTTLE_MS = 50;

/**
 * Connects an editor to a collaboration session: binds every given model whose
 * file is shared, publishes the local file and selection in awareness, and
 * re-evaluates bindings when the shared file map changes. Call `refresh` after
 * switching files or changing the set of open models.
 */
export class EditorCollab {
  readonly #bindings = new Map<monaco.editor.ITextModel, ModelBinding>();
  readonly #subscriptions: monaco.IDisposable[];
  #presenceTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  readonly #onFiles = () => this.refresh();

  constructor(
    private readonly editor: Pick<
      monaco.editor.ICodeEditor,
      "getModel" | "getSelection" | "onDidChangeCursorSelection" | "onDidChangeModel"
    >,
    private readonly session: CollabSession,
    private readonly source: EditorCollabSource,
  ) {
    sharedTypes(session.doc).files.observe(this.#onFiles);
    this.#subscriptions = [
      editor.onDidChangeCursorSelection(() => this.#schedulePresence()),
      editor.onDidChangeModel(() => this.#publishPresence()),
    ];
    this.refresh();
  }

  /** The binding for `model`, if it is bound. */
  binding(model: monaco.editor.ITextModel): ModelBinding | undefined {
    return this.#bindings.get(model);
  }

  refresh(): void {
    if (this.#disposed) return;
    const files = sharedTypes(this.session.doc).files;
    const wanted = new Map<monaco.editor.ITextModel, string>();
    for (const [file, model] of this.source.models())
      if (!model.isDisposed() && files.get(file) instanceof Y.Text) wanted.set(model, file);
    for (const [model, binding] of this.#bindings) {
      const file = wanted.get(model);
      if (binding.disposed || file !== binding.file || files.get(file) !== binding.text) {
        binding.dispose();
        this.#bindings.delete(model);
      }
    }
    for (const [model, file] of wanted) {
      if (this.#bindings.has(model)) continue;
      const binding = bindModel(this.session, file, model, this.source.onLimit);
      if (binding) this.#bindings.set(model, binding);
    }
    this.#publishPresence();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#presenceTimer);
    sharedTypes(this.session.doc).files.unobserve(this.#onFiles);
    for (const subscription of this.#subscriptions) subscription.dispose();
    for (const binding of this.#bindings.values()) binding.dispose();
    this.#bindings.clear();
    this.#setPresence(undefined, undefined);
  }

  #schedulePresence(): void {
    if (this.#presenceTimer !== undefined || this.#disposed) return;
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = undefined;
      this.#publishPresence();
    }, PRESENCE_THROTTLE_MS);
  }

  #publishPresence(): void {
    if (this.#disposed) return;
    const model = this.editor.getModel();
    const binding = model ? this.#bindings.get(model) : undefined;
    const file = this.source.activeFile();
    if (!model || !binding || binding.disposed || binding.file !== file) {
      this.#setPresence(undefined, undefined);
      return;
    }
    const selection = this.editor.getSelection();
    if (!selection) {
      this.#setPresence(binding.file, undefined);
      return;
    }
    const position = (lineNumber: number, column: number) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(
          binding.text,
          textOffsetAt(binding.text.toString(), { lineNumber, column }),
        ),
      );
    this.#setPresence(binding.file, {
      anchor: position(selection.selectionStartLineNumber, selection.selectionStartColumn),
      head: position(selection.positionLineNumber, selection.positionColumn),
    });
  }

  #setPresence(
    file: string | undefined,
    selection: { anchor: unknown; head: unknown } | undefined,
  ) {
    const current = localPresence(this.session);
    if (!current) return;
    if (current.file === file && current.selection === undefined && selection === undefined) return;
    const next = { ...current };
    if (file === undefined) delete next.file;
    else next.file = file;
    if (selection === undefined) delete next.selection;
    else next.selection = selection;
    this.session.awareness.setLocalState(next);
  }
}
