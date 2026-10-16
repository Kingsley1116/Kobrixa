// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import type { LanguageStatus } from "../../shared/language-services.js";
import type { Diagnostic } from "../../shared/api.js";

const mocks = vi.hoisted(() => {
  let contentListener: () => void = () => undefined;
  const model = {
    getValue: vi.fn(() => "LCD.Clear()"),
    setValue: vi.fn(() => contentListener()),
    getLanguageId: vi.fn(() => "basic-plus"),
    isDisposed: vi.fn(() => false),
    getVersionId: vi.fn(() => 1),
    getAlternativeVersionId: vi.fn(() => 1),
    getValueLength: vi.fn(() => model.getValue().length),
    getLineContent: vi.fn((line: number) => model.getValue().split("\n")[line - 1]!),
    getFullModelRange: vi.fn(() => {
      const lines = model.getValue().split("\n");
      return {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: lines.length,
        endColumn: lines.at(-1)!.length + 1,
      };
    }),
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
    getModel: vi.fn(),
    getSelection: vi.fn(),
    onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
    saveViewState: vi.fn(),
    setModel: vi.fn(),
    getPosition: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };
  const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const register = () => {
    const handle = { dispose: vi.fn() };
    registrations.push(handle);
    return handle;
  };
  return {
    model,
    instance,
    registrations,
    register,
    setModelMarkers: vi.fn(),
    create: vi.fn(() => instance),
  };
});

vi.mock("monaco-editor", () => ({
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  Uri: { from: vi.fn((value) => value) },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  languages: {
    register: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    registerDocumentSemanticTokensProvider: vi.fn(mocks.register),
    registerCompletionItemProvider: vi.fn(mocks.register),
    registerHoverProvider: vi.fn(mocks.register),
    registerSignatureHelpProvider: vi.fn(mocks.register),
    registerDefinitionProvider: vi.fn(mocks.register),
    registerDocumentSymbolProvider: vi.fn(mocks.register),
    registerReferenceProvider: vi.fn(mocks.register),
    registerRenameProvider: vi.fn(mocks.register),
    registerCodeActionProvider: vi.fn(mocks.register),
    registerDocumentFormattingEditProvider: vi.fn(mocks.register),
    registerDocumentRangeFormattingEditProvider: vi.fn(mocks.register),
  },
  editor: {
    create: mocks.create,
    registerEditorOpener: vi.fn(() => ({ dispose: vi.fn() })),
    createModel: vi.fn(() => mocks.model),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelMarkers: mocks.setModelMarkers,
    setModelLanguage: vi.fn((_model, language) =>
      mocks.model.getLanguageId.mockReturnValue(language),
    ),
  },
}));
vi.mock("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/languages/features/json/json.worker?worker", () => ({ default: class {} }));

import { Editor, type EditorHandle } from "./editor.js";
import { Documents } from "./documents.js";
import { AnalysisSession } from "./analysis-session.js";
import { basicPlusCompanion } from "./companions/basic-plus/companion.js";

let root: Root;
let container: HTMLDivElement;
const diagnostics: Diagnostic[] = [
  {
    code: "BP3001",
    source: "kobrixa.basic-plus",
    severity: "error",
    file: "main.bp",
    message: "Unknown operation",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
  },
];
const available = (epoch = 1): LanguageStatus => ({
  epoch,
  conflicts: [],
  availability: {
    kind: "available",
    binding: {
      ...{
        epoch: 1,
        pluginId: "kobrixa.basic-plus",
        sourceKey: "builtin:kobrixa.basic-plus",
        language: "bp",
        extensions: ["bp", "bpi", "bpm"],
        capabilities: ["analysis", "quickFixes"],
        frontend: {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      },
      epoch,
      capabilities: [...LANGUAGE_CAPABILITIES],
    },
  },
});
const props = {
  status: available(),
  query: vi.fn(async () => ({ kind: "stale" as const, epoch: 1 })),
  helpCatalog: undefined,
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
    unavailable: vi.fn(),
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
  mocks.registrations.length = 0;
  mocks.model.getLanguageId.mockReturnValue("basic-plus");
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
  // This fixture reuses one model for two paths; replacing its route clears its old markers first.
  expect(mocks.setModelMarkers).toHaveBeenNthCalledWith(1, mocks.model, "kobrixa", []);
  expect(mocks.setModelMarkers).toHaveBeenCalledTimes(3);
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

it("updates visual and input preferences without replacing the editor, model or view", async () => {
  const { defaultSettings } = await import("../settings/settings.js");
  const settings = defaultSettings("en");
  await act(async () => root.render(createElement(Editor, { ...props, editorOptions: settings })));
  mocks.model.setValue.mockClear();
  mocks.instance.saveViewState.mockClear();
  await act(async () =>
    root.render(
      createElement(Editor, {
        ...props,
        editorOptions: {
          ...settings,
          cursorStyle: "block",
          autoSuggestions: false,
          lineHeight: "relaxed",
        },
      }),
    ),
  );
  expect(mocks.instance.updateOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      cursorStyle: "block",
      lineHeight: 29,
      suggestOnTriggerCharacters: false,
    }),
  );
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.model.setValue).not.toHaveBeenCalled();
  expect(mocks.instance.saveViewState).not.toHaveBeenCalled();
});

