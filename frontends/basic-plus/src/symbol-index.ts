import type { SourceRange } from "@kobrixa/compiler";

export interface BasicPlusLocation {
  file: string;
  range: SourceRange;
}
export interface BasicPlusParameter {
  name: string;
  type: string;
  direction: "in" | "out";
}
export interface BasicPlusSymbol {
  /** Stable across edits that move a declaration without changing its name or owner. */
  id: string;
  context: string;
  name: string;
  kind: "function" | "sub" | "method" | "variable" | "parameter" | "label";
  scope: "global" | "local" | "parameter" | "builtin";
  scopeId: string;
  type: string;
  declaration?: BasicPlusLocation;
  parameters?: BasicPlusParameter[];
  aliases: string[];
  documentation?: string;
}
export interface BasicPlusOccurrence extends BasicPlusLocation {
  symbolId: string;
  context: string;
  declaration: boolean;
}
export interface BasicPlusScope {
  id: string;
  context: string;
  location?: BasicPlusLocation;
}
export interface BasicPlusSymbolIndex {
  symbols: Record<string, BasicPlusSymbol>;
  occurrencesByFile: Record<string, BasicPlusOccurrence[]>;
  scopes: BasicPlusScope[];
  fileContexts: Record<string, string>;
  contextFiles: Record<string, string[]>;
  invalidContexts: string[];
  /** Exact analyzed text, including unopened dependencies and unsaved overlays. */
  sources: Record<string, string>;
}
export function emptySymbolIndex(): BasicPlusSymbolIndex {
  return {
    symbols: Object.create(null),
    occurrencesByFile: Object.create(null),
    scopes: [],
    fileContexts: Object.create(null),
    contextFiles: Object.create(null),
    invalidContexts: [],
    sources: Object.create(null),
  };
}
