import {
  CORE_DIAGNOSTIC_SOURCE,
  getBuiltinDiagnosticHelp,
  isBuiltinDiagnosticSource,
  type DiagnosticHelp,
  type DiagnosticLocale,
} from "@kobrixa/compiler/diagnostic-help";
import type { PublishedDiagnostic } from "@kobrixa/compiler";
import type { LocalizedText, PluginDiagnosticHelpEntry } from "@kobrixa/plugin-protocol";

export interface PluginHelpCatalogView {
  revision: number;
  /** Keyed by diagnostic source (plugin id). */
  plugins: Record<string, { displayName?: LocalizedText; entries: PluginDiagnosticHelpEntry[] }>;
}
export type ResolvedHelp =
  | { kind: "builtin"; help: DiagnosticHelp }
  | { kind: "plugin"; source: string; entry: PluginDiagnosticHelpEntry };
export interface HelpText {
  title: string;
  cause: string;
  steps: string[];
  example?: { before: string; after: string };
}

export function resolveDiagnosticHelp(
  diagnostic: Pick<PublishedDiagnostic, "source" | "code" | "helpKey">,
  catalog: PluginHelpCatalogView | undefined,
): ResolvedHelp | undefined {
  const { source, code, helpKey } = diagnostic;
  if (isBuiltinDiagnosticSource(source)) {
    const help = getBuiltinDiagnosticHelp(source, code, helpKey);
    return help && { kind: "builtin", help };
  }
  const entries =
    catalog && Object.hasOwn(catalog.plugins, source) ? catalog.plugins[source]!.entries : [];
  const entry =
    (helpKey
      ? entries.find((item) => item.code === code && item.helpKey === helpKey)
      : undefined) ?? entries.find((item) => item.code === code && item.helpKey === undefined);
  return entry && { kind: "plugin", source, entry };
}

const pick = <T>(value: { en: T; "zh-TW"?: T | undefined }, locale: DiagnosticLocale): T =>
  locale === "zh-TW" ? (value["zh-TW"] ?? value.en) : value.en;

export function localizeHelp(resolved: ResolvedHelp, locale: DiagnosticLocale): HelpText {
  if (resolved.kind === "builtin") {
    const { help } = resolved;
    return {
      title: help.title[locale],
      cause: help.cause[locale],
      steps: help.steps[locale],
      ...(help.example
        ? { example: { before: help.example.before, after: help.example.after } }
        : {}),
    };
  }
  const { entry } = resolved;
  return {
    title: pick(entry.title, locale),
    cause: pick(entry.cause, locale),
    steps: pick(entry.steps, locale),
    ...(entry.example ? { example: entry.example } : {}),
  };
}

export function diagnosticSourceLabel(
  source: string,
  catalog: PluginHelpCatalogView | undefined,
  locale: DiagnosticLocale,
): string {
  if (source === CORE_DIAGNOSTIC_SOURCE) return "Kobrixa";
  const name =
    catalog && Object.hasOwn(catalog.plugins, source)
      ? catalog.plugins[source]!.displayName
      : undefined;
  if (name === undefined) return source;
  const label = typeof name === "string" ? name : pick(name, locale);
  return isBuiltinDiagnosticSource(source) ? label : `${label} (${source})`;
}

export const diagnosticIdentity = (item: PublishedDiagnostic): string =>
  JSON.stringify([
    item.source,
    item.code,
    item.helpKey ?? null,
    item.severity,
    item.file,
    item.range.startLine,
    item.range.startColumn,
    item.range.endLine,
    item.range.endColumn,
    item.message,
  ]);
