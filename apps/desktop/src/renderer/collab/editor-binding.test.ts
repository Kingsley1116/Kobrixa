import { afterEach, describe, expect, it, vi } from "vitest";

// The model APIs need only a few browser globals; `editor.api.js` avoids loading
// the workbench contributions that `monaco-editor` (editor.main) pulls in.
vi.hoisted(() => {
  const scope = globalThis as Record<string, unknown>;
  if (scope.window) return;
  const element = () => ({
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    sheet: { insertRule() {}, cssRules: [] },
    setAttribute() {},
    appendChild() {},
    append() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
  });
  scope.window = globalThis;
  scope.location = { href: "file:///", origin: "file://", protocol: "file:" };
  scope.document = {
    createElement: element,
    head: element(),
    body: element(),
    documentElement: element(),
    addEventListener() {},
    removeEventListener() {},
    queryCommandSupported: () => false,
  };
  scope.addEventListener = () => {};
  scope.removeEventListener = () => {};
  scope.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.mock("monaco-editor", () => import("monaco-editor/esm/vs/editor/editor.api.js"));

import * as monaco from "monaco-editor";
import * as Y from "yjs";
import type { Role } from "@kobrixa/collab-protocol";
import { createLinkedSessions } from "./testing.js";
import { sharedTypes, localPresence, type CollabSession } from "./types.js";
import { bindModel, EditorCollab, type ModelBinding } from "./editor-binding.js";
import { REMOTE_CARET_CLASS, REMOTE_SELECTION_CLASS } from "./remote-cursors.js";
import { Documents, type DocumentBuffer } from "../editor/documents.js";

const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const item of disposables.splice(0).reverse()) item.dispose();
  vi.useRealTimers();
});

function pair(roles: [Role, Role]): [CollabSession, CollabSession] {
  const [first, second] = createLinkedSessions(roles).sessions;
  disposables.push({ dispose: () => first!.destroy() }, { dispose: () => second!.destroy() });
  return [first!, second!];
}

function model(text: string): monaco.editor.ITextModel {
  const created = monaco.editor.createModel(text, "plaintext");
  disposables.push(created);
  return created;
}

function bind(
  session: CollabSession,
  file: string,
  target: monaco.editor.ITextModel,
): ModelBinding {
  const binding = bindModel(session, file, target);
  if (!binding) throw new Error("not shared");
  disposables.push(binding);
  return binding;
}

function share(session: CollabSession, file: string, content: string): void {
  sharedTypes(session.doc).files.set(file, new Y.Text(content));
}

function type(target: monaco.editor.ITextModel, offset: number, text: string, length = 0): void {
  const start = target.getPositionAt(offset);
  const end = target.getPositionAt(offset + length);
  target.pushEditOperations(
    null,
    [{ range: monaco.Range.fromPositions(start, end), text }],
    () => null,
  );
}

function remoteDecorations(target: monaco.editor.ITextModel) {
  return target
    .getAllDecorations()
    .filter(
      (item) =>
        item.options.className?.includes(REMOTE_SELECTION_CLASS) ||
        item.options.beforeContentClassName?.includes(REMOTE_CARET_CLASS),
    );
}

