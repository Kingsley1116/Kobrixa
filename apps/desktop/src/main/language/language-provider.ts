import type { Diagnostic, PublishedDiagnostic, SourceProject } from "@kobrixa/compiler";
import type { LanguageCapability } from "@kobrixa/plugin-protocol";
import type { LanguageAnalysis, CompletionIndex, QuickFix } from "../../shared/language-types.js";
import type { LanguageFeatureQuery, LanguageFeatureResult } from "../../shared/language-query.js";
export type ProviderAnalysis = Omit<LanguageAnalysis, "diagnostics"> & {
  diagnostics: Diagnostic[];
};
export interface LanguageAnalysisProvider {
  analyze(project: SourceProject, version: number, signal: AbortSignal): ProviderAnalysis;
  query(version: number, query: LanguageFeatureQuery, signal: AbortSignal): LanguageFeatureResult;
  quickFixes(
    version: number,
    file: string,
    diagnostic: PublishedDiagnostic,
    signal: AbortSignal,
  ): QuickFix[];
  dispose(): void;
}
export interface LanguageCompletionProvider {
  analyze(project: SourceProject, signal: AbortSignal): CompletionIndex;
  dispose(): void;
}
export interface LanguageServiceFactory {
  capabilities: readonly LanguageCapability[];
  createAnalysis(): LanguageAnalysisProvider;
  createCompletion(): LanguageCompletionProvider;
}
