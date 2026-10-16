import type { editor, languages, Position, IRange, CancellationToken } from "monaco-editor";
import type { LanguageSymbol, SemanticLegend } from "../../shared/language-types.js";
export interface LanguageCompanion {
  monacoLanguage: string;
  legend: SemanticLegend;
  triggerCharacters: string[];
  signatureTriggers: string[];
  signatureRetriggers: string[];
  completions(
    model: editor.ITextModel,
    position: Position,
    candidates: readonly LanguageSymbol[],
    token: CancellationToken,
  ): languages.CompletionList;
  structuralChange(model: editor.ITextModel, event: editor.IModelContentChangedEvent): boolean;
  formatSource(source: string, indentSize: 2 | 4): string;
  rangeFormatting(
    model: editor.ITextModel,
    range: IRange,
    options: languages.FormattingOptions,
    token: CancellationToken,
  ): languages.TextEdit[];
}
