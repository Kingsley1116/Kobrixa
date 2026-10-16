import type { PublishedDiagnostic } from "@kobrixa/compiler";

export const BASIC_PLUS_SOURCE = "kobrixa.basic-plus";
/** Codes the Basic Plus parser can repair; other providers' codes never qualify. */
export const BASIC_PLUS_QUICK_FIX_CODES: ReadonlySet<string> = new Set([
  "BP1015",
  "BP1024",
  "BP1013",
  "BP1040",
  "BP1043",
  "BP1033",
  "BP1034",
  "BP1014",
  "BP1030",
  "BP1031",
  "BP1035",
]);
export const offersBasicPlusQuickFix = (
  diagnostic: Pick<PublishedDiagnostic, "source" | "code">,
): boolean =>
  diagnostic.source === BASIC_PLUS_SOURCE && BASIC_PLUS_QUICK_FIX_CODES.has(diagnostic.code);
