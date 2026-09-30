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
    registerCompletionItemProvider: vi.fn(),
    registerDocumentFormattingEditProvider: vi.fn(),
  },
  editor: {
    create: mocks.create,
    createModel: vi.fn(() => mocks.model),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelMarkers: mocks.setModelMarkers,
  },
}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: class {} }));

import { Editor } from "./editor.js";

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
  value: "LCD.Clear()",
  openFiles: ["main.bp"],
  diagnostics,
  focusTarget: undefined,
  ariaLabel: "Editor",
  onChange: vi.fn(),
  onCursorChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.model.getValue.mockReturnValue(props.value);
  await act(async () => root.render(createElement(Editor, props)));
  expect(mocks.setModelMarkers).toHaveBeenCalledTimes(1);
  mocks.setModelMarkers.mockClear();
  mocks.instance.saveViewState.mockClear();
  for (const value of ["LCD.Clear()\n", "LCD.Clear()", "LCD.Clear()\n\n"]) {
    mocks.model.getValue.mockReturnValue(value);
    // App produces a new openFiles array when tab contents change.
    await act(async () =>
      root.render(createElement(Editor, { ...props, value, openFiles: ["main.bp"] })),
    );
  }
  expect(mocks.setModelMarkers).not.toHaveBeenCalled();
  expect(mocks.model.setValue).not.toHaveBeenCalled();
  expect(mocks.instance.saveViewState).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledWith(
    container.firstChild,
    expect.objectContaining({
      cursorSmoothCaretAnimation: "off",
      smoothScrolling: false,
    }),
  );

  await act(async () =>
    root.render(createElement(Editor, { ...props, value: "LCD.Clear()\n\n", diagnostics: [] })),
  );
  expect(mocks.setModelMarkers).toHaveBeenCalledExactlyOnceWith(mocks.model, "kobrixa", []);
});

it("applies diagnostics when a file is opened and still accepts external content changes", async () => {
  mocks.model.getValue.mockReturnValue(props.value);
  await act(async () => root.render(createElement(Editor, props)));
  mocks.setModelMarkers.mockClear();
  await act(async () =>
    root.render(
      createElement(Editor, {
        ...props,
        file: "other.bp",
        value: "LCD.Update()",
        openFiles: ["main.bp", "other.bp"],
      }),
    ),
  );
  expect(mocks.setModelMarkers).toHaveBeenCalledTimes(2);
  expect(mocks.setModelMarkers).toHaveBeenLastCalledWith(mocks.model, "kobrixa", []);
  props.onChange.mockClear();
  await act(async () =>
    root.render(createElement(Editor, { ...props, file: "other.bp", value: "LCD.Clear()\n\n" })),
  );
  expect(mocks.model.setValue).toHaveBeenLastCalledWith("LCD.Clear()\n\n");
  expect(props.onChange).not.toHaveBeenCalled();
});
