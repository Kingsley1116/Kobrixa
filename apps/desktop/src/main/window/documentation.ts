import { z } from "zod";
import {
  diagnosticDocumentationUrl,
  getBuiltinDiagnosticHelp,
  isBuiltinDiagnosticSource,
} from "@kobrixa/compiler/diagnostic-help";
import {
  diagnosticCodeSchema,
  diagnosticHelpKeySchema,
  namespacedIdSchema,
  type PluginDiagnosticHelpEntry,
} from "@kobrixa/plugin-protocol";

const target = {
  source: namespacedIdSchema,
  code: diagnosticCodeSchema,
  helpKey: diagnosticHelpKeySchema.optional(),
  locale: z.enum(["zh-TW", "en"]),
};
const schema = z.union([
  z.object({ ...target, relatedIndex: z.number().int().nonnegative().optional() }).strict(),
  z.object({ ...target, linkIndex: z.number().int().nonnegative() }).strict(),
]);
export type PluginHelpLookup = (
  source: string,
  code: string,
  helpKey?: string,
) => PluginDiagnosticHelpEntry | undefined;

/** Resolve only authored catalog links, never renderer-supplied URLs. */
export function documentationUrl(value: unknown, lookup: PluginHelpLookup): string {
  const request = schema.parse(value);
  if ("linkIndex" in request) {
    if (isBuiltinDiagnosticSource(request.source))
      throw new Error("Built-in diagnostics have no plugin links.");
    const link = lookup(request.source, request.code, request.helpKey)?.links?.[request.linkIndex];
    if (!link) throw new Error("Unknown plugin help link.");
    const url = new URL(link.url);
    if (url.protocol !== "https:" || !url.hostname) throw new Error("Invalid plugin help link.");
    return url.toString();
  }
  const help = getBuiltinDiagnosticHelp(request.source, request.code, request.helpKey);
  if (!help) throw new Error("Unknown diagnostic documentation.");
  if (request.relatedIndex === undefined) {
    const url = diagnosticDocumentationUrl(request.code, request.helpKey, request.locale);
    if (!url) throw new Error("Unknown diagnostic documentation.");
    return url;
  }
  const related = help.related[request.relatedIndex];
  if (!related) throw new Error("Unknown related document.");
  const url = new URL(related.path, "https://kobrixa.com");
  if (url.origin !== "https://kobrixa.com" || !url.pathname.startsWith("/docs/"))
    throw new Error("Invalid documentation destination.");
  url.searchParams.set("lang", request.locale);
  return url.toString();
}
