import type { BasicPlusCompletionIndex, BasicPlusSymbol } from "@kobrixa/basic-plus";
import type { SourceRange } from "@kobrixa/compiler";
import type { editor, IRange, Position } from "monaco-editor";

export interface CompletionChange {
  before: number;
  version: number;
  changes: readonly editor.IModelContentChange[];
  flush: boolean;
  structural?: boolean;
}
const structuralText = /\b(?:function|sub|endfunction|endsub|include|import)\b/i;
/** Inspect only the two edited boundary lines, including a keyword typed one letter at a time. */
export function structuralCompletionChange(
  model: editor.ITextModel,
  event: editor.IModelContentChangedEvent,
): boolean {
  let delta = 0;
  for (const change of [...event.changes].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
    if (structuralText.test(change.text)) return true;
    const start = change.rangeOffset + delta;
    for (const offset of [start, start + change.text.length]) {
      if (structuralText.test(model.getLineContent(model.getPositionAt(offset).lineNumber)))
        return true;
    }
    delta += change.text.length - change.rangeLength;
  }
  return false;
}
const asRange = (r: SourceRange): IRange => ({
  startLineNumber: r.startLine,
  startColumn: r.startColumn,
  endLineNumber: r.endLine,
  endColumn: r.endColumn,
});
const sourceRange = (r: IRange): SourceRange => ({
  startLine: r.startLineNumber,
  startColumn: r.startColumn,
  endLine: r.endLineNumber,
  endColumn: r.endColumn,
});

/** Rebase only completion candidates. Never use this for navigation or edits. */
export function rebaseCompletionRanges(
  scopes: SourceRange[],
  guards: SourceRange[],
  event: CompletionChange,
): { scopes: SourceRange[]; guards: SourceRange[] } | undefined {
  if (
    event.flush ||
    event.structural ||
    event.changes.some(
      (c) =>
        structuralText.test(c.text) ||
        guards.some(
          (g) => c.range.startLineNumber <= g.endLine && c.range.endLineNumber >= g.startLine,
        ),
    )
  )
    return;
  const move = (r: SourceRange, c: editor.IModelContentChange): SourceRange => {
    const inserted = c.text.split("\n");
    const endLine = c.range.startLineNumber + inserted.length - 1;
    const endColumn =
      inserted.length === 1 ? c.range.startColumn + c.text.length : inserted.at(-1)!.length + 1;
    const point = (line: number, column: number) => {
      if (
        line < c.range.startLineNumber ||
        (line === c.range.startLineNumber && column < c.range.startColumn)
      )
        return [line, column];
      if (
        line < c.range.endLineNumber ||
        (line === c.range.endLineNumber && column < c.range.endColumn)
      )
        return [endLine, endColumn];
      return [
        line + endLine - c.range.endLineNumber,
        line === c.range.endLineNumber ? column + endColumn - c.range.endColumn : column,
      ];
    };
    const [startLine, startColumn] = point(r.startLine, r.startColumn);
    const [lastLine, lastColumn] = point(r.endLine, r.endColumn);
    return {
      startLine: startLine!,
      startColumn: startColumn!,
      endLine: lastLine!,
      endColumn: lastColumn!,
    };
  };
  for (const change of [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    scopes = scopes.map((r) => move(r, change));
    guards = guards.map((r) => move(r, change));
  }
  return { scopes, guards };
}

/** Group symbols once per index; Monaco tracks only scope/guard ranges, not occurrences. */
export class CompletionCache {
  private index: BasicPlusCompletionIndex | undefined;
  private groups = new Map<string, BasicPlusSymbol[]>();
  private invalid = new Set<string>();
  private files = new Map<
    string,
    {
      model: editor.ITextModel;
      ids: string[];
      scopeIds: string[];
      ranges: SourceRange[];
      guards: SourceRange[];
    }
  >();
  update(index: BasicPlusCompletionIndex): void {
    this.clear();
    this.index = index;
    for (const symbol of Object.values(index.symbols)) {
      if (symbol.scope === "builtin") continue;
      const key = symbol.scope === "global" ? symbol.context : symbol.scopeId;
      let group = this.groups.get(key);
      if (!group) this.groups.set(key, (group = []));
      group.push(symbol);
    }
  }
  attach(file: string, model: editor.ITextModel, history: CompletionChange[]): boolean {
    const index = this.index;
    if (!index) return false;
    const context = index.fileContexts[file];
    if (!context) return false;
    const items = index.scopes.filter((s) => s.context === context && s.location?.file === file);
    let scopes = items.map((s) => s.location!.range);
    let guards = index.guardsByFile[file] ?? [];
    for (const event of history) {
      const mapped = rebaseCompletionRanges(scopes, guards, event);
      if (!mapped) {
        this.invalid.add(context);
        return false;
      }
      ({ scopes, guards } = mapped);
    }
    const ranges = [...scopes, ...guards].map(asRange);
    const ids = model.deltaDecorations(
      [],
      ranges.map((range) => ({
        range,
        options: { description: "basic-plus-completion-scope", stickiness: 1 },
      })),
    );
    this.files.set(file, { model, ids, scopeIds: items.map((s) => s.id), ranges: scopes, guards });
    return true;
  }
  changed(file: string, event: CompletionChange): void {
    const state = this.files.get(file);
    const context = this.index?.fileContexts[file];
    if (!state || !context) return;
    if (!rebaseCompletionRanges(state.ranges, state.guards, event)) this.invalid.add(context);
    const ranges = state.ids
      .map((id) => state.model.getDecorationRange(id))
      .filter((r) => r !== null)
      .map(sourceRange);
    state.ranges = ranges.slice(0, state.scopeIds.length);
    state.guards = ranges.slice(state.scopeIds.length);
  }
  invalidate(file: string): void {
    const context = this.index?.fileContexts[file];
    if (context) this.invalid.add(context);
  }
  symbols(file: string, position: Position): BasicPlusSymbol[] | undefined {
    const context = this.index?.fileContexts[file];
    const state = this.files.get(file);
    if (!context || !state || this.invalid.has(context)) return;
    const local = state.ids
      .slice(0, state.scopeIds.length)
      .findIndex((id) => state.model.getDecorationRange(id)?.containsPosition(position));
    const seen = new Set<string>();
    return [
      ...(this.groups.get(state.scopeIds[local] ?? "") ?? []),
      ...(this.groups.get(context) ?? []),
    ].filter((symbol) => {
      const key = `${symbol.kind === "function" || symbol.kind === "sub" ? "call" : symbol.kind === "label" ? "label" : "value"}:${symbol.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  enrich(symbols: Record<string, BasicPlusSymbol>): void {
    for (const group of this.groups.values())
      for (let i = 0; i < group.length; i++) {
        const precise = symbols[group[i]!.id];
        if (precise) group[i] = precise;
      }
  }
  clear(): void {
    for (const { model, ids } of this.files.values())
      if (!model.isDisposed()) model.deltaDecorations(ids, []);
    this.files.clear();
    this.groups.clear();
    this.invalid.clear();
    this.index = undefined;
  }
}