it("refreshes source labels and source-scoped messages when the catalog changes", async () => {
  const items = [diagnostics[0]!, { ...diagnostics[0]!, source: "acme.x" }];
  await act(async () => root.render(createElement(Editor, { ...props, diagnostics: items })));
  expect(mocks.setModelMarkers.mock.lastCall?.[2]).toEqual([
    expect.objectContaining({ source: "kobrixa.basic-plus" }),
    expect.objectContaining({ source: "acme.x", message: "BP3001: Unknown operation" }),
  ]);
  mocks.setModelMarkers.mockClear();
  await act(async () =>
    root.render(
      createElement(Editor, {
        ...props,
        diagnostics: items,
        helpCatalog: {
          revision: 1,
          plugins: {
            "kobrixa.basic-plus": { displayName: { en: "Basic Plus" }, entries: [] },
            "acme.x": {
              displayName: { en: "Acme" },
              entries: [
                {
                  code: "BP3001",
                  title: { en: "Acme title" },
                  cause: { en: "Acme cause" },
                  steps: { en: ["Acme step"] },
                },
              ],
            },
          },
        },
      }),
    ),
  );
  expect(mocks.setModelMarkers).toHaveBeenCalledOnce();
  expect(mocks.setModelMarkers.mock.lastCall?.[2]).toEqual([
    expect.objectContaining({ source: "Basic Plus" }),
    expect.objectContaining({
      source: "Acme (acme.x)",
      message: "BP3001: Acme title\nAcme cause\nAcme step\n\nUnknown operation",
    }),
  ]);
});

it("detaches dynamic services on unavailability, restores them without edits, and leaves JSON unbound", async () => {
  const ref = createRef<EditorHandle>();
  await act(() => root.render(createElement(Editor, { ...props, ref })));
  expect(mocks.registrations).toHaveLength(11);
  const previous = [...mocks.registrations];
  const writes = mocks.model.setValue.mock.calls.length;
  await act(() =>
    root.render(
      createElement(Editor, {
        ...props,
        ref,
        diagnostics: [],
        status: {
          epoch: 2,
          conflicts: [],
          availability: { kind: "unavailable", reason: "missing", language: "bp" },
        },
      }),
    ),
  );
  expect(mocks.setModelMarkers).toHaveBeenLastCalledWith(mocks.model, "kobrixa", []);
  expect(mocks.model.setValue).toHaveBeenCalledTimes(writes);
  for (const handle of previous) expect(handle.dispose).toHaveBeenCalledOnce();
  expect(mocks.model.dispose).not.toHaveBeenCalled();
  await act(() => root.render(createElement(Editor, { ...props, ref, status: available(3) })));
  expect(mocks.registrations).toHaveLength(22);
  expect(mocks.model.setValue).toHaveBeenCalledTimes(writes);
  await act(() => {
    ref.current!.remapFiles({ "main.bp": "kobrixa.json" });
    props.documents.replace(
      props.documents.getSnapshot().map((tab) => ({ ...tab, file: "kobrixa.json" })),
    );
  });
  await act(() =>
    root.render(
      createElement(Editor, {
        ...props,
        ref,
        status: available(3),
        file: "kobrixa.json",
        openFiles: ["kobrixa.json"],
      }),
    ),
  );
  const provider = vi.mocked(monaco.languages.registerHoverProvider).mock.lastCall![1];
  expect(
    await provider.provideHover(
      mocks.model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 1 } as monaco.Position,
      { isCancellationRequested: false } as monaco.CancellationToken,
    ),
  ).toBeUndefined();
  expect(props.query).not.toHaveBeenCalled();
  expect(monaco.editor.setModelLanguage).toHaveBeenLastCalledWith(mocks.model, "json");
  expect(mocks.model.setValue).toHaveBeenCalledTimes(writes);
});

