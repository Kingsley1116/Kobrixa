import type { editor, IRange, languages, CancellationToken } from "monaco-editor";
import { basicPlusLineIndentation } from "@kobrixa/basic-plus/language";

/** Read the prefix for context, but edit only leading whitespace in the requested lines. */
export function basicPlusRangeFormattingEdits(
  model: Pick<editor.ITextModel, "getLineContent">,
  range: IRange,
  options: Pick<languages.FormattingOptions, "tabSize">,
  token?: CancellationToken,
): languages.TextEdit[] {
  const lastLine =
    range.endLineNumber > range.startLineNumber && range.endColumn === 1
      ? range.endLineNumber - 1
      : range.endLineNumber;
  const indentSize = options.tabSize === 4 ? 4 : 2;
  const edits: languages.TextEdit[] = [];
  let depth = 0;
  for (let lineNumber = 1; lineNumber <= lastLine; lineNumber++) {
    if (token?.isCancellationRequested) return [];
    const line = model.getLineContent(lineNumber);
    const state = basicPlusLineIndentation(line, depth);
    depth = state.nextIndent;
    if (lineNumber < range.startLineNumber) continue;
    const leading = line.match(/^[\t ]*/)![0];
    const text = line.length === leading.length ? "" : " ".repeat(state.indent * indentSize);
    if (leading === text) continue;
    edits.push({
      range: {
        startLineNumber: lineNumber,
        startColumn: 1,
        endLineNumber: lineNumber,
        endColumn: leading.length + 1,
      },
      text,
    });
  }
  return edits;
}
