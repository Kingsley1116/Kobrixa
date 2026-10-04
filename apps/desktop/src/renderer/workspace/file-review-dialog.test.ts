// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_FILE_PREFERENCES } from "../../shared/file-preferences.js";

const mocks = vi.hoisted(() => {
  const models: { setValue: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const originalEditor = { updateOptions: vi.fn() };
  const modifiedEditor = { updateOptions: vi.fn() };
  const instance = {
    setModel: vi.fn(),
    getOriginalEditor: vi.fn(() => originalEditor),
    getModifiedEditor: vi.fn(() => modifiedEditor),
    dispose: vi.fn(),
  };
  return {
    models,
    instance,
    originalEditor,
    modifiedEditor,
    restoreEditorHoverDelegate: vi.fn(),
    setTheme: vi.fn(),
    createDiffEditor: vi.fn(() => instance),
    createModel: vi.fn(() => {
      const model = { setValue: vi.fn(), dispose: vi.fn() };
      models.push(model);
      return model;
    }),
  };
});

vi.mock("monaco-editor", () => ({
  Uri: { from: vi.fn((value) => value) },
  editor: {
    createDiffEditor: mocks.createDiffEditor,
    createModel: mocks.createModel,
    setTheme: mocks.setTheme,
  },
}));
vi.mock("../editor/monaco-services.js", () => ({
  restoreEditorHoverDelegate: mocks.restoreEditorHoverDelegate,
}));

import {
  FileConflictDialog,
  LocalHistoryDialog,
  type FileConflictDialogProps,
  type LocalHistoryDialogProps,
} from "./file-review-dialog.js";

let root: Root;
let container: HTMLDivElement;
let opener: HTMLButtonElement;
const conflict = (): FileConflictDialogProps => ({
  locale: "en",
  resolvedTheme: "dark",
  file: "src/main.bp",
  localContent: "LCD.Clear()",
  diskContent: 'LCD.Text(0, 0, "outside")',
  busy: false,
  onReload: vi.fn(),
  onKeepLocal: vi.fn(),
  onClose: vi.fn(),
});
const history = (): LocalHistoryDialogProps => ({
  locale: "en",
  resolvedTheme: "light",
  file: "main.bp",
  currentContent: "LCD.Clear()",
  entries: [{ id: "version-1", timestamp: 1728000000000, reason: "save", size: 0 }],
  selectedId: "version-1",
  loading: true,
  busy: false,
  onSelect: vi.fn(),
  onRestore: vi.fn(),
  onClose: vi.fn(),
});
const action = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[data-file-review-action="${name}"]`)!;
const click = (element: HTMLElement) => act(() => element.click());
const escape = () =>
  act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.models.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  container = document.createElement("div");
  opener = document.createElement("button");
  document.body.append(container, opener);
  opener.focus();
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  opener.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps both comparison sides read-only and disposes their separate models on close", async () => {
  const props = conflict();
  await act(() => root.render(createElement(FileConflictDialog, props)));
  expect(document.activeElement).toBe(action("close"));
  expect(mocks.restoreEditorHoverDelegate).toHaveBeenCalledOnce();
  expect(mocks.createDiffEditor).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ readOnly: true, domReadOnly: true, originalEditable: false }),
  );
  expect(mocks.models[0]!.setValue).toHaveBeenCalledWith(props.diskContent);
  expect(mocks.models[1]!.setValue).toHaveBeenCalledWith(props.localContent);
  expect(mocks.originalEditor.updateOptions).toHaveBeenCalledWith({
    ariaLabel: "Disk version (read-only): src/main.bp",
  });
  expect(mocks.modifiedEditor.updateOptions).toHaveBeenCalledWith({
    ariaLabel: "Your edits (read-only): src/main.bp",
  });
  expect(props.onKeepLocal).not.toHaveBeenCalled();
  await click(action("reload"));
  expect(props.onReload).toHaveBeenCalledOnce();
  await escape();
  expect(props.onClose).toHaveBeenCalledOnce();
  await act(() => root.render(null));
  expect(mocks.instance.dispose).toHaveBeenCalledOnce();
  expect(mocks.restoreEditorHoverDelegate).toHaveBeenCalledTimes(2);
  expect(mocks.models.every((model) => model.dispose.mock.calls.length === 1)).toBe(true);
  expect(document.activeElement).toBe(opener);
});

it("allows explicit recreation of a deleted file and prevents actions while saving", async () => {
  const props = { ...conflict(), diskContent: null, locale: "zh-TW" as const };
  await act(() => root.render(createElement(FileConflictDialog, props)));
  expect(action("reload").disabled).toBe(true);
  expect(action("save").textContent).toBe("重新建立檔案");
  expect(document.querySelector(".file-conflict-dialog")!.textContent).toContain("磁碟上已不存在");
  await click(action("reload"));
  expect(props.onReload).not.toHaveBeenCalled();
  await click(action("save"));
  expect(props.onKeepLocal).toHaveBeenCalledOnce();
  await act(() => root.render(createElement(FileConflictDialog, { ...props, busy: true })));
  await click(action("save"));
  await click(action("close"));
  await escape();
  expect(props.onKeepLocal).toHaveBeenCalledOnce();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("requires a loaded selected history version before restoring, including an empty version", async () => {
  const props = history();
  await act(() => root.render(createElement(LocalHistoryDialog, props)));
  expect(action("restore").disabled).toBe(true);
  expect(document.querySelector('[role="status"]')!.textContent).toBe("Loading history…");
  await click(action("restore"));
  expect(props.onRestore).not.toHaveBeenCalled();
  await act(() =>
    root.render(
      createElement(LocalHistoryDialog, { ...props, loading: false, selectedContent: "" }),
    ),
  );
  expect(action("restore").disabled).toBe(false);
  expect(mocks.models[0]!.setValue).toHaveBeenCalledWith("");
  expect(mocks.models[1]!.setValue).toHaveBeenCalledWith(props.currentContent);
  await click(action("restore"));
  expect(props.onRestore).toHaveBeenCalledOnce();
  await click(document.querySelector<HTMLButtonElement>('[data-history-id="version-1"]')!);
  expect(props.onSelect).toHaveBeenCalledWith("version-1");
  await act(() =>
    root.render(
      createElement(LocalHistoryDialog, {
        ...props,
        loading: false,
        selectedContent: "",
        entries: [],
      }),
    ),
  );
  expect(action("restore").disabled).toBe(true);
  expect(document.querySelector('[role="status"]')!.textContent).toContain("No saved versions yet");
});
it("shows current retention limits and keeps existing versions restorable when recording is off", async () => {
  const props: LocalHistoryDialogProps = {
    ...history(),
    loading: false,
    selectedContent: "",
    preferences: {
      ...DEFAULT_FILE_PREFERENCES,
      localHistoryEnabled: false,
      localHistoryDays: 90,
      localHistoryVersions: 100,
      localHistorySnapshotMiB: 5,
      localHistoryWorkspaceMiB: 200,
    },
  };
  await act(() => root.render(createElement(LocalHistoryDialog, props)));
  const note = document.querySelector(".file-review-note")!;
  expect(note.textContent).toContain(
    "90 days: 100 versions per file, 5 MiB per new version, and 200 MiB per workspace",
  );
  expect(note.textContent).toContain("next time history is read or written");
  expect(note.textContent).toContain("New local history versions are disabled");
  expect(action("restore").disabled).toBe(false);
  await act(() => root.render(createElement(LocalHistoryDialog, { ...props, locale: "zh-TW" })));
  expect(note.textContent).toContain("最多保留 90 天");
  expect(note.textContent).toContain("已停止新增本機歷史版本");
});