describe("ModelBinding", () => {
  it("round-trips edits between two editors", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "print 1\n");
    const a = model("print 1\n");
    const b = model("stale");
    bind(host, "main.bp", a);
    bind(guest, "main.bp", b);
    expect(b.getValue()).toBe("print 1\n");

    type(a, 7, "\nprint 2");
    expect(b.getValue()).toBe("print 1\nprint 2\n");
    type(b, 0, "' header\n");
    expect(a.getValue()).toBe("' header\nprint 1\nprint 2\n");
    type(a, 0, "", 9);
    expect(b.getValue()).toBe("print 1\nprint 2\n");
    expect(sharedTypes(guest.doc).files.get("main.bp")?.toString()).toBe(b.getValue());
  });

  it("replaces initial content in a single undoable edit and does not bind unshared files", () => {
    const [host] = pair(["host", "editor"]);
    share(host, "main.bp", "shared");
    const target = model("local");
    const changes = vi.fn();
    disposables.push(target.onDidChangeContent(changes));
    bind(host, "main.bp", target);
    expect(target.getValue()).toBe("shared");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(bindModel(host, "other.bp", model("x"))).toBeUndefined();
  });

  it("converges under concurrent edits", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "abc");
    const a = model("");
    const b = model("");
    bind(host, "main.bp", a);
    bind(guest, "main.bp", b);
    // Concurrent: both edit while disconnected from each other, then merge.
    const hostText = sharedTypes(host.doc).files.get("main.bp")!;
    const guestText = sharedTypes(guest.doc).files.get("main.bp")!;
    const hostState = Y.encodeStateVector(host.doc);
    const guestState = Y.encodeStateVector(guest.doc);
    const otherDoc = new Y.Doc();
    Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(host.doc));
    expect(hostText.toString()).toBe(guestText.toString());
    // Simulate concurrency with a third offline doc edited at the same spot.
    otherDoc.getMap<Y.Text>("files").get("main.bp")!.insert(1, "X");
    type(a, 1, "Y");
    Y.applyUpdate(host.doc, Y.encodeStateAsUpdate(otherDoc, hostState));
    Y.applyUpdate(guest.doc, Y.encodeStateAsUpdate(otherDoc, guestState));
    expect(a.getValue()).toBe(b.getValue());
    expect(a.getValue()).toBe(hostText.toString());
    expect(a.getValue()).toHaveLength(5);
    otherDoc.destroy();
  });

  it("undoes only local edits after a peer edits before them", async () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "abc");
    const a = model("abc");
    const b = model("abc");
    bind(host, "main.bp", a);
    bind(guest, "main.bp", b);
    type(a, 1, "local");
    type(b, 0, "peer");
    await (a as monaco.editor.ITextModel & { undo(): void }).undo();
    expect(a.getValue()).toBe("peerabc");
    expect(b.getValue()).toBe("peerabc");
    await (a as monaco.editor.ITextModel & { redo(): void }).redo();
    expect(a.getValue()).toBe("peeralocalbc");
    expect(b.getValue()).toBe("peeralocalbc");
  });

  it("maps mixed line endings without shifting subsequent edits", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "first\r\nsecond\nthird");
    const a = model("first\r\nsecond\r\nthird");
    const b = model("first\nsecond\nthird");
    bind(host, "main.bp", a);
    bind(guest, "main.bp", b);
    type(b, b.getOffsetAt({ lineNumber: 3, column: 1 }), "last ");
    expect(a.getLineContent(3)).toBe("last third");
    type(a, a.getOffsetAt({ lineNumber: 2, column: 7 }), "!");
    expect(b.getLineContent(2)).toBe("second!");
    expect(sharedTypes(host.doc).files.get("main.bp")!.toString()).toBe(
      "first\r\nsecond!\nlast third",
    );
  });

  it("keeps a file's byte order mark outside editor offsets", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "\uFEFFabc\r\ndef");
    const a = model("\uFEFFabc\r\ndef");
    const b = model("\uFEFFabc\ndef");
    bind(host, "main.bp", a);
    bind(guest, "main.bp", b);
    type(a, 0, "x");
    type(b, b.getOffsetAt({ lineNumber: 2, column: 1 }), "y");
    expect(sharedTypes(host.doc).files.get("main.bp")!.toString()).toBe("\uFEFFxabc\r\nydef");
    expect(a.getValue(undefined, true)).toBe("\uFEFFxabc\r\nydef");
  });

  it("updates document text and dirty state for remote edits", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "saved");
    const documents = new Documents();
    documents.replace([{ file: "main.bp", content: "saved", saved: "saved" }]);
    const target = model("saved");
    const buffer: DocumentBuffer = {
      getValue: () => target.getValue(),
      getValueLength: () => target.getValueLength(),
      getVersionId: () => target.getVersionId(),
      getAlternativeVersionId: () => target.getAlternativeVersionId(),
      setValue: (value) => target.setValue(value),
    };
    documents.bind("main.bp", buffer);
    disposables.push(target.onDidChangeContent(() => documents.changed("main.bp")));
    bind(guest, "main.bp", target);
    const shared = sharedTypes(host.doc).files.get("main.bp")!;
    const beforeRevision = documents.version("main.bp");
    shared.insert(5, "!");
    expect(documents.version("main.bp")).toBeGreaterThan(beforeRevision);
    expect(documents.reader("main.bp")()).toBe("saved!");
    expect(documents.getSnapshot()[0]?.dirty).toBe(true);
    shared.delete(5, 1);
    expect(documents.getSnapshot()[0]?.dirty).toBe(false);
  });

  it("keeps a viewer's model in sync without pushing its edits", async () => {
    const [host, viewer] = pair(["host", "viewer"]);
    share(host, "main.bp", "print 1");
    const a = model("");
    const b = model("");
    bind(host, "main.bp", a);
    bind(viewer, "main.bp", b);
    type(b, 0, "x");
    expect(a.getValue()).toBe("print 1");
    expect(sharedTypes(viewer.doc).files.get("main.bp")?.toString()).toBe("print 1");
    await Promise.resolve();
    expect(b.getValue()).toBe("print 1");
    type(a, 7, "0");
    expect(b.getValue()).toBe("print 10");
  });

  it("stops syncing when disposed or when the model is disposed", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "a");
    const a = model("");
    const b = monaco.editor.createModel("", "plaintext");
    const binding = bind(host, "main.bp", a);
    const other = bind(guest, "main.bp", b);
    b.dispose();
    expect(other.disposed).toBe(true);
    binding.dispose();
    type(a, 1, "b");
    expect(sharedTypes(guest.doc).files.get("main.bp")?.toString()).toBe("a");
  });
});

