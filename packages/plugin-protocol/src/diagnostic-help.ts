import { z } from "zod";
import { MULTI_LINE, SINGLE_LINE } from "./common.js";
import { DIAGNOSTIC_HELP_LIMITS as L } from "./limits.js";

export const diagnosticCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
export const diagnosticHelpKeySchema = z.string().regex(/^[a-z0-9-]{1,100}$/);
export const diagnosticHelpDeclSchema = z.strictObject({
  version: z.literal(1),
  path: z
    .string()
    .max(600)
    .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.json$/),
});
export type DiagnosticHelpDecl = z.infer<typeof diagnosticHelpDeclSchema>;

const line = z.string().min(1).max(L.lineLength).regex(SINGLE_LINE);
const block = z.string().min(1).max(L.blockLength).regex(MULTI_LINE);
const text = (value: z.ZodString) => z.strictObject({ en: value, "zh-TW": value.optional() });
const steps = z.array(line).min(1).max(L.stepsPerLocale);
const link = z.strictObject({
  // Parsed again by diagnosticHelpProblems(); the pattern only rules out controls and spaces.
  url: z
    .string()
    .max(L.urlLength)
    // eslint-disable-next-line no-control-regex -- rejects control characters and spaces.
    .regex(/^https:\/\/[^\u0000- \u007F]+$/),
  label: text(line),
});
export const pluginDiagnosticHelpEntrySchema = z.strictObject({
  code: diagnosticCodeSchema,
  helpKey: diagnosticHelpKeySchema.optional(),
  title: text(line),
  cause: text(block),
  steps: z.strictObject({ en: steps, "zh-TW": steps.optional() }),
  example: z.strictObject({ before: block, after: block }).optional(),
  links: z.array(link).max(L.linksPerEntry).optional(),
});
export const pluginDiagnosticHelpFileSchema = z.strictObject({
  entries: z.array(pluginDiagnosticHelpEntrySchema).max(L.entriesPerPlugin),
});
export type PluginDiagnosticHelpEntry = z.infer<typeof pluginDiagnosticHelpEntrySchema>;
export type PluginDiagnosticHelpFile = z.infer<typeof pluginDiagnosticHelpFileSchema>;

const encoder = new TextEncoder();
/** Relations JSON Schema cannot express; run after the structural parse. */
export function diagnosticHelpProblems(file: PluginDiagnosticHelpFile): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const entry of file.entries) {
    const key = `${entry.code}:${entry.helpKey ?? ""}`;
    const label = entry.helpKey ? `${entry.code}#${entry.helpKey}` : entry.code;
    if (keys.has(key)) problems.push(`Diagnostic help for ${label} is declared more than once.`);
    keys.add(key);
    if (encoder.encode(JSON.stringify(entry)).length > L.entryBytes)
      problems.push(`Diagnostic help for ${label} is larger than 16 KiB.`);
    for (const { url } of entry.links ?? []) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      if (!parsed || parsed.protocol !== "https:" || !parsed.hostname)
        problems.push(`Diagnostic help for ${label} has an invalid https link.`);
    }
  }
  return problems;
}
