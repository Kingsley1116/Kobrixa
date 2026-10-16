import type { PublishedDiagnostic } from "@kobrixa/compiler";
import type { QuickFix } from "./language-types.js";

export type { QuickFix } from "./language-types.js";

export interface QuickFixRequest {
  requestId: string;
  session: string;
  revision: number;
  analysisVersion: number;
  file: string;
  diagnostic: Pick<PublishedDiagnostic, "source" | "code" | "helpKey" | "range">;
}
export type QuickFixReply = { kind: "result"; fixes: QuickFix[] } | { kind: "stale" };

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
