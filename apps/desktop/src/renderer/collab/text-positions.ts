import type { IPosition } from "monaco-editor";

/** Monaco normalizes EOLs; Y.Text retains the source's original line endings. */
export function textPositionAt(text: string, offset: number): IPosition {
  let lineNumber = 1;
  let lineStart = text.startsWith("\uFEFF") ? 1 : 0;
  const limit = Math.min(offset, text.length);
  for (let index = lineStart; index < limit; index++) {
    if (text[index] === "\r" || text[index] === "\n") {
      if (text[index] === "\r" && text[index + 1] === "\n") index++;
      lineNumber++;
      lineStart = index + 1;
    }
  }
  return { lineNumber, column: Math.max(1, limit - lineStart + 1) };
}

export function textOffsetAt(text: string, position: IPosition): number {
  let line = 1;
  let index = text.startsWith("\uFEFF") ? 1 : 0;
  while (index < text.length && line < position.lineNumber) {
    const char = text[index++];
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index] === "\n") index++;
      line++;
    }
  }
  return Math.min(text.length, index + position.column - 1);
}
