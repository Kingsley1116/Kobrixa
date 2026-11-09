import type { ModelLanguageRoute } from "./model-language-route.js";
import { afterEach, expect, it, vi } from "vitest";
import type { CancellationToken, editor, Position } from "monaco-editor";
import { analyzeBasicPlusProject, BasicPlusCompletionAnalyzer } from "@kobrixa/basic-plus";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import { basicPlusLanguageService } from "../../main/language/basic-plus-service.js";
import { basicPlusAnalysis, basicPlusCompletion } from "../../main/language/basic-plus-results.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageAnalysisProvider } from "../../main/language/language-provider.js";
import { CompletionCache } from "./completion-cache.js";
import { stampDiagnostics } from "@kobrixa/compiler";
import { BASIC_PLUS_SOURCE } from "../../main/language/basic-plus-quick-fixes.js";
import type { Diagnostic } from "../../shared/api.js";
import { ModelSnapshots } from "./model-snapshots.js";
import { LanguageFeatures, normalizeSource } from "./language-features.js";
import { basicPlusCompanion } from "./companions/basic-plus/companion.js";
import {
  bindWorkspaceEdits,
  renameSnapshot,
  validateTextEdits,
  workspaceEditService,
  workspaceEditContext,
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
  const decorations = new Map<string, editor.IModelDeltaDecoration>();
  return {
    deltaDecorations: (_old: string[], items: editor.IModelDeltaDecoration[]) =>
      items.map((item, index) => {
        const id = String(index);
        decorations.set(id, item);
        return id;
      }),
    getDecorationRange: (id: string) => {
      const range = decorations.get(id)?.range;
      return range
        ? {
            ...range,
            containsPosition: (p: Position) =>
              (p.lineNumber > range.startLineNumber ||
                (p.lineNumber === range.startLineNumber && p.column >= range.startColumn)) &&
              (p.lineNumber < range.endLineNumber ||
                (p.lineNumber === range.endLineNumber && p.column <= range.endColumn)),
          }
        : null;
    },
    uri: { toString: () => `kobrixa:/${file}` },
    getLanguageId: () => "bp",
    getValue: () => value,
    setValue: (next: string) => {
      value = normalizeSource(next);
      version++;
    },
    getVersionId: () => version,
    getOptions: () => ({ tabSize: 2 }),
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
const providers = new WeakMap<LanguageAnalysis, LanguageAnalysisProvider>();
function setup(sources: Record<string, string>) {
  let locale: "en" | "zh-TW" = "en";
  const project = {
    root: "/project",
    manifest: {
      schemaVersion: 1 as const,
      name: "test",
      language: "bp",
      entry: "main.bp",
      target: "ev3-native",
      assets: [],
      outputDir: "out",
    },
    sources: Object.entries(sources).map(([path, content]) => ({ path, content })),
    assets: [],
  };
  const signal = new AbortController().signal;
  const raw = analyzeBasicPlusProject(project, signal);
  const analysis = {
    ...basicPlusAnalysis(raw),
    diagnostics: stampDiagnostics(raw.diagnostics, BASIC_PLUS_SOURCE),
  };
  const provider = basicPlusLanguageService.createAnalysis();
  provider.analyze(project, 1, signal);
  providers.set(analysis, provider);
  const cache = new CompletionCache();
  const completionIndex = basicPlusCompletion(
    new BasicPlusCompletionAnalyzer().analyze(project, signal),
  );
  cache.update(completionIndex, 1);
  const models = new Map([["main.bp", model("main.bp", sources["main.bp"]!)]]);
  for (const [file, model] of models) cache.attach(file, model, []);
  const binding = {
    epoch: 1,
    pluginId: "kobrixa.basic-plus",
    sourceKey: "builtin:kobrixa.basic-plus",
    language: "bp",
    extensions: ["bp", "bpi", "bpm"],
    capabilities: [...LANGUAGE_CAPABILITIES],
    frontend: {
      language: "bp",
      entryExtensions: ["bp"],
      sourceExtensions: ["bp", "bpi", "bpm"],
      ir: { min: 1, max: 1 },
    },
  };
  const snapshot = { epoch: 1, binding, analysis, overlays: sources };
  let editable = true;
  const versions = new ModelSnapshots();
  const refreshCompletions = vi.fn();
  const quickFixes = vi.fn(
    async (current: typeof snapshot, diagnostic: Diagnostic, _signal: AbortSignal) => ({
      kind: "result" as const,
      epoch: current.epoch,
      fixes: providers.get(current.analysis)!.quickFixes(1, diagnostic.file, diagnostic, _signal),
    }),
  );
  const route = {
    monacoLanguage: "bp",
    kind: "static" as const,
    displayName: "Basic Plus",
    catalogRevision: 1,
    staticOwner: {
      pluginId: binding.pluginId,
      sourceKey: binding.sourceKey,
      generation: 1,
      languageId: "bp",
    },
    binding,
    companion: basicPlusCompanion,
  };
  const routes = new Map<editor.ITextModel, ModelLanguageRoute>(
    [...models.values()].map((model) => [model, route]),
  );

  const features = new LanguageFeatures({
    route: (model) => routes.get(model),
    locale: () => locale,
    binding: () => binding,
    companion: () => basicPlusCompanion,
    completionSymbols: (model, position) => {
      const file = [...models].find(([, value]) => value === model)?.[0];
      return file ? cache.symbols(file, position, 1) : undefined;
    },
    query: async (snapshot, query, signal) => ({
      kind: "result",
      epoch: snapshot.epoch,
      result: providers.get(snapshot.analysis)!.query(1, query, signal),
    }),
    quickFixes,
    fileFor: (m) => [...models].find(([, value]) => value === m)?.[0],
    ensureModel: (file, content) => {
      if (!models.has(file)) models.set(file, model(file, content));
      routes.set(models.get(file)!, route);
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
    routes,
    route,
    cache,
    completionIndex,
    quickFixes,
    setLocale: (value: "en" | "zh-TW") => {
      locale = value;
    },
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

it.each([2, 4])("companion preserves closing completion indentation with %i spaces", (tabSize) => {
  const spaces = " ".repeat(tabSize);
  const { main, position } = setup({
    "main.bp": `If True\n${spaces}While True\n${spaces.repeat(2)}EndWh`,
  });
  vi.spyOn(main, "getOptions").mockReturnValue({ tabSize } as editor.TextModelResolvedOptions);
  const list = basicPlusCompanion.completions(main, position(3, tabSize * 2 + 6), [], token);
  const item = list.suggestions.find((item) => item.label === "EndWhile")!;
  expect(item.range).toMatchObject({
    startLineNumber: 3,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: tabSize * 2 + 6,
  });
  expect(item.insertText).toBe(spaces + "EndWhile");
  expect(item.filterText).toBe(spaces.repeat(2) + "EndWhile");
});

it("companion filters generic labels and preserves their display details", () => {
  const { main, position } = setup({ "main.bp": "VaLue" });
  const list = basicPlusCompanion.completions(
    main,
    position(1, 4),
    [
      {
        id: "value",
        name: "value",
        kind: "variable",
        signature: "parameter number value",
        group: "scope",
        shadowKey: "value:value",
        labels: [{ text: "value", detail: "parameter number value" }],
      },
    ],
    token,
  );
  expect(list.suggestions).toEqual([
    expect.objectContaining({
      label: "value",
      insertText: "value",
      detail: "parameter number value",
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
    }),
  ]);
});

it("companion completes APIs immediately and suppresses literals, comments and cancellation", () => {
  const { main, position } = setup({ "main.bp": "LCD." });
  const read = vi.spyOn(main, "getValue");
  expect(
    basicPlusCompanion.completions(main, position(1, 5), [], token).suggestions,
  ).toContainEqual(expect.objectContaining({ label: "LCD.Clear" }));
  expect(read).not.toHaveBeenCalled();
  for (const text of ['"LCD.', "'LCD."]) {
    main.setValue(text);
    expect(basicPlusCompanion.completions(main, position(1, 6), [], token).suggestions).toEqual([]);
  }
  main.setValue("LCD.");
  expect(
    basicPlusCompanion.completions(main, position(1, 5), [], {
      ...token,
      isCancellationRequested: true,
    }).suggestions,
  ).toEqual([]);
  main.dispose();
  expect(basicPlusCompanion.completions(main, position(1, 5), [], token).suggestions).toEqual([]);
});

it.each([2, 4])(
  "accepts closing completions with %i-space indentation in one edit",
  async (tabSize) => {
    const spaces = " ".repeat(tabSize);
    const { features, main, position } = setup({
      "main.bp": `If True\n${spaces}While True\n${spaces.repeat(2)}EndWh`,
    });
    vi.spyOn(main, "getOptions").mockReturnValue({ tabSize } as editor.TextModelResolvedOptions);
    const list = await features.completions(main, position(3, tabSize * 2 + 6), token);
    const item = list.suggestions.find((item) => item.label === "EndWhile")!;
    expect(item.range).toMatchObject({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: tabSize * 2 + 6,
    });
    expect(item.insertText).toBe(spaces + "EndWhile");
    expect(item.filterText).toBe(spaces.repeat(2) + "EndWhile");
  },
);

it("indents a closing completion at column one and preserves text before non-leading completions", async () => {
  const { features, main, position } = setup({ "main.bp": "If True\n  While True\nEndWh" });
  const closing = (await features.completions(main, position(3, 6), token)).suggestions.find(
    (item) => item.label === "EndWhile",
  )!;
  expect(closing.insertText).toBe("  EndWhile");
  main.setValue("If True\n  value = EndWh");
  const other = (await features.completions(main, position(2, 16), token)).suggestions.find(
    (item) => item.label === "EndWhile",
  )!;
  expect(other.insertText).toBe("EndWhile");
  expect(other.range).toMatchObject({ startColumn: 11 });
});

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

it.each(["cleared", "invalid"] as const)(
  "refreshes current analysis completions after the cache is %s and restores user symbols",
  async (state) => {
    const { features, main, cache, completionIndex, position, refreshCompletions } = setup({
      "main.bp": "LCDValue = 1\nLC",
    });
    const cursor = position(2, 3);
    expect((await features.completions(main, cursor, token)).incomplete).toBe(false);
    if (state === "cleared") cache.clear();
    else cache.invalidate("main.bp");
    const pending = await features.completions(main, cursor, token);
    expect.soft(pending.incomplete).toBe(true);
    expect(pending.suggestions.some((item) => item.label === "LCDValue")).toBe(false);
    expect(pending.suggestions.some((item) => item.label === "LCD.Clear")).toBe(true);

    cache.update(completionIndex, 1);
    cache.attach("main.bp", main, []);
    features.refreshCompletion();
    expect.soft(refreshCompletions).toHaveBeenCalledExactlyOnceWith(main, cursor);
    const refreshed = await features.completions(main, cursor, token);
    expect(refreshed.incomplete).toBe(false);
    expect(refreshed.suggestions.find((item) => item.label === "LCDValue")).toMatchObject({
      insertText: "LCDValue",
      detail: "global number LCDValue",
    });
  },
);

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
    onCancellationRequested: (listener: (event: void) => unknown) => {
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

it("offers localized, versioned single-file fixes with BOM-correct insertion ranges", async () => {
  const h = setup({ "main.bp": "\uFEFFLCD.Clear( ' 中文😀\r\n" });
  const diagnostic = h.snapshot.analysis.diagnostics.find((d) => d.code === "BP1043")!;
  const [action] = await h.features.quickFixes(h.main, diagnostic);
  expect(action?.title).toBe("Insert closing parenthesis )");
  expect(action?.edit?.edits).toEqual([
    expect.objectContaining({
      versionId: 1,
      textEdit: {
        range: expect.objectContaining({
          startLineNumber: 1,
          startColumn: 11,
          endLineNumber: 1,
          endColumn: 11,
        }),
        text: ")",
      },
    }),
  ]);
  expect(workspaceEditContext(action!.edit!)).toMatchObject({
    kind: "quick-fix",
    files: ["main.bp"],
    snapshot: h.snapshot,
  });
  expect(validateTextEdits(action!.edit!, () => h.main).size).toBe(1);
  expect(h.main.getValue()).toBe("LCD.Clear( ' 中文😀\n");
  h.setLocale("zh-TW");
  expect((await h.features.quickFixes(h.main, diagnostic))[0]?.title).toBe("補上右括號 )");
  h.main.setValue("LCD.Clear()\n");
  expect(() => validateTextEdits(action!.edit!, () => h.main)).toThrow("changed");
  expect(await h.features.quickFixes(h.main, diagnostic)).toEqual([]);
});

it("discards delayed fixes after edits, cancellation or workspace replacement", async () => {
  const h = setup({ "main.bp": "LCD.Clear(\n" });
  const diagnostic = h.snapshot.analysis.diagnostics.find((d) => d.code === "BP1043")!;
  let resolve!: (value: Awaited<ReturnType<typeof h.quickFixes>>) => void;
  h.quickFixes.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = h.features.quickFixes(h.main, diagnostic);
  h.main.setValue("LCD.Clear()\n");
  resolve({ kind: "result", epoch: 1, fixes: [] });
  expect(await pending).toEqual([]);
  const other = setup({ "main.bp": "LCD.Clear(\n" });
  const cancelled = { ...token, isCancellationRequested: true };
  expect(await other.features.quickFixes(other.main, diagnostic, cancelled)).toEqual([]);
  expect(other.quickFixes).not.toHaveBeenCalled();
  other.features.update(undefined);
  expect(await other.features.quickFixes(other.main, diagnostic)).toEqual([]);
  other.features.update(other.snapshot);
  other.lock();
  expect(await other.features.quickFixes(other.main, diagnostic)).toEqual([]);
});

it.each(["monaco", "panel", "invalidation", "dispose"] as const)(
  "propagates %s cancellation to the quick-fix request",
  async (reason) => {
    const h = setup({ "main.bp": "LCD.Clear(\n" });
    const diagnostic = h.snapshot.analysis.diagnostics.find((d) => d.code === "BP1043")!;
    let finish!: (value: Awaited<ReturnType<typeof h.quickFixes>>) => void;
    h.quickFixes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let cancelToken = () => {};
    const dispose = vi.fn();
    const queryToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: (event: void) => unknown) => {
        cancelToken = () => {
          listener(undefined);
        };
        return { dispose };
      },
    };
    const controller = new AbortController();
    const pending = h.features.quickFixes(h.main, diagnostic, queryToken, controller.signal);
    const signal = h.quickFixes.mock.calls[0]![2];
    expect(signal.aborted).toBe(false);
    if (reason === "monaco") {
      queryToken.isCancellationRequested = true;
      cancelToken();
    } else if (reason === "panel") controller.abort();
    else if (reason === "invalidation") h.features.update(undefined);
    else h.features.dispose();
    expect(signal.aborted).toBe(true);
    finish({
      kind: "result",
      epoch: 1,
      fixes: providers
        .get(h.snapshot.analysis)!
        .quickFixes(1, "main.bp", diagnostic, new AbortController().signal),
    });
    expect(await pending).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it("keeps API signature help available while analysis is pending", async () => {
  vi.useFakeTimers();
  const h = setup({ "main.bp": "LCD.Text(1, " });
  h.features.update(undefined);
  const read = vi.spyOn(h.main, "getValue");
  const pending = h.features.signature(h.main, h.position(1, 13), token);
  await vi.advanceTimersByTimeAsync(2000);
  const signature = await pending;
  expect(signature?.value.signatures[0]?.label).toContain("LCD.Text(");
  expect(signature?.value.activeParameter).toBe(1);
  expect(read).not.toHaveBeenCalled();
});
it("tolerates built-in occurrences whose symbols are absent from the generic index", async () => {
  const h = setup({ "main.bp": "LCD.Clear()" });
  const occurrence = h.snapshot.analysis.index.occurrencesByFile["main.bp"]!.find(
    (entry) => !h.snapshot.analysis.index.symbols[entry.symbolId],
  );
  expect(occurrence).toBeDefined();
  expect(
    await h.features.hover(
      h.main,
      h.position(occurrence!.range.startLine, occurrence!.range.startColumn),
      token,
    ),
  ).toBeDefined();
  expect(
    await h.features.definition(
      h.main,
      h.position(occurrence!.range.startLine, occurrence!.range.startColumn),
      token,
    ),
  ).toEqual([]);
  expect
    .soft(
      await h.features.references(
        h.main,
        h.position(occurrence!.range.startLine, occurrence!.range.startColumn),
        true,
        token,
      ),
    )
    .toEqual([
      {
        uri: h.main.uri,
        range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 10 },
      },
    ]);
  expect(
    (
      await h.features.renameLocation(
        h.main,
        h.position(occurrence!.range.startLine, occurrence!.range.startColumn),
        token,
      )
    ).rejectReason,
  ).toBe("A current, editable user-defined symbol is required.");
});
it("gates fixes by the binding capability, source, and epoch", async () => {
  const h = setup({ "main.bp": "LCD.Clear(" });
  const diagnostic = h.snapshot.analysis.diagnostics.find((d) => d.code === "BP1043")!;
  h.snapshot.binding.capabilities = ["analysis"];
  expect(await h.features.quickFixes(h.main, diagnostic)).toEqual([]);
  expect(h.quickFixes).not.toHaveBeenCalled();
  h.snapshot.binding.capabilities.push("quickFixes");
  expect(await h.features.quickFixes(h.main, { ...diagnostic, source: "test.other" })).toEqual([]);
  h.snapshot.binding.epoch = 2;
  expect(await h.features.quickFixes(h.main, diagnostic)).toEqual([]);
  expect(h.quickFixes).not.toHaveBeenCalled();
});

it("cancels a waiting feature when its model is rebound to another path", async () => {
  vi.useFakeTimers();
  const h = setup({ "main.bp": "value = 1" });
  h.features.update(undefined);
  const pending = h.features.hover(h.main, h.position(1, 2), token);
  h.models.delete("main.bp");
  h.models.set("kobrixa.json", h.main);
  try {
    h.features.unbind(h.main);
    expect(vi.getTimerCount()).toBe(0);
    expect(await pending).toBeUndefined();
  } finally {
    h.features.dispose();
  }
});

it("keeps services on the selected plaintext model and rejects an adjacent model or stale owner", async () => {
  const s = setup({ "main.bp": "value = 1" });
  vi.spyOn(s.main, "getLanguageId").mockReturnValue("plaintext");
  const fallback = {
    ...s.route,
    kind: "plaintext" as const,
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: 2,
  };
  delete (fallback as { staticOwner?: unknown }).staticOwner;
  s.routes.set(s.main, fallback);
  const complete = vi.spyOn(basicPlusCompanion, "completions").mockReturnValue({ suggestions: [] });
  try {
    await s.features.completions(s.main, s.position(1, 2), token);
    expect(complete).toHaveBeenCalledOnce();
    complete.mockClear();
    const neighbor = model("main.bp", "value = 1");
    vi.spyOn(neighbor, "getLanguageId").mockReturnValue("plaintext");
    expect(await s.features.completions(neighbor, s.position(1, 2), token)).toEqual({
      suggestions: [],
    });
    s.routes.set(s.main, {
      ...fallback,
      binding: { ...s.snapshot.binding, sourceKey: "builtin:other" },
    });
    expect(await s.features.completions(s.main, s.position(1, 2), token)).toEqual({
      suggestions: [],
    });
    s.routes.set(s.main, { ...fallback, binding: { ...s.snapshot.binding, epoch: 99 } });
    expect(await s.features.signature(s.main, s.position(1, 2), token)).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  } finally {
    complete.mockRestore();
    s.features.dispose();
  }
});
