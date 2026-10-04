import type { Diagnostic, SourceRange } from "@kobrixa/compiler";
import { parse, type BasicPlusSyntaxFixCandidate, type BasicPlusSyntaxFixKind } from "./parser.js";

export interface BasicPlusQuickFix {
  id: string;
  titleKey: BasicPlusSyntaxFixKind;
  edits: Array<{ range: SourceRange; newText: string }>;
}

type SelectedDiagnostic = Pick<Diagnostic, "code" | "range" | "helpKey">;

const fixableCodes = new Set([
  "BP1013",
  "BP1014",
  "BP1015",
  "BP1024",
  "BP1030",
  "BP1031",
  "BP1033",
  "BP1034",
  "BP1035",
  "BP1040",
  "BP1043",
]);
// Quick fixes run on demand in the language worker, with at most two parses of
// one bounded source snapshot, never one project analysis per candidate.
const maximumSourceLength = 1_000_000;

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") offsets.push(index + 1);
  return offsets;
}

function sameDiagnostic(left: SelectedDiagnostic, right: SelectedDiagnostic): boolean {
  return (
    left.code === right.code &&
    left.helpKey === right.helpKey &&
    left.range.startLine === right.range.startLine &&
    left.range.startColumn === right.range.startColumn &&
    left.range.endLine === right.range.endLine &&
    left.range.endColumn === right.range.endColumn
  );
}

function diagnosticKey(diagnostic: Diagnostic, offset: number): string {
  return `${diagnostic.code}:${diagnostic.helpKey ?? ""}:${offset}`;
}

function insertionRange(offsets: number[], offset: number): SourceRange {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  const column = offset - offsets[low]! + 1;
  return { startLine: low + 1, startColumn: column, endLine: low + 1, endColumn: column };
}

function blockEndText(
  source: string,
  offsets: number[],
  candidates: BasicPlusSyntaxFixCandidate[],
): string {
  const newline = /\r?\n/.exec(source)?.[0] ?? "\n";
  const endsWithNewline = source.endsWith("\n");
  const lines = candidates.map((candidate) => {
    const opening = candidate.openingSpan!;
    const prefix = source
      .slice(offsets[opening.start.line - 1]!, opening.start.offset)
      .replace(/^\ufeff/, "");
    return `${/^[\t ]*/.exec(prefix)![0]}${candidate.text}`;
  });
  return `${endsWithNewline ? "" : newline}${lines.join(newline)}${endsWithNewline ? newline : ""}`;
}

/** Offer only parser-proven insertions for the selected, current diagnostic. */
export function getBasicPlusQuickFixes(
  file: string,
  source: string,
  diagnostic: SelectedDiagnostic,
  signal?: AbortSignal,
): BasicPlusQuickFix[] {
  signal?.throwIfAborted();
  if (!fixableCodes.has(diagnostic.code) || source.length > maximumSourceLength) return [];
  const result = parse(file, source);
  signal?.throwIfAborted();
  const selected = result.syntaxFixes.find((candidate) =>
    sameDiagnostic(candidate.diagnostic, diagnostic),
  );
  if (!selected) return [];

  let candidates = [selected];
  if (selected.titleKey === "close-blocks") {
    candidates = result.syntaxFixes.filter((candidate) => candidate.titleKey === "close-blocks");
    // The recursive parser emits missing endings from the innermost block out.
    // A mismatched explicit ending produces another syntax error and is refused.
    if (
      candidates.length !== result.diagnostics.length ||
      candidates.some((candidate) => candidate.offset !== source.length || !candidate.openingSpan)
    )
      return [];
  } else {
    if (selected.titleKey === "insert-parenthesis")
      candidates = result.syntaxFixes.filter(
        (candidate) =>
          candidate.titleKey === selected.titleKey && candidate.offset === selected.offset,
      );
    const safeDiagnostics = new Set(result.syntaxFixes.map((candidate) => candidate.diagnostic));
    if (
      result.diagnostics.some(
        (entry) =>
          /^BP100[123]$/.test(entry.code) ||
          (entry.range.startLine === diagnostic.range.startLine && !safeDiagnostics.has(entry)),
      )
    )
      return [];
  }

  const offsets = lineOffsets(source);
  const offset = selected.offset;
  const newText =
    selected.titleKey === "close-blocks"
      ? blockEndText(source, offsets, candidates)
      : candidates.map((candidate) => candidate.text).join("");
  const changed = source.slice(0, offset) + newText + source.slice(offset);
  signal?.throwIfAborted();
  const checked = parse(file, changed);
  signal?.throwIfAborted();

  // Compare source positions after undoing the insertion's offset shift. Merely
  // checking code counts would miss a new error of the same kind elsewhere.
  const removed = new Set(candidates.map((candidate) => candidate.diagnostic));
  const remaining = new Map<string, number>();
  for (const entry of result.diagnostics) {
    if (removed.has(entry)) continue;
    const position = offsets[entry.range.startLine - 1]! + entry.range.startColumn - 1;
    const key = diagnosticKey(entry, position);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const changedOffsets = lineOffsets(changed);
  for (const entry of checked.diagnostics) {
    const position = changedOffsets[entry.range.startLine - 1]! + entry.range.startColumn - 1;
    if (position >= offset && position < offset + newText.length) return [];
    const originalPosition = position < offset ? position : position - newText.length;
    const key = diagnosticKey(entry, originalPosition);
    const count = remaining.get(key) ?? 0;
    if (!count) return [];
    remaining.set(key, count - 1);
  }

  return [
    {
      id: `${selected.titleKey}:${diagnostic.code}:${offset}`,
      titleKey: selected.titleKey,
      edits: [{ range: insertionRange(offsets, offset), newText }],
    },
  ];
}
