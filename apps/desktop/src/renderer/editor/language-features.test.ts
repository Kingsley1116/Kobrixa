import { afterEach, expect, it, vi } from "vitest";
import type { CancellationToken, editor, Position } from "monaco-editor";
import { analyzeBasicPlusProject } from "@kobrixa/basic-plus";
import { ModelSnapshots } from "./model-snapshots.js";
import { BasicPlusLanguageFeatures, normalizeSource } from "./language-features.js";
import {
  bindWorkspaceEdits,
  renameSnapshot,
  validateTextEdits,
  workspaceEditService,
} from "./workspace-edits.js";

vi.mock("monaco-editor", () => ({
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  languages: {
    CompletionItemKind: { Variable: 4, Function: 1, Method: 0, Keyword: 17, Reference: 18 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
}));
const token: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};
function model(file: string, initial: string) {
  let value = normalizeSource(initial),
    version = 1,
    disposed = false;
  return {
    uri: { toString: () => `kobrixa:/${file}` },
    getValue: () => value,
    setValue: (next: string) => {
      value = normalizeSource(next);
      version++;
    },
    getVersionId: () => version,
    getLineContent: (line: number) => value.split("\n")[line - 1]!,
    getValueInRange: (range: { startLineNumber: number; startColumn: number; endColumn: number }) =>
      value
        .split("\n")
        [range.startLineNumber - 1]!.slice(range.startColumn - 1, range.endColumn - 1),
    validateRange: (range: unknown) => range,
    dispose: () => {
      disposed = true;
    },
    isDisposed: () => disposed,
  } as unknown as editor.ITextModel;
}
function setup(sources: Record<string, string>) {
  const analysis = analyzeBasicPlusProject(
    {
      root: "/project",
      manifest: {
        schemaVersion: 1,
        name: "test",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "out",
      },
      sources: Object.entries(sources).map(([path, content]) => ({ path, content })),
      assets: [],
    },
    new AbortController().signal,
  );
  const models = new Map([["main.bp", model("main.bp", sources["main.bp"]!)]]);
  const snapshot = { analysis, overlays: sources };
  let editable = true;
  const versions = new ModelSnapshots();
  const refreshCompletions = vi.fn();
  const features = new BasicPlusLanguageFeatures({
    fileFor: (m) => [...models].find(([, value]) => value === m)?.[0],
    ensureModel: (file, content) => {
      if (!models.has(file)) models.set(file, model(file, content));
      return models.get(file)!;
    },
    canEdit: () => editable,
    isCurrent: (model, file, snapshot) => versions.isCurrent(model, file, snapshot),
    refreshCompletions,
  });
  const update = features.update.bind(features);
  features.update = (next) => {
    if (next)
      for (const [file, model] of models) {
        const source = next.analysis.index.sources[file];
        if (source !== undefined && normalizeSource(source) === model.getValue()) {
          versions.bind(model, file, source);
          versions.accept(model, next);
        }
      }
    update(next);
  };
  features.update(snapshot);
  const position = (lineNumber: number, column: number) => ({ lineNumber, column }) as Position;
  return {
    features,
    refreshCompletions,
    models,
    snapshot,
    main: models.get("main.bp")!,
    position,
    lock: () => {
      editable = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

it("returns cross-file locations and signatures using the worker index", async () => {
  const { features, main, models, position } = setup({
    "main.bp": 'Import "lib"\nanswer = lib.Double(2)\n',
    "lib.bpm": "Function Double(in number input)\nReturn input * 2\nEndFunction\n",
  });
  const hover = await features.hover(main, position(2, 16), token);
  expect(hover?.contents[0]?.value).toContain("Double(in number input): number");
  const definitions = await features.definition(main, position(2, 16), token);
  expect(definitions[0]?.uri.toString()).toBe("kobrixa:/lib.bpm");
  expect(models.has("lib.bpm")).toBe(true);
  expect(await features.references(main, position(2, 16), true, token)).toHaveLength(2);
  const signature = await features.signature(main, position(2, 21), token);
  expect(signature?.value.signatures[0]?.label).toBe("lib.Double(in number input): number");
  expect(signature?.value.activeParameter).toBe(0);
});

it("completes scoped user symbols and APIs but suppresses literals and comments", async () => {
  const { features, main, position } = setup({
    "main.bp":
      'value = 1\nFunction Copy(in number value)\nlocalValue = value\nReturn val\nEndFunction\n\' Copy\ntext = "Copy"\n',
  });
  const completions = await features.completions(main, position(4, 11), token);
  expect(completions.suggestions.find((s) => s.label === "value")?.detail).toBe(
    "parameter number value",
  );
  expect((await features.completions(main, position(6, 7), token)).suggestions).toEqual([]);
  expect((await features.completions(main, position(7, 11), token)).suggestions).toEqual([]);
});

it("returns built-ins immediately while analysis is missing without reading the entire document", async () => {
  vi.useFakeTimers();
  const { features, main, position } = setup({ "main.bp": "LCD.\n" });
  features.update(undefined);
  const read = vi.spyOn(main, "getValue");
  read.mockClear();
  const completion = await features.completions(main, position(1, 5), token);
  expect(completion.incomplete).toBe(true);
  expect(completion.suggestions.some((s) => s.label === "LCD.Clear")).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("validates accepted model versions for repeated hover and rejects a newer model", async () => {
  vi.useFakeTimers();
  const { features, main, position } = setup({ "main.bp": "value = 1\n" });
  const read = vi.spyOn(main, "getValue");
  read.mockClear();
  for (let i = 0; i < 20; i++)
    expect(await features.hover(main, position(1, 2), token)).toBeDefined();
  expect(read).not.toHaveBeenCalled();
  main.setValue("other = 2\n");
  const pending = features.hover(main, position(1, 2), token);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it("requests a completion refresh only for the same model version that received fallback items", async () => {
  const { features, main, snapshot, position, refreshCompletions } = setup({
    "main.bp": "LCDValue = 1\nLC",
  });
  features.update(undefined);
  await features.completions(main, position(2, 3), token);
  features.update(snapshot);
  expect(refreshCompletions).toHaveBeenCalledExactlyOnceWith(main, position(2, 3));
  features.update(snapshot);
  expect(refreshCompletions).toHaveBeenCalledTimes(1);
  features.update(undefined);
  await features.completions(main, position(2, 3), token);
  main.setValue("other = 1\nLC");
  features.update(snapshot);
  expect(refreshCompletions).toHaveBeenCalledTimes(1);
});

it("prepares versioned rename edits without changing models, and rejects read-only symbols", async () => {
  const { features, main, models, snapshot, position, lock } = setup({
    "main.bp": 'Import "lib"\nWork()\n',
    "lib.bpm": "Sub Work()\nEndSub\n",
  });
  const edits = await features.rename(main, position(2, 2), "Task", token);
  expect(edits.edits).toHaveLength(2);
  expect(renameSnapshot(edits)).toBe(snapshot);
  expect(main.getValue()).toContain("Work()");
  const groups = validateTextEdits(edits, (uri) =>
    [...models.values()].find((m) => m.uri.toString() === uri),
  );
  expect(groups.size).toBe(2);
  models.get("lib.bpm")!.setValue("Sub Changed()\nEndSub\n");
  expect(() =>
    validateTextEdits(edits, (uri) => [...models.values()].find((m) => m.uri.toString() === uri)),
  ).toThrow("document changed");
  lock();
  expect((await features.rename(main, position(2, 2), "Task", token)).rejectReason).toContain(
    "read-only",
  );
});

it("uses explicit file bindings after file rename instead of the retained model URI", async () => {
  const { features, main, models, snapshot, position } = setup({ "main.bp": "value = 1\n" });
  const { snapshot: renamed } = setup({ "main.bp": "", "renamed.bp": "value = 1\n" });
  models.delete("main.bp");
  models.set("renamed.bp", main);
  features.update(renamed);
  expect((await features.hover(main, position(1, 2), token))?.contents[0]?.value).toContain(
    "value",
  );
  expect(main.uri.toString()).toBe("kobrixa:/main.bp");
  features.update(snapshot);
  features.dispose();
  expect(await features.definition(main, position(1, 2), token)).toEqual([]);
});

it("waits for a fresh snapshot and discards requests when content changes or cancellation arrives", async () => {
  vi.useFakeTimers();
  const { features, main, snapshot, position } = setup({ "main.bp": "value = 1\n" });
  features.update(undefined);
  const pending = features.hover(main, position(1, 2), token);
  features.update(snapshot);
  expect((await pending)?.contents[0]?.value).toContain("value");
  features.update(undefined);
  const obsolete = features.hover(main, position(1, 2), token);
  main.setValue("another = 2");
  features.update(undefined);
  expect(await obsolete).toBeUndefined();
  let cancel = () => {};
  const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: (event: unknown) => unknown) => {
      cancel = () => {
        listener(undefined);
      };
      return { dispose() {} };
    },
  };
  const canceled = features.definition(main, position(1, 2), cancellation);
  cancellation.isCancellationRequested = true;
  cancel();
  expect(await canceled).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("converts BOM columns for hover and rename while preserving exact source snapshots", async () => {
  const { features, main, position } = setup({ "main.bp": "\ufeffvalue = 1\r\nvalue++\r\n" });
  const hover = await features.hover(main, position(1, 2), token);
  expect(hover?.range?.startColumn).toBe(1);
  const edits = await features.rename(main, position(1, 2), "total", token);
  expect(edits.edits).toHaveLength(2);
  expect(edits.edits[0]).toMatchObject({ textEdit: { range: { startColumn: 1, endColumn: 6 } } });
});

it("rebinds the global Monaco workspace service across workspace remounts", async () => {
  const first = vi.fn(async () => ({ isApplied: true, ariaSummary: "first" }));
  const second = vi.fn(async () => ({ isApplied: true, ariaSummary: "second" }));
  const detachFirst = bindWorkspaceEdits(first),
    detachSecond = bindWorkspaceEdits(second);
  detachFirst();
  expect((await workspaceEditService.apply({ edits: [] })).ariaSummary).toBe("second");
  expect(first).not.toHaveBeenCalled();
  detachSecond();
  await expect(workspaceEditService.apply({ edits: [] })).rejects.toThrow("No editable workspace");
});
