import type { Diagnostic } from "@kobrixa/compiler";

/** Keeps loader diagnostics intact across the workspace/build service boundary. */
export class ProjectLoadError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((item) => item.message).join("\n"));
    this.name = "ProjectLoadError";
  }
}
