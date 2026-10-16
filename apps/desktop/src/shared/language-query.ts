import type { SourceRange } from "@kobrixa/compiler";
import type { LanguageLocation, LanguageDocumentSymbol } from "./language-types.js";

export interface AnalysisIdentity {
  epoch: number;
  session: string;
  revision: number;
  analysisVersion: number;
}
/**
 * Query `line`/`column` fields use the same 1-based source coordinates as SourceRange,
 * BOM-inclusive (not Monaco columns).
 */
export type LanguageFeatureQuery =
  | { kind: "hover"; file: string; line: number; column: number }
  | { kind: "signatureHelp"; file: string; line: number; column: number }
  | { kind: "definition"; file: string; line: number; column: number }
  | { kind: "references"; file: string; line: number; column: number; includeDeclaration: boolean }
  | { kind: "renameLocation"; file: string; line: number; column: number }
  | { kind: "rename"; file: string; line: number; column: number; newName: string }
  | { kind: "documentSymbols"; file: string };
export type LanguageFeatureResult =
  | { kind: "hover"; value: { range: SourceRange; contents: string[] } | null }
  | {
      kind: "signatureHelp";
      value: {
        label: string;
        parameters: Array<[number, number]>;
        activeParameter: number;
        documentation?: string;
      } | null;
    }
  | { kind: "definition" | "references"; locations: LanguageLocation[] }
  | { kind: "renameLocation"; range?: SourceRange; text: string; rejectReason?: string }
  | {
      kind: "rename";
      edits: Array<LanguageLocation & { text: string; expected: string }>;
      rejectReason?: string;
    }
  | { kind: "documentSymbols"; symbols: LanguageDocumentSymbol[] };
export interface LanguageFeatureRequest extends AnalysisIdentity {
  requestId: string;
  query: LanguageFeatureQuery;
}
export type LanguageFeatureReply =
  | { kind: "result"; epoch: number; result: LanguageFeatureResult }
  | { kind: "stale"; epoch: number };
