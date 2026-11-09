import { randomUUID } from "node:crypto";
import type {
  BuildProgress,
  CompileResult,
  CompilerBackend,
  DiagnosticSources,
  LanguageFrontend,
  SourceProject,
} from "./contracts.js";
import { compileToMemory } from "./compile-memory.js";
import { commitArtifacts, type CommitOptions } from "./commit-artifacts.js";
import { failedBuild } from "./build-error.js";
export class BuildSession {
  #started = false;
  constructor(
    readonly frontend: LanguageFrontend,
    readonly backend: CompilerBackend,
    private readonly onProgress?: (progress: BuildProgress) => void,
    private readonly controller = new AbortController(),
    readonly id: string = randomUUID(),
    private readonly commitOptions: CommitOptions = {},
    private readonly diagnosticSources?: DiagnosticSources,
  ) {}
  cancel(): void {
    this.controller.abort();
  }
  async compile(project: SourceProject): Promise<CompileResult> {
    if (this.#started) throw new Error("A build session can only compile once.");
    this.#started = true;
    const progress = (stage: BuildProgress["stage"], message: string) =>
      this.onProgress?.({ buildId: this.id, stage, message });
    const result = await compileToMemory(
      project,
      {
        id: this.frontend.id,
        compile: async (input, signal) => {
          progress("frontend", "Compiling project sources");
          const value = await this.frontend.compile(input, signal);
          progress("ir", "Validating KobrixaIR");
          return value;
        },
      },
      {
        id: this.backend.id,
        declaration: this.backend.declaration,
        irVersion: this.backend.irVersion,
        compile: (ir, signal) => {
          progress("backend", "Generating declared artifacts");
          return this.backend.compile(ir, signal);
        },
      },
      this.controller.signal,
      this.diagnosticSources,
    );
    const base = {
      buildId: this.id,
      target: project.manifest.target,
      ...(this.backend.declaration.capabilities.deploy
        ? { deploy: this.backend.declaration.capabilities.deploy }
        : {}),
    };
    if (!result.success)
      return { ...base, success: false, diagnostics: result.diagnostics, artifacts: [] };
    try {
      progress("commit", "Committing verified artifacts");
      const artifacts = await commitArtifacts(
        project,
        this.id,
        result.artifacts,
        this.controller.signal,
        this.commitOptions,
      );
      progress("complete", "Build complete");
      return {
        ...base,
        success: true,
        diagnostics: result.diagnostics,
        artifacts,
        ...(result.runtimeDirectory ? { runtimeDirectory: result.runtimeDirectory } : {}),
      };
    } catch (error) {
      return failedBuild(
        this.id,
        project.manifest.target,
        error,
        project.manifest.entry,
        result.diagnostics,
      );
    }
  }
}