it.each([
  { file: "main.bp", source: "kobrixa.basic-plus", code: "BUILD1001" },
  { file: "kobrixa.json", source: "kobrixa.core", code: "BUILD1007" },
])(
  "retains $source build markers on $file when language services become unavailable",
  async ({ file, source, code }) => {
    const build = [{ ...diagnostics[0]!, file, source, code, message: "Build failed" }];
    const live = { ...diagnostics[0]!, file, message: "Live analysis error" };
    props.documents.replace([{ file, content: "LCD.Clear()", saved: "LCD.Clear()" }]);
    const render = (status: LanguageStatus, items: Diagnostic[]) =>
      act(() =>
        root.render(
          createElement(Editor, {
            ...props,
            file,
            openFiles: [file],
            status,
            diagnostics: items,
          }),
        ),
      );
    await render(available(), [...build, live]);
    expect(mocks.setModelMarkers.mock.lastCall?.[2]).toEqual([
      expect.objectContaining({
        code,
        source: source === "kobrixa.core" ? "Kobrixa" : source,
        message: expect.stringContaining("Build failed"),
      }),
      expect.objectContaining({
        code: live.code,
        message: expect.stringContaining("Live analysis error"),
      }),
    ]);

    // App clears live diagnostics on unavailable/epoch changes, retaining build diagnostics.
    await render(
      {
        epoch: 2,
        conflicts: [],
        availability: { kind: "unavailable", reason: "missing", language: "bp" },
      },
      build,
    );
    expect(mocks.setModelMarkers.mock.lastCall?.[2]).toEqual([
      expect.objectContaining({
        code,
        source: source === "kobrixa.core" ? "Kobrixa" : source,
        message: expect.stringContaining("Build failed"),
      }),
    ]);
    mocks.setModelMarkers.mockClear();
    await render(available(3), build);
    expect(mocks.setModelMarkers.mock.lastCall?.[2]).toEqual([
      expect.objectContaining({
        code,
        source: source === "kobrixa.core" ? "Kobrixa" : source,
        message: expect.stringContaining("Build failed"),
      }),
    ]);
  },
);

it("registers only declared capabilities and gates both formatting providers by the model route", async () => {
  const onlyHover = available();
  if (onlyHover.availability.kind !== "available") throw new Error("Expected binding");
  onlyHover.availability.binding.capabilities = ["analysis", "hover"];
  const ref = createRef<EditorHandle>();
  await act(() => root.render(createElement(Editor, { ...props, ref, status: onlyHover })));
  expect(mocks.registrations).toHaveLength(1);
  expect(monaco.languages.registerHoverProvider).toHaveBeenCalledOnce();
  expect(monaco.languages.registerDocumentFormattingEditProvider).not.toHaveBeenCalled();
  expect(monaco.languages.registerDocumentRangeFormattingEditProvider).not.toHaveBeenCalled();
  await act(() => root.render(createElement(Editor, { ...props, ref, status: available(2) })));
  const documentProvider = vi.mocked(monaco.languages.registerDocumentFormattingEditProvider).mock
    .lastCall![1];
  const rangeProvider = vi.mocked(monaco.languages.registerDocumentRangeFormattingEditProvider).mock
    .lastCall![1];
  const model = mocks.model as unknown as monaco.editor.ITextModel;
  const token = { isCancellationRequested: true } as monaco.CancellationToken;
  const options = { tabSize: 2, insertSpaces: true };
  const range = new monaco.Range(1, 1, 1, 1);
  expect(await documentProvider.provideDocumentFormattingEdits(model, options, token)).toEqual([]);
  expect(
    await rangeProvider.provideDocumentRangeFormattingEdits(model, range, options, token),
  ).toEqual([]);
  await act(() => ref.current!.remapFiles({ "main.bp": "kobrixa.json" }));
  const active = { isCancellationRequested: false } as monaco.CancellationToken;
  expect(await documentProvider.provideDocumentFormattingEdits(model, options, active)).toEqual([]);
  expect(
    await rangeProvider.provideDocumentRangeFormattingEdits(model, range, options, active),
  ).toEqual([]);
});

it.each([2, 4])(
  "formats a .bp document and selected range through its companion with %i spaces",
  async (tabSize) => {
    const source = "If True\nLCD.Clear()\nEndIf";
    mocks.model.getValue.mockReturnValue(source);
    props.documents.replace([{ file: "main.bp", content: source, saved: source }]);
    const formatDocument = vi.spyOn(basicPlusCompanion, "formatSource");
    const formatRange = vi.spyOn(basicPlusCompanion, "rangeFormatting");
    try {
      await act(() => root.render(createElement(Editor, props)));
      const documentProvider = vi.mocked(monaco.languages.registerDocumentFormattingEditProvider)
        .mock.lastCall![1];
      const rangeProvider = vi.mocked(monaco.languages.registerDocumentRangeFormattingEditProvider)
        .mock.lastCall![1];
      const model = mocks.model as unknown as monaco.editor.ITextModel;
      const token = { isCancellationRequested: false } as monaco.CancellationToken;
      const options = { tabSize, insertSpaces: true };
      const range = new monaco.Range(2, 1, 2, 12);
      expect
        .soft(await documentProvider.provideDocumentFormattingEdits(model, options, token))
        .toEqual([
          {
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 },
            text: `If True\n${" ".repeat(tabSize)}LCD.Clear()\nEndIf\n`,
          },
        ]);
      expect.soft(formatDocument).toHaveBeenCalledExactlyOnceWith(source, tabSize);
      expect
        .soft(await rangeProvider.provideDocumentRangeFormattingEdits(model, range, options, token))
        .toEqual([
          {
            range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
            text: " ".repeat(tabSize),
          },
        ]);
      expect.soft(formatRange).toHaveBeenCalledExactlyOnceWith(model, range, options, token);
      expect(mocks.model.setValue).not.toHaveBeenCalled();
    } finally {
      formatDocument.mockRestore();
      formatRange.mockRestore();
    }
  },
);
