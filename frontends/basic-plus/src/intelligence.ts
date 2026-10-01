import type { SourceRange } from "@kobrixa/compiler";
import type { BasicPlusProjectAnalysis } from "./analysis.js";
import type {
  BasicPlusSymbolIndex,
  BasicPlusSymbol,
  BasicPlusOccurrence,
  BasicPlusLocation,
} from "./symbol-index.js";
import { BASIC_PLUS_API_COMPLETIONS, BASIC_PLUS_KEYWORDS } from "./language.js";
export type * from "./symbol-index.js";

export function contains(
  range: SourceRange,
  line: number,
  column: number,
  includeEnd = false,
): boolean {
  return (
    (line > range.startLine || (line === range.startLine && column >= range.startColumn)) &&
    (line < range.endLine ||
      (line === range.endLine &&
        (includeEnd ? column <= range.endColumn : column < range.endColumn)))
  );
}
export function occurrenceAt(
  index: BasicPlusSymbolIndex,
  file: string,
  line: number,
  column: number,
): BasicPlusOccurrence | undefined {
  const items = (index.occurrencesByFile[file] ?? []).filter(
    (item) => item.context === index.fileContexts[file],
  );
  return (
    items.find((item) => contains(item.range, line, column)) ??
    items.find((item) => contains(item.range, line, column, true))
  );
}
export function visibleSymbols(
  index: BasicPlusSymbolIndex,
  file: string,
  line: number,
  column: number,
): BasicPlusSymbol[] {
  const context = index.fileContexts[file];
  const scope = index.scopes.find(
    (scope) =>
      scope.context === context &&
      scope.location?.file === file &&
      contains(scope.location.range, line, column, true),
  );
  const candidates = Object.values(index.symbols).filter(
    (symbol) =>
      symbol.context === context &&
      symbol.scope !== "builtin" &&
      (symbol.scope === "global" || symbol.scopeId === scope?.id),
  );
  // Parameters and locals shadow global variables, independently of callable names.
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => Number(a.scope === "global") - Number(b.scope === "global"))
    .filter((symbol) => {
      const key = `${["function", "sub"].includes(symbol.kind) ? "call" : symbol.kind === "label" ? "label" : "value"}:${symbol.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export function symbolSignature(symbol: BasicPlusSymbol, name = symbol.name): string {
  if (symbol.parameters) {
    const parameters = symbol.parameters
      .map((p) => (symbol.kind === "method" ? p.type : `${p.direction} ${p.type} ${p.name}`))
      .join(", ");
    return `${name}(${parameters})${symbol.type === "void" ? "" : `: ${symbol.type}`}`;
  }
  return `${symbol.scope} ${symbol.type} ${name}`;
}
function locationKey(location: BasicPlusLocation): string {
  return JSON.stringify([
    location.file,
    location.range.startLine,
    location.range.startColumn,
    location.range.endLine,
    location.range.endColumn,
  ]);
}
export function relatedSymbolIds(
  index: BasicPlusSymbolIndex,
  symbol: BasicPlusSymbol,
): Set<string> {
  if (!symbol.declaration) return new Set([symbol.id]);
  const key = locationKey(symbol.declaration);
  return new Set(
    Object.values(index.symbols)
      .filter(
        (candidate) =>
          candidate.kind === symbol.kind &&
          candidate.declaration &&
          locationKey(candidate.declaration) === key,
      )
      .map((candidate) => candidate.id),
  );
}
export function symbolReferences(
  index: BasicPlusSymbolIndex,
  symbol: BasicPlusSymbol,
  includeDeclaration = true,
): BasicPlusOccurrence[] {
  const ids = relatedSymbolIds(index, symbol);
  const unique = new Map<string, BasicPlusOccurrence>();
  for (const occurrences of Object.values(index.occurrencesByFile))
    for (const item of occurrences)
      if (ids.has(item.symbolId) && (includeDeclaration || !item.declaration))
        unique.set(locationKey(item), item);
  return [...unique.values()];
}
export interface BasicPlusRenameEdit extends BasicPlusLocation {
  text: string;
  expected: string;
}
export type BasicPlusRenameResult =
  { edits: BasicPlusRenameEdit[]; rejectReason?: never } | { edits?: never; rejectReason: string };
export function prepareSymbolRename(
  analysis: BasicPlusProjectAnalysis,
  file: string,
  line: number,
  column: number,
  newName: string,
): BasicPlusRenameResult {
  const { index } = analysis;
  const item = occurrenceAt(index, file, line, column);
  const symbol = item && index.symbols[item.symbolId];
  if (!symbol?.declaration || symbol.scope === "builtin")
    return { rejectReason: "Only user-defined symbols can be renamed." };
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) ||
    BASIC_PLUS_KEYWORDS.some((keyword) => keyword.toLowerCase() === newName.toLowerCase())
  )
    return { rejectReason: "Use a valid identifier that is not a BASIC Plus keyword." };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol.name))
    return { rejectReason: "Qualified declarations cannot be renamed safely." };
  if (analysis.diagnostics.some((d) => d.severity === "error"))
    return { rejectReason: "Resolve project errors before renaming a symbol." };
  const ids = relatedSymbolIds(index, symbol);
  const peers = [...ids].map((id) => index.symbols[id]!);
  const contexts = new Set(peers.map((peer) => peer.context));
  if (index.invalidContexts.some((context) => contexts.has(context)))
    return { rejectReason: "Resolve errors in programs using this symbol before renaming it." };
  const names = new Set(
    peers
      .flatMap((peer) =>
        peer.aliases.map((alias) => alias.slice(0, alias.length - peer.name.length) + newName),
      )
      .map((name) => name.toLowerCase()),
  );
  names.add(newName.toLowerCase());
  const callable = ["function", "sub"].includes(symbol.kind);
  if (
    callable &&
    [...BASIC_PLUS_API_COMPLETIONS.map((api) => api.label.toLowerCase()), "thread.run"].some(
      (name) => names.has(name),
    )
  )
    return { rejectReason: "The new function name would conflict with a built-in method." };
  for (const candidate of Object.values(index.symbols)) {
    if (ids.has(candidate.id) || !contexts.has(candidate.context)) continue;
    const sameKind = callable
      ? ["function", "sub", "method"].includes(candidate.kind)
      : symbol.kind === "label"
        ? candidate.kind === "label"
        : ["variable", "parameter"].includes(candidate.kind);
    if (sameKind && candidate.aliases.some((alias) => names.has(alias.toLowerCase())))
      return {
        rejectReason: `The name '${newName}' conflicts with an existing ${candidate.kind}.`,
      };
  }
  const references = symbolReferences(index, symbol);
  const targetLocations = new Set(references.map(locationKey));
  for (const occurrences of Object.values(index.occurrencesByFile))
    for (const occurrence of occurrences)
      if (targetLocations.has(locationKey(occurrence)) && !ids.has(occurrence.symbolId))
        return {
          rejectReason:
            "A shared file resolves this name differently in another program. Rename it in an unambiguous context.",
        };
  return {
    edits: references.map((reference) => {
      const { file, range } = reference;
      const expected = index.sources[file]!.split("\n")[range.startLine - 1]!.slice(
        range.startColumn - 1,
        range.endColumn - 1,
      );
      return { file, range, expected, text: newName };
    }),
  };
}

/** Current-line scanner, following BASIC Plus's apostrophe comments and doubled quotes. */
export function editingContext(beforeCursor: string): {
  inLiteral: boolean;
  call?: { name: string; argument: number };
} {
  let quoted = false;
  const stack: Array<{ name?: string; argument: number; bracket: string }> = [];
  for (let i = 0; i < beforeCursor.length; i++) {
    const ch = beforeCursor[i];
    if (ch === '"') {
      if (quoted && beforeCursor[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "'") return { inLiteral: true };
    if (ch === "(" || ch === "[") {
      const name =
        ch === "(" ? beforeCursor.slice(0, i).match(/([A-Za-z_][\w.]*)\s*$/)?.[1] : undefined;
      stack.push({ ...(name ? { name } : {}), argument: 0, bracket: ch });
    } else if (ch === ")" || ch === "]") stack.pop();
    else if (ch === "," && stack.at(-1)?.bracket === "(") stack.at(-1)!.argument++;
  }
  const call = [...stack].reverse().find((item) => item.name);
  return {
    inLiteral: quoted,
    ...(call?.name ? { call: { name: call.name, argument: call.argument } } : {}),
  };
}
