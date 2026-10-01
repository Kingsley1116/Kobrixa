import type { FrontendResult, LanguageFrontend, SourceProject } from "@kobrixa/compiler";
import { lowerProgram } from "./lower.js";
import { prepareBasicPlusProject } from "./project.js";

export class BasicPlusFrontend implements LanguageFrontend {
  readonly id = "bp" as const;

  async compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult> {
    const prepared = prepareBasicPlusProject(input, signal);
    const program = prepared.resolve(input.manifest.entry);
    const diagnostics = [...prepared.diagnostics, ...program.diagnostics];
    if (diagnostics.some((item) => item.severity === "error")) return { diagnostics };
    const lowered = lowerProgram(
      input.manifest.name,
      program.body,
      program.functions,
      program.sourceFiles,
    );
    if (program.rootFile?.runtimeDirectory)
      lowered.ir.program.runtimeDirectory = program.rootFile.runtimeDirectory;
    diagnostics.push(...lowered.diagnostics);
    return diagnostics.some((item) => item.severity === "error")
      ? { diagnostics }
      : { ir: lowered.ir, diagnostics };
  }
}
