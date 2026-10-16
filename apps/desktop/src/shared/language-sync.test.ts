import { expect, it } from "vitest";
import {
  applyAnalysis,
  applyRecord,
  diffAnalysis,
  diffRecord,
  emptyAnalysis,
  emptyLanguageIndex,
} from "./language-sync.js";

it("round trips changed/deleted sections and preserves unchanged identities", () => {
  const one = emptyAnalysis();
  one.index.sources = { "main.bp": "a = 1", "lib.bpm": "LCD.Clear()" };
  one.tokensByFile = { "main.bp": [], "lib.bpm": [] };
  one.index.fileContexts = { "main.bp": "main.bp", "lib.bpm": "lib.bpm" };
  const first = applyAnalysis(undefined, diffAnalysis(undefined, one, null, 1));
  const two = structuredClone(one);
  two.index.sources["main.bp"] = "a = 2";
  delete two.index.sources["lib.bpm"];
  delete two.index.fileContexts["lib.bpm"];
  const patch = diffAnalysis(one, two, 1, 2);
  expect(patch.index.sources).toEqual({ set: { "main.bp": "a = 2" }, removed: ["lib.bpm"] });
  expect(patch.tokensByFile).toEqual({ set: {}, removed: [] });
  const second = applyAnalysis(first, patch);
  expect(second.analysis).toEqual(two);
  expect(second.analysis.tokensByFile).toBe(first.analysis.tokensByFile);
  expect(second.analysis.index.symbols).toBe(first.analysis.index.symbols);
  expect(first.analysis).toEqual(one);
  expect(() => applyAnalysis(first, { ...patch, base: 9 })).toThrow("base version");
  expect(applyAnalysis(second, diffAnalysis(undefined, one, null, 3)).analysis).toEqual(one);
});

it("treats file/symbol keys as data and deletes removed overlays", () => {
  const before = JSON.parse('{"__proto__":"x","constructor":"y","removed":"z"}') as Record<
    string,
    string
  >;
  const after = JSON.parse('{"__proto__":"next","constructor":"y"}') as Record<string, string>;
  expect(applyRecord(before, diffRecord(before, after))).toEqual(after);
  expect(Object.getPrototypeOf(applyRecord(before, diffRecord(before, after)))).toBeNull();
});

it("packs exact ranges, modifier order and cross-context occurrences into cloneable numeric buffers", () => {
  const analysis = emptyAnalysis();
  const range = { startLine: 3, startColumn: 9, endLine: 3, endColumn: 15 };
  analysis.tokensByFile["中文.bp"] = [
    { range, type: "variable", modifiers: ["global", "declaration"] },
    {
      range: { ...range, startLine: 4, endLine: 4 },
      type: "method",
      modifiers: ["defaultLibrary"],
    },
  ];
  analysis.index.occurrencesByFile["中文.bp"] = [
    { file: "中文.bp", range, symbolId: "😀symbol", context: "main.bp", declaration: true },
    { file: "中文.bp", range, symbolId: "other", context: "standalone.bp", declaration: false },
  ];
  const patch = diffAnalysis(undefined, analysis, null, 1);
  expect(patch.tokensByFile.set["中文.bp"]!.data).toBeInstanceOf(Uint32Array);
  expect(patch.index.occurrencesByFile.set["中文.bp"]!.data).toBeInstanceOf(Uint32Array);
  expect(applyAnalysis(undefined, structuredClone(patch)).analysis).toEqual(analysis);
});

it("preserves opaque shadow keys and token dictionaries", () => {
  expect(emptyLanguageIndex().symbols).toEqual({});
  const analysis = emptyAnalysis();
  const range = { startLine: 1, startColumn: 2, endLine: 1, endColumn: 5 };
  analysis.index.sources["名字.csx"] = "\uFEFFFoo foo 😀\r\n";
  analysis.index.symbols = Object.fromEntries(
    ["Foo", "foo"].map((name) => [
      name,
      {
        id: name,
        name,
        kind: "variable" as const,
        signature: `case ${name}`,
        labels: [{ text: name, detail: `case ${name}` }],
        group: "opaque/context",
        shadowKey: name,
        location: { file: "名字.csx", range },
      },
    ]),
  );
  analysis.tokensByFile["名字.csx"] = [{ range, type: "caseIdentifier", modifiers: ["mutable"] }];
  const patch = diffAnalysis(undefined, analysis, null, 1);
  expect(patch.tokensByFile.set["名字.csx"]!.data).toBeInstanceOf(Uint32Array);
  expect(patch.tokensByFile.set["名字.csx"]!.data.byteLength).toBe(6 * 4);
  const received = applyAnalysis(undefined, structuredClone(patch));
  expect(received.analysis).toEqual(analysis);
  expect(Object.values(received.analysis.index.symbols).map((s) => s.shadowKey)).toEqual([
    "Foo",
    "foo",
  ]);
  const delta = diffAnalysis(analysis, structuredClone(analysis), 1, 2);
  expect(delta.tokensByFile.set).toEqual({});
  expect(delta.index.symbols.set).toEqual({});
  expect(applyAnalysis(received, delta).analysis.tokensByFile).toBe(received.analysis.tokensByFile);
});
