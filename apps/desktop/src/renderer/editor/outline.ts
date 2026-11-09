import type { SourceRange } from "@kobrixa/compiler";
import type { LanguageDocumentSymbol } from "../../shared/language-types.js";
export type OutlineItem = LanguageDocumentSymbol;
const contains = (range: SourceRange, line: number, column: number): boolean =>
  (line > range.startLine || (line === range.startLine && column >= range.startColumn)) &&
  (line < range.endLine || (line === range.endLine && column <= range.endColumn));

/** Innermost outline items containing the position, outermost first. */
export function outlinePath(items: OutlineItem[], line: number, column: number): OutlineItem[] {
  for (const entry of items)
    if (entry.children.length && contains(entry.range, line, column))
      return [entry, ...outlinePath(entry.children, line, column)];
  return [];
}
