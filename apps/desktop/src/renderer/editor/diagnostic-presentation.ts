import type { DiagnosticLocale } from "@kobrixa/compiler/diagnostic-help";
import type { Diagnostic } from "../../shared/api.js";
import {
  resolveDiagnosticHelp,
  localizeHelp,
  type PluginHelpCatalogView,
} from "../../shared/diagnostic-help.js";
import type { QuickFix } from "../../shared/language-types.js";
export const quickFixTitle = (title: QuickFix["title"], locale: DiagnosticLocale): string =>
  locale === "zh-TW" ? (title["zh-TW"] ?? title.en) : title.en;
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
