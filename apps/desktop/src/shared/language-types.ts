import type { PublishedDiagnostic, SourceRange } from "@kobrixa/compiler";

export interface LanguageLocation {
  file: string;
  range: SourceRange;
}
export type LanguageSymbolKind =
  "function" | "method" | "variable" | "parameter" | "label" | "namespace";
export interface LanguageSymbol {
  id: string;
  name: string;
  kind: LanguageSymbolKind;
  signature: string;
  documentation?: string;
  location?: LanguageLocation;
  labels: Array<{ text: string; detail: string }>;
  /** Opaque provider-defined visibility and shadowing values. */
  group: string;
  shadowKey: string;
}
export interface LanguageOccurrence extends LanguageLocation {
  symbolId: string;
  context: string;
  declaration: boolean;
}
export interface LanguageScope {
  id: string;
  context: string;
  location?: LanguageLocation;
}
export interface SemanticToken {
  range: SourceRange;
  type: string;
  modifiers: string[];
}
export interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}
export interface LanguageDocumentSymbol {
  name: string;
  detail: string;
  kind: LanguageSymbolKind;
  range: SourceRange;
  selectionRange: SourceRange;
  children: LanguageDocumentSymbol[];
}
export interface LanguageIndex {
  symbols: Record<string, LanguageSymbol>;
  occurrencesByFile: Record<string, LanguageOccurrence[]>;
  sources: Record<string, string>;
  fileContexts: Record<string, string>;
  contextFiles: Record<string, string[]>;
  scopes: LanguageScope[];
  invalidContexts: string[];
}
/** Missing optional provider sections normalize to empty records at the adapter boundary. */
export interface LanguageAnalysis {
  diagnostics: PublishedDiagnostic[];
  index: LanguageIndex;
  tokensByFile: Record<string, SemanticToken[]>;
}
export interface CompletionIndex {
  symbols: Record<string, LanguageSymbol>;
  scopes: LanguageScope[];
  fileContexts: Record<string, string>;
  contextFiles: Record<string, string[]>;
  guardsByFile: Record<string, SourceRange[]>;
}
export interface QuickFix {
  id: string;
  title: { en: string; "zh-TW"?: string };
  edits: Array<{ range: SourceRange; newText: string }>;
}
export function emptyLanguageIndex(): LanguageIndex {
  return {
    symbols: Object.create(null),
    occurrencesByFile: Object.create(null),
    sources: Object.create(null),
    fileContexts: Object.create(null),
    contextFiles: Object.create(null),
    scopes: [],
    invalidContexts: [],
  };
}