describe("remote cursors", () => {
  it("renders other participants' selections in the same file and cleans up", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "print 1\nprint 2\n");
    const a = model("");
    const b = model("");
    bind(host, "main.bp", a);
    const binding = bind(guest, "main.bp", b);
    const text = sharedTypes(host.doc).files.get("main.bp")!;
    const at = (index: number) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
    host.awareness.setLocalState({
      ...localPresence(host)!,
      file: "main.bp",
      selection: { anchor: at(0), head: at(5) },
    });
    const decorations = remoteDecorations(b);
    expect(decorations).toHaveLength(2);
    const selection = decorations.find((item) => item.options.className);
    expect(selection?.range).toMatchObject({ startColumn: 1, endColumn: 6, startLineNumber: 1 });
    expect(selection?.options.hoverMessage).toMatchObject({ value: "User 1" });
    expect(remoteDecorations(a)).toHaveLength(0);

    // Caret follows edits that happen before it.
    text.insert(0, "' x\n");
    const caret = remoteDecorations(b).find((item) => item.options.beforeContentClassName);
    expect(caret?.range).toMatchObject({ startLineNumber: 2, startColumn: 6 });

    host.awareness.setLocalState({ ...localPresence(host)!, file: "other.bp" });
    expect(remoteDecorations(b)).toHaveLength(0);
    host.awareness.setLocalState({
      ...localPresence(host)!,
      file: "main.bp",
      selection: { anchor: at(1), head: at(1) },
    });
    expect(remoteDecorations(b)).toHaveLength(1);
    binding.dispose();
    expect(remoteDecorations(b)).toHaveLength(0);
  });

  it("ignores malformed presence states", () => {
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "abc");
    bind(host, "main.bp", model(""));
    const b = model("");
    bind(guest, "main.bp", b);
    host.awareness.setLocalState({
      ...localPresence(host)!,
      color: "red;}body{display:none",
      file: "main.bp",
      selection: { anchor: null, head: null },
    });
    expect(remoteDecorations(b)).toHaveLength(0);
  });
});

class FakeEditor {
  model: monaco.editor.ITextModel | null = null;
  selection: monaco.Selection | null = null;
  readonly #selection = new Set<() => void>();
  readonly #model = new Set<() => void>();
  getModel = () => this.model;
  getSelection = () => this.selection;
  onDidChangeCursorSelection = (listener: () => void) => this.#listen(this.#selection, listener);
  onDidChangeModel = (listener: () => void) => this.#listen(this.#model, listener);
  setModel(model: monaco.editor.ITextModel): void {
    this.model = model;
    this.selection = new monaco.Selection(1, 1, 1, 1);
    for (const listener of this.#model) listener();
  }
  select(selection: monaco.Selection): void {
    this.selection = selection;
    for (const listener of this.#selection) listener();
  }
  #listen(set: Set<() => void>, listener: () => void): monaco.IDisposable {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  }
}

describe("EditorCollab", () => {
  it("binds shared open files, publishes throttled presence and clears it on dispose", () => {
    vi.useFakeTimers();
    const [host, guest] = pair(["host", "editor"]);
    share(host, "main.bp", "print 1\nprint 2");
    const main = model("print 1\nprint 2");
    const local = model("local only");
    const models = new Map([
      ["main.bp", main],
      ["local.bp", local],
    ]);
    let active = "main.bp";
    const editor = new FakeEditor();
    editor.setModel(main);
    const collab = new EditorCollab(editor as never, guest, {
      models: () => models,
      activeFile: () => active,
    });
    disposables.push(collab);
    expect(collab.binding(main)).toBeDefined();
    expect(collab.binding(local)).toBeUndefined();
    expect(localPresence(guest)).toMatchObject({ file: "main.bp" });

    editor.select(new monaco.Selection(2, 1, 2, 6));
    editor.select(new monaco.Selection(2, 1, 2, 7));
    const remote = () =>
      host.awareness.getStates().get(guest.awareness.clientID) as { selection?: unknown };
    vi.advanceTimersByTime(60);
    const selection = remote().selection as { anchor: unknown; head: unknown };
    const index = (json: unknown) =>
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), host.doc)
        ?.index;
    expect(index(selection.anchor)).toBe(8);
    expect(index(selection.head)).toBe(14);

    // Switching to an unshared file clears the published file.
    active = "local.bp";
    editor.setModel(local);
    collab.refresh();
    expect(localPresence(guest)?.file).toBeUndefined();

    // Files shared later are bound on refresh via the shared map observer.
    share(host, "local.bp", "from room");
    expect(collab.binding(local)).toBeDefined();
    expect(local.getValue()).toBe("from room");
    expect(localPresence(guest)).toMatchObject({ file: "local.bp" });

    // Removing a file from the room unbinds it.
    sharedTypes(host.doc).files.delete("local.bp");
    expect(collab.binding(local)).toBeUndefined();

    collab.dispose();
    expect(collab.binding(main)).toBeUndefined();
    expect(localPresence(guest)?.file).toBeUndefined();
    expect(localPresence(guest)?.selection).toBeUndefined();
  });
});
