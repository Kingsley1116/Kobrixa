import type { SourceRange } from "@kobrixa/compiler";
import {
  contains,
  type BasicPlusSymbol,
  type BasicPlusSymbolIndex,
} from "@kobrixa/basic-plus/intelligence";

export interface OutlineItem {
  name: string;
  kind: "sub" | "function" | "method" | "variable" | "label";
  /** Whole declaration (a Sub's body for callables); the name for everything else. */
  range: SourceRange;
  selectionRange: SourceRange;
  children: OutlineItem[];
}

const CALLABLE = new Set(["sub", "function", "method"]);
const before = (a: SourceRange, b: SourceRange) =>
  a.startLine - b.startLine || a.startColumn - b.startColumn;

/** Declarations in one file: global variables, labels and callables with their locals. */
export function documentOutline(index: BasicPlusSymbolIndex, file: string): OutlineItem[] {
  const context = index.fileContexts[file];
  const declared = Object.values(index.symbols).filter(
    (
      symbol,
    ): symbol is BasicPlusSymbol & { declaration: NonNullable<BasicPlusSymbol["declaration"]> } =>
      symbol.context === context &&
      symbol.scope !== "builtin" &&
      symbol.kind !== "parameter" &&
      symbol.declaration?.file === file,
  );
  const item = (
    symbol: (typeof declared)[number],
    range = symbol.declaration.range,
  ): OutlineItem => ({
    name: symbol.name,
    kind: symbol.kind as OutlineItem["kind"],
    range,
    selectionRange: symbol.declaration.range,
    children: [],
  });
  const roots: OutlineItem[] = [];
  const bodies = new Map<string, OutlineItem>();
  for (const symbol of declared.filter((symbol) => CALLABLE.has(symbol.kind))) {
    const { startLine, startColumn } = symbol.declaration.range;
    const scope = index.scopes.find(
      (scope) =>
        scope.context === context &&
        scope.location?.file === file &&
        contains(scope.location.range, startLine, startColumn, true),
    );
    const callable = item(symbol, scope?.location?.range);
    if (scope) bodies.set(scope.id, callable);
    roots.push(callable);
  }
  for (const symbol of declared.filter((symbol) => !CALLABLE.has(symbol.kind))) {
    const owner = bodies.get(symbol.scopeId);
    // A Function's result is a local named after it; listing it again adds noise.
    if (owner && owner.name.toLowerCase() === symbol.name.toLowerCase()) continue;
    (owner?.children ?? roots).push(item(symbol));
  }
  const sort = (items: OutlineItem[]) => {
    items.sort((a, b) => before(a.selectionRange, b.selectionRange));
    for (const entry of items) sort(entry.children);
    return items;
  };
  return sort(roots);
}

/** Innermost outline items containing the position, outermost first. */
export function outlinePath(items: OutlineItem[], line: number, column: number): OutlineItem[] {
  for (const entry of items)
    if (entry.children.length && contains(entry.range, line, column, true))
      return [entry, ...outlinePath(entry.children, line, column)];
  return [];
}
