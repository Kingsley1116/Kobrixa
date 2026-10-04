import type { KobrixaIR } from "@kobrixa/ir";

export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface Diagnostic {
  code: string;
  /** Optional producer-supplied reason for codes with several meanings. */
  helpKey?: string | undefined;
  severity: "error" | "warning" | "info";
  file: string;
  range: SourceRange;
  message: string;
}

export interface BuildArtifact {
  kind: "rbf" | "ir" | "listing" | "asset";
  path: string;
  sha256: string;
  /** Project-relative destination used by device deployment for runtime assets. */
  remotePath?: string;
}

export interface CompileResult {
  /** Destination required by an entry source Folder directive. */
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}

export interface ProjectManifest {
  schemaVersion: 1;
  name: string;
  language: "bp";
  entry: string;
  target: "ev3-native";
  assets: string[];
  outputDir: string;
  [key: string]: unknown;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface AssetFile {
  path: string;
  absolutePath: string;
}

export interface SourceProject {
  root: string;
  manifest: ProjectManifest;
  sources: SourceFile[];
  assets: AssetFile[];
}

export interface FrontendResult {
  ir?: KobrixaIR;
  diagnostics: Diagnostic[];
}

export interface LanguageFrontend {
  id: "bp" | "python" | "typescript" | "cpp";
  compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult>;
}

export interface BackendResult {
  rbf?: Uint8Array;
  listing?: string;
  diagnostics: Diagnostic[];
}

export interface CompilerBackend {
  id: "ev3-native";
  compile(ir: KobrixaIR, signal: AbortSignal): Promise<BackendResult>;
}

export interface BuildProgress {
  buildId: string;
  stage: "validate" | "frontend" | "ir" | "backend" | "commit" | "complete";
  message: string;
}
