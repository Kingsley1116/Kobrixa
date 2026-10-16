import type { DiagnosticLocale } from "@kobrixa/compiler/diagnostic-help";
import type { Diagnostic } from "../../shared/api.js";
import {
  resolveDiagnosticHelp,
  localizeHelp,
  type PluginHelpCatalogView,
} from "../../shared/diagnostic-help.js";
import type { BasicPlusQuickFix } from "@kobrixa/basic-plus";

const fixTitles: Record<BasicPlusQuickFix["titleKey"], Record<DiagnosticLocale, string>> = {
  "insert-type-bracket": { "zh-TW": "補上型別陣列的 ]", en: "Insert ] in array type" },
  "insert-parenthesis": { "zh-TW": "補上右括號 )", en: "Insert closing parenthesis )" },
  "insert-for-equals": { "zh-TW": "補上 For 的 =", en: "Insert = in For statement" },
  "insert-for-to": { "zh-TW": "補上 For 的 To", en: "Insert To in For statement" },
  "close-blocks": { "zh-TW": "在檔尾補齊區塊結尾", en: "Close unfinished blocks at end of file" },
};
export const quickFixTitle = (
  key: BasicPlusQuickFix["titleKey"],
  locale: DiagnosticLocale,
): string => fixTitles[key][locale];
export function diagnosticSummary(
  diagnostic: Diagnostic,
  locale: DiagnosticLocale,
  catalog: PluginHelpCatalogView | undefined,
): string {
  const resolved = resolveDiagnosticHelp(diagnostic, catalog);
  return resolved ? localizeHelp(resolved, locale).title : diagnostic.message;
}
export function diagnosticMarkerMessage(
  diagnostic: Diagnostic,
  locale: DiagnosticLocale,
  catalog: PluginHelpCatalogView | undefined,
): string {
  const resolved = resolveDiagnosticHelp(diagnostic, catalog);
  if (!resolved) return `${diagnostic.code}: ${diagnostic.message}`;
  const text = localizeHelp(resolved, locale);
  return `${diagnostic.code}: ${text.title}\n${text.cause}\n${text.steps[0] ?? ""}\n\n${diagnostic.message}`;
}
