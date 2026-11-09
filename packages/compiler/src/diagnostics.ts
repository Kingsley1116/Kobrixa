import type { Diagnostic, PublishedDiagnostic, SourceRange } from "./contracts.js";
import type { SourceSpan } from "@kobrixa/ir";

/** Reserved identity for diagnostics produced by Kobrixa itself; no plugin may register it. */
export const CORE_DIAGNOSTIC_SOURCE = "kobrixa.core";

export const ZERO_RANGE: SourceRange = {
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1,
};

export function diagnostic(
  code: string,
  message: string,
  file = "kobrixa.json",
  range: SourceRange = ZERO_RANGE,
  severity: Diagnostic["severity"] = "error",
): PublishedDiagnostic {
  return { code, severity, file, range, message, source: CORE_DIAGNOSTIC_SOURCE };
}

export function diagnosticFromSpan(
  code: string,
  message: string,
  span?: SourceSpan,
): PublishedDiagnostic {
  return diagnostic(
    code,
    message,
    span?.file ?? "<generated>",
    span
      ? {
          startLine: span.start.line,
          startColumn: span.start.column,
          endLine: span.end.line,
          endColumn: span.end.column,
        }
      : ZERO_RANGE,
  );
}
