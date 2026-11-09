import { validateIR } from "@kobrixa/ir";
import type {
  CompileMemoryResult,
  CompilerBackend,
  Diagnostic,
  DiagnosticSources,
  LanguageFrontend,
  SourceProject,
} from "./contracts.js";
import { BuildError, failedBuild } from "./build-error.js";
import { diagnosticFromSpan } from "./diagnostics.js";
import { stampDiagnostics } from "./diagnostic-source.js";
import { validateArtifacts } from "./artifacts.js";
export async function compileToMemory(
  project: SourceProject,
  frontend: LanguageFrontend,
  backend: CompilerBackend,
  signal: AbortSignal,
  sources?: DiagnosticSources,
): Promise<CompileMemoryResult> {
  const diagnostics: Diagnostic[] = [];
  // Library callers keep producer output as is; the host passes trusted provider identities.
  const stamp = (items: readonly Diagnostic[], source: string | undefined): Diagnostic[] =>
    source === undefined ? [...items] : stampDiagnostics(items, source);
  const failed = (): CompileMemoryResult => ({ success: false, diagnostics, artifacts: [] });
  try {
    signal.throwIfAborted();
    const source = await frontend.compile(project, signal);
    diagnostics.push(...stamp(source.diagnostics, sources?.frontend));
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
    diagnostics.push(...stamp(result.diagnostics, sources?.backend));
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
