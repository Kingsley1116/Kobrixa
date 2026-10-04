import { getDiagnosticHelp, type DiagnosticLocale } from "@kobrixa/compiler/diagnostic-help";
import type { Diagnostic } from "@kobrixa/compiler";
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
export function diagnosticSummary(diagnostic: Diagnostic, locale: DiagnosticLocale): string {
  return (
    getDiagnosticHelp(diagnostic.code, diagnostic.helpKey)?.title[locale] ?? diagnostic.message
  );
}
export function diagnosticMarkerMessage(diagnostic: Diagnostic, locale: DiagnosticLocale): string {
  const help = getDiagnosticHelp(diagnostic.code, diagnostic.helpKey);
  if (!help) return `${diagnostic.code}: ${diagnostic.message}`;
  return `${diagnostic.code}: ${help.title[locale]}\n${help.cause[locale]}\n${help.steps[locale][0] ?? ""}\n\n${diagnostic.message}`;
}
