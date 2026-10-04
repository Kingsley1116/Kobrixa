export interface WorkspaceSearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface WorkspaceSearchRequest extends WorkspaceSearchOptions {
  overlays: Record<string, string>;
}

export interface WorkspaceSearchMatch {
  /** UTF-16 offsets into the exact source, including a leading BOM and CRLF. */
  start: number;
  end: number;
  /** One-based UTF-16 source positions. The first-line BOM occupies a column. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** A bounded first-line preview; ellipses indicate clipped text. */
  lineText: string;
}

export interface WorkspaceSearchFile {
  path: string;
  content: string;
  /** Revision of disk content, even when content comes from an unsaved overlay. */
  revision: string | null;
  matches: WorkspaceSearchMatch[];
}

export interface WorkspaceSearchResult {
  files: WorkspaceSearchFile[];
  matchCount: number;
  truncated: boolean;
  skipped: string[];
}

export function isSearchableFile(path: string): boolean {
  return /\.(bp|bpi|bpm|json)$/i.test(path);
}

const wordCharacter = /[\p{L}\p{N}\p{M}_]/u;

function precedingCharacter(content: string, offset: number): string {
  if (offset === 0) return "";
  const low = content.charCodeAt(offset - 1);
  const high = content.charCodeAt(offset - 2);
  return content.slice(
    offset - (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1),
    offset,
  );
}

function followingCharacter(content: string, offset: number): string {
  const point = content.codePointAt(offset);
  return point === undefined ? "" : String.fromCodePoint(point);
}

export function findSearchMatches(
  content: string,
  options: WorkspaceSearchOptions,
  limit = 2000,
): WorkspaceSearchMatch[] {
  if (!options.query || limit <= 0) return [];
  // Escaping keeps the query literal; Unicode case folding preserves source offsets.
  const pattern = new RegExp(
    options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    options.caseSensitive ? "gu" : "giu",
  );
  const starts = [0];
  const endings: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "\r" && character !== "\n") continue;
    endings.push(index);
    if (character === "\r" && content[index + 1] === "\n") index += 1;
    starts.push(index + 1);
  }
  endings.push(content.length);
  const position = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  };
  const matches: WorkspaceSearchMatch[] = [];
  for (
    let found = pattern.exec(content);
    found && matches.length < limit;
    found = pattern.exec(content)
  ) {
    const start = found.index;
    const end = start + found[0].length;
    if (
      options.wholeWord &&
      (wordCharacter.test(precedingCharacter(content, start)) ||
        wordCharacter.test(followingCharacter(content, end)))
    )
      continue;
    const first = position(start);
    const last = position(end);
    const lineStart = starts[first.line - 1]!;
    const lineEnd = endings[first.line - 1]!;
    const previewStart = Math.max(lineStart, start - 120);
    const previewEnd = Math.min(lineEnd, previewStart + 500);
    matches.push({
      start,
      end,
      startLine: first.line,
      startColumn: first.column,
      endLine: last.line,
      endColumn: last.column,
      lineText:
        (previewStart > lineStart ? "…" : "") +
        content.slice(previewStart, previewEnd) +
        (previewEnd < lineEnd ? "…" : ""),
    });
  }
  return matches;
}

export function replaceSearchMatches(file: WorkspaceSearchFile, replacement: string): string {
  let previous = 0;
  const parts: string[] = [];
  for (const match of file.matches) {
    if (match.start < previous || match.end <= match.start || match.end > file.content.length)
      throw new Error("Search matches no longer describe a valid source range.");
    parts.push(file.content.slice(previous, match.start), replacement);
    previous = match.end;
  }
  parts.push(file.content.slice(previous));
  return parts.join("");
}
