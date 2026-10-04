import { isSearchableFile } from "../../shared/workspace-search.js";

export interface QuickOpenPosition {
  line: number;
  column: number;
}

export interface QuickOpenMatch {
  file: string;
  positions: number[];
  score: number;
}

export function parseQuickOpenQuery(value: string): {
  query: string;
  position?: QuickOpenPosition;
} {
  const query = value.trim();
  const suffix = /:(\d+)(?::(\d+))?$/.exec(query);
  if (!suffix) return { query };
  const line = Number(suffix[1]);
  const column = Number(suffix[2] ?? 1);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1)
    return { query };
  return { query: query.slice(0, suffix.index).trim(), position: { line, column } };
}

function subsequence(text: string, query: string): number[] | undefined {
  const positions: number[] = [];
  let offset = 0;
  for (const character of query) {
    const found = text.indexOf(character, offset);
    if (found === -1) return undefined;
    positions.push(found);
    offset = found + character.length;
  }
  return positions;
}

function matchFile(file: string, query: string): QuickOpenMatch | undefined {
  const path = file.replaceAll("\\", "/").toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const name = path.slice(nameStart);
  const stem = name.slice(0, name.lastIndexOf("."));
  let score = 0;
  let positions: number[] | undefined;
  const nameIndex = name.indexOf(query);
  const pathIndex = path.indexOf(query);
  if (nameIndex !== -1) {
    score = name === query ? 11000 : stem === query ? 10500 : nameIndex === 0 ? 10000 : 8000;
    positions = Array.from({ length: query.length }, (_, index) => nameStart + nameIndex + index);
  } else if (pathIndex !== -1) {
    score = path === query ? 12000 : pathIndex === 0 ? 9000 : 7000;
    positions = Array.from({ length: query.length }, (_, index) => pathIndex + index);
  } else {
    const namePositions = subsequence(name, query);
    if (namePositions) {
      score = 6000;
      positions = namePositions.map((position) => nameStart + position);
    } else {
      score = 4000;
      positions = subsequence(path, query);
    }
  }
  if (!positions) return undefined;
  // Prefer compact matches and word starts among otherwise equivalent results.
  const gaps = positions.at(-1)! - positions[0]! + 1 - query.length;
  const boundaries = positions.filter(
    (position) => position === 0 || /[/_.\-\s]/.test(path[position - 1]!),
  ).length;
  return { file, positions, score: score - Math.min(gaps, 500) + Math.min(boundaries, 20) * 2 };
}

/** Only ranks paths. Typing or changing selection never reads files or changes editor models. */
export function quickOpenMatches(
  files: readonly string[],
  value: string,
  options: {
    activeFile?: string | undefined;
    recentFiles?: readonly string[] | undefined;
    limit?: number;
  } = {},
): { matches: QuickOpenMatch[]; total: number; position?: QuickOpenPosition } {
  const parsed = parseQuickOpenQuery(value);
  const query = parsed.query.replaceAll("\\", "/").toLowerCase();
  const recent = new Map<string, number>();
  for (const file of [options.activeFile, ...(options.recentFiles ?? [])])
    if (file && !recent.has(file)) recent.set(file, recent.size);
  const matches = [...new Set(files)].filter(isSearchableFile).flatMap((file) => {
    if (!query) return [{ file, positions: [], score: 0 }];
    const match = matchFile(file, query);
    return match ? [match] : [];
  });
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      (recent.get(a.file) ?? Infinity) - (recent.get(b.file) ?? Infinity) ||
      (query ? a.file.length - b.file.length : 0) ||
      a.file.localeCompare(b.file, "en", { sensitivity: "base", numeric: true }) ||
      a.file.localeCompare(b.file, "en"),
  );
  return {
    matches: matches.slice(0, options.limit ?? 100),
    total: matches.length,
    ...(parsed.position ? { position: parsed.position } : {}),
  };
}
