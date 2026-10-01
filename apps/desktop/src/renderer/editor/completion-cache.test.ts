import { expect, it } from "vitest";
import type { editor } from "monaco-editor";
import {
  rebaseCompletionRanges,
  structuralCompletionChange,
  type CompletionChange,
} from "./completion-cache.js";

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
  expect(structuralCompletionChange(model, event)).toBe(true);
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
  for (const event of [
    change(3, "x"),
    change(7, "", 9),
    change(1, 'Import "lib"'),
    change(5, "EndFunction"),
    { ...change(4, "x"), flush: true },
  ])
    expect(rebaseCompletionRanges([scope], guards, event)).toBeUndefined();
});
