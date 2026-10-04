import { z } from "zod";
import { diagnosticDocumentationUrl, getDiagnosticHelp } from "@kobrixa/compiler/diagnostic-help";

const schema = z
  .object({
    code: z.string().max(20),
    helpKey: z.string().max(100).optional(),
    locale: z.enum(["zh-TW", "en"]),
    relatedIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Resolve only authored catalog links, never renderer-supplied URLs. */
export function documentationUrl(value: unknown): string {
  const request = schema.parse(value);
  const help = getDiagnosticHelp(request.code, request.helpKey);
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
