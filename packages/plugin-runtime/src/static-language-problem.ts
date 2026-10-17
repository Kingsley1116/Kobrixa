import type { StaticLanguageProblemDetail } from "./static-languages.js";

export function staticLanguageLimitSuffix(detail: StaticLanguageProblemDetail): string {
  if (detail.actual === undefined || detail.allowed === undefined) return "";
  return ` (actual ${JSON.stringify(detail.actual)}, allowed ${JSON.stringify(detail.allowed)})`;
}
