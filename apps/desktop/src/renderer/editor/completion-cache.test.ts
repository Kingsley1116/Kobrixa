import { expect, it } from "vitest";
import type { editor, Position } from "monaco-editor";
import {
  CompletionCache,
  rebaseCompletionRanges,
  type CompletionChange,
} from "./completion-cache.js";
import { structuralChange } from "./companions/basic-plus/structure.js";

const scope = { startLine: 3, startColumn: 1, endLine: 8, endColumn: 12 };
const guards = [3, 8].map((line) => ({
  startLine: line,
  startColumn: 1,
  endLine: line,
  endColumn: 1,
}));

it("detects a boundary keyword assembled by a single-character edit", () => {
  const model = {
    getPositionAt: () => ({ lineNumber: 1 }),
    getLineContent: () => "Function New()",
  } as unknown as editor.ITextModel;
  const event = {
    changes: [{ rangeOffset: 7, rangeLength: 0, text: "n" }],
  } as editor.IModelContentChangedEvent;
  expect(structuralChange(model, event)).toBe(true);
});
function change(line: number, text: string, endLine = line): CompletionChange {
  return {
    before: 1,
    version: 2,
    flush: false,
    changes: [
      {
        rangeOffset: 0,
        rangeLength: 0,
        text,
        range: { startLineNumber: line, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
      },
    ],
  };
}
it("maps scope boundaries through edits before and within a function", () => {
  expect(rebaseCompletionRanges([scope], guards, change(1, "' 中文😀\r\n"))?.scopes).toEqual([
    { ...scope, startLine: 4, endLine: 9 },
  ]);
  expect(rebaseCompletionRanges([scope], guards, change(5, "\n\n"))?.scopes).toEqual([
    { ...scope, endLine: 10 },
  ]);
});
it("invalidates function/parameter boundaries, imports, removed boundaries and model resets", () => {
  for (const event of [change(1, 'Import "lib"'), change(5, "EndFunction")]) {
    const model = {
      getPositionAt: () => ({ lineNumber: 1 }),
      getLineContent: () => event.changes[0]!.text,
    } as unknown as editor.ITextModel;
    expect(
      structuralChange(model, {
        changes: [...event.changes],
      } as editor.IModelContentChangedEvent),
    ).toBe(true);
    expect(rebaseCompletionRanges([scope], guards, { ...event, structural: true })).toBeUndefined();
  }
  for (const event of [change(3, "x"), change(7, "", 9), { ...change(4, "x"), flush: true }])
    expect(rebaseCompletionRanges([scope], guards, event)).toBeUndefined();
});

it("does not fold another provider's case-sensitive shadow keys", () => {
  const cache = new CompletionCache();
  const symbols = Object.fromEntries(
    ["Foo", "foo"].map((name) => [
      name,
      {
        id: name,
        name,
        kind: "variable" as const,
        signature: name,
        labels: [{ text: name, detail: name }],
        group: "case",
        shadowKey: name,
      },
    ]),
  );
  cache.update(
    {
      symbols,
      scopes: [],
      fileContexts: { "main.csx": "case" },
      contextFiles: { case: ["main.csx"] },
      guardsByFile: {},
    },
    2,
  );
  const model = {
    deltaDecorations: () => [],
    isDisposed: () => false,
    getDecorationRange: () => null,
  } as unknown as editor.ITextModel;
  expect(cache.attach("main.csx", model, [])).toBe(true);
  const position = { lineNumber: 1, column: 1 } as Position;
  expect(cache.symbols("main.csx", position, 2)?.map((s) => s.name)).toEqual(["Foo", "foo"]);
  expect(cache.symbols("main.csx", position, 1)).toBeUndefined();
  cache.clear();
});
