import type { Diagnostic, PublishedDiagnostic } from "./contracts.js";
import { BuildError } from "./build-error.js";

export { CORE_DIAGNOSTIC_SOURCE } from "./diagnostics.js";

/** Assigns the host-verified provider identity; producers must not choose their own. */
export function stampDiagnostics(
  items: readonly Diagnostic[],
  source: string,
): PublishedDiagnostic[] {
  if (items.some((item) => item.source !== undefined))
    throw new BuildError(
      "BUILD1007",
      "A compiler provider returned diagnostics with a source; Kobrixa assigns diagnostic sources.",
    );
  return items.map((item) => ({ ...item, source }));
}

export const isPublishedDiagnostic = (item: Diagnostic): item is PublishedDiagnostic =>
  typeof item.source === "string" && item.source.length > 0;

/** Publication guard: an unsourced diagnostic means a host path forgot to stamp it. */
export function requirePublished(items: readonly Diagnostic[]): PublishedDiagnostic[] {
  const missing = items.find((item) => !isPublishedDiagnostic(item));
  if (missing) throw new Error(`Diagnostic ${missing.code} was published without a source.`);
  return items as PublishedDiagnostic[];
}
