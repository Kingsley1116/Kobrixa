import type { KobrixaIR } from "@kobrixa/ir";
import type { BackendDecl } from "@kobrixa/plugin-protocol";

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
  slot: string;
  kind: string;
  role: "deploy-main" | "deploy-asset" | "aux";
  mediaType: string;
  path: string;
  sha256: string;
  byteLength: number;
  remotePath?: string;
}

export interface CompileResult {
  buildId: string;
  target: string;
  deploy?: "ev3";
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}

export interface ProjectManifest {
  schemaVersion: 1;
  name: string;
  language: string;
  entry: string;
  target: string;
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
  id: string;
  compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult>;
}

export interface BackendResult {
  artifacts: Array<{ slot: string; data: Uint8Array }>;
  diagnostics: Diagnostic[];
}

export interface CompilerBackend {
  id: string;
  declaration: BackendDecl;
  irVersion: number;
  compile(ir: KobrixaIR, signal: AbortSignal): Promise<BackendResult>;
}

export interface MemoryArtifact {
  slot: string;
  kind: string;
  role: BuildArtifact["role"];
  mediaType: string;
  relativePath: string;
  data: Uint8Array;
  remotePath?: string;
}

export type CompileMemoryResult =
  | {
      success: true;
      ir: KobrixaIR;
      diagnostics: Diagnostic[];
      artifacts: MemoryArtifact[];
      runtimeDirectory?: string;
    }
  | { success: false; diagnostics: Diagnostic[]; artifacts: [] };

export interface BuildProgress {
  buildId: string;
  stage: "validate" | "frontend" | "ir" | "backend" | "commit" | "complete";
  message: string;
}
