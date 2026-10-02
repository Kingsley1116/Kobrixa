// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Diagnostic } from "../../shared/api.js";

const mocks = vi.hoisted(() => {
  let contentListener: () => void = () => undefined;
  const model = {
    getValue: vi.fn(() => "LCD.Clear()"),
    setValue: vi.fn(() => contentListener()),
    getLanguageId: vi.fn(() => "basic-plus"),
    getVersionId: vi.fn(() => 1),
    getAlternativeVersionId: vi.fn(() => 1),
    getValueLength: vi.fn(() => model.getValue().length),
    onDidChangeContent: vi.fn(() => ({ dispose: vi.fn() })),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };
  const instance = {
    focus: vi.fn(),
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      contentListener = listener;
      return { dispose: vi.fn() };
    }),
    getValue: model.getValue,
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
    saveViewState: vi.fn(),
    setModel: vi.fn(),
    getPosition: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };
  return { model, instance, setModelMarkers: vi.fn(), create: vi.fn(() => instance) };
});

vi.mock("monaco-editor", () => ({
  Uri: { from: vi.fn((value) => value) },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  languages: {
    register: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    registerDocumentSemanticTokensProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerSignatureHelpProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerReferenceProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerRenameProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerDocumentFormattingEditProvider: vi.fn(),
    registerDocumentRangeFormattingEditProvider: vi.fn(),
  },
  editor: {
    create: mocks.create,
    registerEditorOpener: vi.fn(() => ({ dispose: vi.fn() })),
    createModel: vi.fn(() => mocks.model),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelMarkers: mocks.setModelMarkers,
  },
}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: class {} }));

import { Editor } from "./editor.js";
import { Documents } from "./documents.js";
import { AnalysisSession } from "./analysis-session.js";

let root: Root;
let container: HTMLDivElement;
const diagnostics: Diagnostic[] = [
  {
    code: "BP3001",
    severity: "error",
    file: "main.bp",
    message: "Unknown operation",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
  },
];
const props = {
  theme: "light" as const,
  fontSize: 16,
  wordWrap: false,
  indentSize: 2 as const,
  reducedMotion: false,
  readOnly: false,
  file: "main.bp",
  documents: new Documents(),
  analysisSession: new AnalysisSession(new Documents(), {
    analyze: vi.fn(),
    cancel: vi.fn(),
    diagnostics: vi.fn(),
    checking: vi.fn(),
    error: vi.fn(),
  }),
  openFiles: ["main.bp"],
  diagnostics,
  focusTarget: undefined,
  ariaLabel: "Editor",
  onChange: vi.fn(),
  onCursorChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  props.documents = new Documents();
  props.documents.replace([{ file: "main.bp", content: "LCD.Clear()", saved: "LCD.Clear()" }]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("does not rewrite markers, content, or view state on Enter and Backspace rerenders", async () => {
  mocks.model.getValue.mockReturnValue("LCD.Clear()");
  await act(async () => root.render(createElement(Editor, props)));
  expect(mocks.setModelMarkers).toHaveBeenCalledTimes(1);
  mocks.setModelMarkers.mockClear();
  mocks.instance.saveViewState.mockClear();
  for (const value of ["LCD.Clear()\n", "LCD.Clear()", "LCD.Clear()\n\n"]) {
    mocks.model.getValue.mockReturnValue(value);
    // App produces a new openFiles array when tab contents change.
    await act(async () => root.render(createElement(Editor, { ...props, openFiles: ["main.bp"] })));
  }
  expect(mocks.setModelMarkers).not.toHaveBeenCalled();
  expect(mocks.model.setValue).not.toHaveBeenCalled();
  expect(mocks.instance.saveViewState).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledWith(
    container.firstChild,
    expect.objectContaining({
      cursorSmoothCaretAnimation: "off",
      smoothScrolling: false,
      autoIndent: "full",
    }),
  );

  await act(async () => root.render(createElement(Editor, { ...props, diagnostics: [] })));
  expect(mocks.setModelMarkers).toHaveBeenCalledExactlyOnceWith(mocks.model, "kobrixa", []);
});

it("applies diagnostics when a file is opened and still accepts external content changes", async () => {
  mocks.model.getValue.mockReturnValue("LCD.Clear()");
  await act(async () => root.render(createElement(Editor, props)));
  mocks.setModelMarkers.mockClear();
  props.documents.replace([
    ...props.documents.getSnapshot(),
    { file: "other.bp", content: "LCD.Update()", saved: "LCD.Update()" },
  ]);
  await act(async () =>
    root.render(
      createElement(Editor, {
        ...props,
        file: "other.bp",
        openFiles: ["main.bp", "other.bp"],
      }),
    ),
  );
  expect(mocks.setModelMarkers).toHaveBeenCalledTimes(2);
  expect(mocks.setModelMarkers).toHaveBeenLastCalledWith(mocks.model, "kobrixa", []);
  props.onChange.mockClear();
  await act(async () => {
    props.documents.replace(
      props.documents
        .getSnapshot()
        .map((tab) => (tab.file === "other.bp" ? { ...tab, content: "LCD.Clear()\n\n" } : tab)),
    );
  });
  expect(mocks.model.setValue).toHaveBeenLastCalledWith("LCD.Clear()\n\n");
  expect(props.onChange).not.toHaveBeenCalled();
});
