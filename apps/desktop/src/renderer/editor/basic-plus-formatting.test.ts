import { describe, expect, it, vi } from "vitest";
import type { CancellationToken, IRange } from "monaco-editor";
import { basicPlusRangeFormattingEdits } from "./basic-plus-formatting.js";

function formatRange(source: string, range: IRange, tabSize = 2) {
  const lines = source.split("\n");
  const model = { getLineContent: vi.fn((line: number) => lines[line - 1]!) };
  const edits = basicPlusRangeFormattingEdits(model, range, { tabSize });
  for (const { range, text } of edits) {
    expect(range.startColumn).toBe(1);
    expect(range.endLineNumber).toBe(range.startLineNumber);
    const index = range.startLineNumber - 1;
    expect(lines[index]!.slice(0, range.endColumn - 1)).toMatch(/^[\t ]*$/);
    lines[index] = text + lines[index]!.slice(range.endColumn - 1);
  }
  return { value: lines.join("\n"), edits, read: model.getLineContent };
}

describe("Basic+ range formatting", () => {
  it.each([2, 4])(
    "uses the surrounding blocks with %i spaces and preserves outside lines",
    (tabSize) => {
      const source =
        "If True Then ' outer\nWhile True\nLCD.Clear()  \nElsewhere = 1\nEndWhile\n      EndIf\n   trailing = 1";
      const range = { startLineNumber: 2, startColumn: 4, endLineNumber: 6, endColumn: 1 };
      const result = formatRange(source, range, tabSize);
      expect(result.value).toBe(
        [
          "If True Then ' outer",
          `${" ".repeat(tabSize)}While True`,
          `${" ".repeat(tabSize * 2)}LCD.Clear()  `,
          `${" ".repeat(tabSize * 2)}Elsewhere = 1`,
          `${" ".repeat(tabSize)}EndWhile`,
          "      EndIf",
          "   trailing = 1",
        ].join("\n"),
      );
      expect(result.read.mock.calls.map(([line]) => line)).toEqual([1, 2, 3, 4, 5]);
      expect(formatRange(result.value, range, tabSize).edits).toEqual([]);
    },
  );

  it("includes a partially selected last line and preserves existing text on both ends", () => {
    const source =
      'If True\ncaption = "prefix pasted suffix"  \nElse \' comment\nLCD.Clear()\nEndIf';
    const range = { startLineNumber: 2, startColumn: 19, endLineNumber: 3, endColumn: 3 };
    expect(formatRange(source, range).value).toBe(
      'If True\n  caption = "prefix pasted suffix"  \nElse \' comment\nLCD.Clear()\nEndIf',
    );
  });

  it("formats the current line for an empty range and clears whitespace-only selected lines", () => {
    const source = "If True\n\t\tLCD.Clear()\n    \nEndIf";
    expect(
      formatRange(source, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 })
        .value,
    ).toBe("If True\n  LCD.Clear()\n    \nEndIf");
    expect(
      formatRange(source, { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 1 })
        .value,
    ).toBe("If True\n\t\tLCD.Clear()\n\nEndIf");
  });

  it("returns no partial edits after cancellation", () => {
    let cancelled = false;
    const model = {
      getLineContent: vi.fn(() => {
        cancelled = true;
        return "If True";
      }),
    };
    const token = {
      get isCancellationRequested() {
        return cancelled;
      },
    } as CancellationToken;
    expect(
      basicPlusRangeFormattingEdits(
        model,
        {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 3,
          endColumn: 1,
        },
        { tabSize: 2 },
        token,
      ),
    ).toEqual([]);
    expect(model.getLineContent).toHaveBeenCalledTimes(1);
  });
});
