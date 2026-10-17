// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  StaticModelContext,
  StaticLanguageRegistrar,
} from "../editor/static-language-registration.js";
import type { LexicalLanguageRoute } from "../editor/static-language-routing.js";
import { DEFAULT_FILE_PREFERENCES } from "../../shared/file-preferences.js";

const mocks = vi.hoisted(() => {
  const models: Array<{
    language: string;
    value: string;
    getLanguageId(): string;
    getValue(): string;
    setValue: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];

  const originalEditor = { updateOptions: vi.fn() };
  const modifiedEditor = { updateOptions: vi.fn() };
  const instance = {
    setModel: vi.fn(),
    updateOptions: vi.fn(),
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
    createModel: vi.fn((_value: string, language: string) => {
      const model = {
        language,
        value: "",
        getLanguageId() {
          return this.language;
        },
        getValue() {
          return this.value;
        },
        setValue: vi.fn((value: string) => {
          model.value = value;
        }),
        dispose: vi.fn(),
      };
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
  FileDiff,
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
  routing.contexts.clear();
  routing.revision = 1;
  routing.enabled = true;
  routing.settled = true;
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
    maxTokenizationLineLength: 10000,
  });
  expect(mocks.modifiedEditor.updateOptions).toHaveBeenCalledWith({
    ariaLabel: "Your edits (read-only): src/main.bp",
    maxTokenizationLineLength: 10000,
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
  expect(mocks.models[0]!.getValue()).toBe("");
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

const routing = vi.hoisted(() => ({
  settled: true,
  revision: 1,
  enabled: true,
  listeners: new Set<() => void>(),
  contexts: new Map<object, () => StaticModelContext>(),
}));
function resolveReview(context: StaticModelContext): LexicalLanguageRoute {
  if (/\.json$/i.test(context.file))
    return {
      kind: "core",
      monacoLanguage: "json",
      displayName: "JSON",
      catalogRevision: routing.revision,
    };
  if (routing.enabled && /\.toy$/i.test(context.file))
    return {
      kind: "static",
      monacoLanguage: "toy",
      displayName: "Toy",
      catalogRevision: routing.revision,
      staticOwner: { pluginId: "acme.toy", sourceKey: "dev:toy", generation: 1, languageId: "toy" },
    };
  return {
    kind: "plaintext",
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: routing.revision,
  };
}
const reviewRegistrar = {
  resolve: vi.fn(resolveReview),
  trackModel: vi.fn((model: object, context: () => StaticModelContext) => {
    routing.contexts.set(model, context);
    return {
      dispose: () => {
        routing.contexts.delete(model);
      },
    };
  }),
  refreshModels: () => {
    for (const [model, context] of routing.contexts)
      (model as { language: string }).language = resolveReview(context()).monacoLanguage;
  },
} as unknown as StaticLanguageRegistrar;
function publishRoute(revision: number, enabled: boolean) {
  // The registrar revision gate is mocked here and covered by its own integration tests.
  if (revision < routing.revision) return;
  routing.revision = revision;
  routing.enabled = enabled;
  reviewRegistrar.refreshModels();
}
vi.mock("../editor/static-language-bootstrap.js", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useStaticLanguages: () => ({
      runtime: { registrar: reviewRegistrar },
      snapshot: {
        settled: useSyncExternalStore(
          (listener) => {
            routing.listeners.add(listener);
            return () => {
              routing.listeners.delete(listener);
            };
          },
          () => routing.settled,
        ),
      },
    }),
  };
});

it("revokes hidden and newly created diff models before a stale catalog resolves", async () => {
  const props = {
    file: "main.toy",
    original: "old",
    modified: "draft",
    originalLabel: "Original",
    modifiedLabel: "Modified",
    resolvedTheme: "light" as const,
  };
  let finishOld!: () => void;
  const oldCatalog = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const oldReply = oldCatalog.then(() => publishRoute(1, true));
  await act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement("div", { hidden: true, key: "old" }, createElement(FileDiff, props)),
      ),
    ),
  );
  const retained = [...mocks.models];
  const writes = retained.map((model) => model.setValue.mock.calls.length);
  await act(() => {
    publishRoute(2, false);
    root.render(
      createElement(
        "div",
        null,
        createElement("div", { hidden: true, key: "old" }, createElement(FileDiff, props)),
        createElement(FileDiff, { ...props, key: "new", file: "new.toy" }),
      ),
    );
  });
  expect(mocks.models.every((model) => model.language === "plaintext")).toBe(true);
  await act(async () => {
    finishOld();
    await oldReply;
  });
  expect(mocks.models.every((model) => model.language === "plaintext")).toBe(true);
  expect(retained.map((model) => model.setValue.mock.calls.length)).toEqual(writes);
  expect(retained.map((model) => model.getValue())).toEqual(["old", "draft"]);
  expect(retained.every((model) => model.dispose.mock.calls.length === 0)).toBe(true);
});

it("waits for bootstrap and sends both review models the current project binding", async () => {
  routing.settled = false;
  const binding = {
    epoch: 4,
    pluginId: "test.toy",
    sourceKey: "builtin:test.toy",
    language: "toy",
    extensions: ["toy"],
    capabilities: ["analysis" as const],
    frontend: {
      language: "toy",
      sourceExtensions: ["toy"],
      entryExtensions: ["toy"],
      ir: { min: 1, max: 1 },
    },
  };
  const props = {
    ...conflict(),
    file: "main.toy",
    workspaceId: "w",
    status: { epoch: 4, conflicts: [], availability: { kind: "available" as const, binding } },
  };
  await act(() => root.render(createElement(FileConflictDialog, props)));
  expect(mocks.models).toHaveLength(0);
  await act(() => {
    routing.settled = true;
    for (const listener of routing.listeners) listener();
  });
  expect(mocks.models).toHaveLength(2);
  for (const getContext of routing.contexts.values())
    expect(getContext()).toEqual({ file: "main.toy", workspaceId: "w", binding });
  expect(mocks.createDiffEditor).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ maxTokenizationLineLength: 10000 }),
  );
  for (const target of [mocks.instance, mocks.originalEditor, mocks.modifiedEditor])
    for (const [options] of target.updateOptions.mock.calls)
      expect(options).toMatchObject({ maxTokenizationLineLength: 10000 });
  const before = [...mocks.models];
  await act(() =>
    root.render(createElement(FileConflictDialog, { ...props, file: "renamed.json" })),
  );
  expect(mocks.models).toEqual(before);
  expect(before.every((model) => model.language === "json")).toBe(true);
});
