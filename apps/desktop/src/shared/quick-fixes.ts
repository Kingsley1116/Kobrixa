import type { BasicPlusQuickFix } from "@kobrixa/basic-plus";
import type { PublishedDiagnostic } from "@kobrixa/compiler";

export interface QuickFixRequest {
  requestId: string;
  session: string;
  revision: number;
  analysisVersion: number;
  file: string;
  diagnostic: Pick<PublishedDiagnostic, "source" | "code" | "helpKey" | "range">;
}
export type QuickFixReply = { kind: "result"; fixes: BasicPlusQuickFix[] } | { kind: "stale" };

export function sameDiagnostic(
  a: Pick<PublishedDiagnostic, "source" | "code" | "helpKey" | "range">,
  b: Pick<PublishedDiagnostic, "source" | "code" | "helpKey" | "range">,
): boolean {
  return (
    a.source === b.source &&
    a.code === b.code &&
    a.helpKey === b.helpKey &&
    a.range.startLine === b.range.startLine &&
    a.range.startColumn === b.range.startColumn &&
    a.range.endLine === b.range.endLine &&
    a.range.endColumn === b.range.endColumn
  );
}
