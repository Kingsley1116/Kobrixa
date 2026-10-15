import { validateIR } from "@kobrixa/ir";
import type {
  CompileMemoryResult,
  CompilerBackend,
  Diagnostic,
  LanguageFrontend,
  SourceProject,
} from "./contracts.js";
import { BuildError, failedBuild } from "./build-error.js";
import { diagnosticFromSpan } from "./diagnostics.js";
import { validateArtifacts } from "./artifacts.js";
export async function compileToMemory(
  project: SourceProject,
  frontend: LanguageFrontend,
  backend: CompilerBackend,
  signal: AbortSignal,
): Promise<CompileMemoryResult> {
  const diagnostics: Diagnostic[] = [];
  const failed = (): CompileMemoryResult => ({ success: false, diagnostics, artifacts: [] });
  try {
    signal.throwIfAborted();
    const source = await frontend.compile(project, signal);
    diagnostics.push(...source.diagnostics);
    if (!source.ir || diagnostics.some((item) => item.severity === "error")) return failed();
    signal.throwIfAborted();
    if (source.ir.version !== backend.irVersion)
      throw new BuildError(
        "BUILD1002",
        "The actual IR version differs from the resolved compiler version.",
      );
    const issues = validateIR(source.ir);
    diagnostics.push(
      ...issues.map((item) => diagnosticFromSpan(item.code, item.message, item.span)),
    );
    if (issues.length) return failed();
    const result = await backend.compile(source.ir, signal);
    diagnostics.push(...result.diagnostics);
    signal.throwIfAborted();
    if (diagnostics.some((item) => item.severity === "error")) return failed();
    const artifacts = await validateArtifacts(
      project,
      backend.declaration,
      result,
      source.ir,
      signal,
    );
    signal.throwIfAborted();
    return {
      success: true,
      ir: source.ir,
      diagnostics,
      artifacts,
      ...(source.ir.program.runtimeDirectory
        ? { runtimeDirectory: source.ir.program.runtimeDirectory }
        : {}),
    };
  } catch (error) {
    return {
      success: false,
      artifacts: [],
      diagnostics: failedBuild(
        "memory",
        project.manifest.target,
        error,
        project.manifest.entry,
        diagnostics,
      ).diagnostics,
    };
  }
}
