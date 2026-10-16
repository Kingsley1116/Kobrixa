import * as monaco from "monaco-editor";
import {
  BASIC_PLUS_API_COMPLETIONS,
  BASIC_PLUS_KEYWORDS,
  BASIC_PLUS_INDENTATION_RULES,
} from "@kobrixa/basic-plus/language";
import { editingContext } from "@kobrixa/basic-plus/intelligence";
import type { LanguageSymbol } from "../../../../shared/language-types.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
export function basicPlusCompletions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  candidates: readonly LanguageSymbol[],
  token: monaco.CancellationToken,
): monaco.languages.CompletionList {
  if (model.isDisposed() || token.isCancellationRequested) return { suggestions: [] };
  const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  if (editingContext(before).inLiteral) return { suggestions: [] };
  const prefix = before.match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? "";
  const after =
    model
      .getLineContent(position.lineNumber)
      .slice(position.column - 1)
      .match(/^[A-Za-z0-9_.]*/)?.[0] ?? "";
  const range = new monaco.Range(
    position.lineNumber,
    position.column - prefix.length,
    position.lineNumber,
    position.column + after.length,
  );
  const normalized = prefix.toLowerCase();
  const suggestions: monaco.languages.CompletionItem[] = [];
  for (const symbol of candidates)
    for (const { text: label, detail } of symbol.labels) {
      if (!label.toLowerCase().startsWith(normalized)) continue;
      suggestions.push({
        label,
        range,
        insertText: label,
        detail,
        kind:
          symbol.kind === "parameter" || symbol.kind === "variable"
            ? monaco.languages.CompletionItemKind.Variable
            : symbol.kind === "label"
              ? monaco.languages.CompletionItemKind.Reference
              : monaco.languages.CompletionItemKind.Function,
        sortText: `0-${label.toLowerCase()}`,
      });
    }
  if (!prefix.includes(".")) {
    const line = model.getLineContent(position.lineNumber);
    const leading = before.slice(0, range.startColumn - 1);
    let closingIndent: string | undefined;
    for (const label of BASIC_PLUS_KEYWORDS)
      if (label.toLowerCase().startsWith(normalized)) {
        const item: monaco.languages.CompletionItem = {
          label,
          range,
          insertText: label,
          kind: monaco.languages.CompletionItemKind.Keyword,
          sortText: `2-${label}`,
        };
        if (
          /^[\t ]*$/.test(leading) &&
          BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(label) &&
          !BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(line)
        ) {
          closingIndent ??=
            basicPlusRangeFormattingEdits(
              {
                getLineContent: (number) =>
                  number === position.lineNumber
                    ? leading + label + line.slice(range.endColumn - 1)
                    : model.getLineContent(number),
              },
              range,
              model.getOptions(),
              token,
            )[0]?.text ?? leading;
          if (closingIndent !== leading) {
            item.range = new monaco.Range(
              position.lineNumber,
              1,
              position.lineNumber,
              range.endColumn,
            );
            item.insertText = closingIndent + label;
            item.filterText = leading + label;
          }
        }
        suggestions.push(item);
      }
  }
  for (const api of BASIC_PLUS_API_COMPLETIONS)
    if (api.label.toLowerCase().startsWith(normalized))
      suggestions.push({
        label: api.label,
        range,
        kind: monaco.languages.CompletionItemKind.Method,
        insertText: api.insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail: api.signature,
        documentation: { value: api.documentation },
        sortText: `1-${api.label}`,
      });
  return { suggestions };
}
