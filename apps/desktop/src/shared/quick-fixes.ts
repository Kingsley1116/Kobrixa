import type { BasicPlusQuickFix } from "@kobrixa/basic-plus";
import type { Diagnostic } from "@kobrixa/compiler";

export interface QuickFixRequest {
  requestId: string;
  session: string;
  revision: number;
  analysisVersion: number;
  file: string;
  diagnostic: Pick<Diagnostic, "code" | "helpKey" | "range">;
}
export type QuickFixReply = { kind: "result"; fixes: BasicPlusQuickFix[] } | { kind: "stale" };

export function sameDiagnostic(
  a: Pick<Diagnostic, "code" | "helpKey" | "range">,
  b: Pick<Diagnostic, "code" | "helpKey" | "range">,
): boolean {
  return (
    a.code === b.code &&
    a.helpKey === b.helpKey &&
    a.range.startLine === b.range.startLine &&
    a.range.startColumn === b.range.startColumn &&
    a.range.endLine === b.range.endLine &&
    a.range.endColumn === b.range.endColumn
  );
}

export const QUICK_FIX_CODES: ReadonlySet<string> = new Set([
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
