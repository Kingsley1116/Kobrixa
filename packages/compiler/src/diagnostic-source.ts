import type { Diagnostic, PublishedDiagnostic } from "./contracts.js";
import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
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
  namespacedIdSchema.safeParse(item.source).success;

/** Publication guard: every diagnostic must carry a valid host-assigned source. */
export function requirePublished(items: readonly Diagnostic[]): PublishedDiagnostic[] {
  const invalid = items.find((item) => !isPublishedDiagnostic(item));
  if (invalid)
    throw new Error(
      `Diagnostic ${invalid.code} was published without a source or with an invalid source.`,
    );
  return items as PublishedDiagnostic[];
}
