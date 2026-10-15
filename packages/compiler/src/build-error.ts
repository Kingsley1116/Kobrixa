import type { CompileResult, Diagnostic } from "./contracts.js";
import { diagnostic } from "./diagnostics.js";
export type BuildErrorCode =
  | "BUILD0001"
  | "BUILD1001"
  | "BUILD1002"
  | "BUILD1003"
  | "BUILD1004"
  | "BUILD1005"
  | "BUILD1006"
  | "BUILD9000";
export class BuildError extends Error {
  readonly detail: string;

  constructor(
    readonly code: BuildErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BuildError";
    this.detail = message;
  }
}
export function failedBuild(
  buildId: string,
  target: string,
  error: unknown,
  entry: string,
  diagnostics: Diagnostic[] = [],
): CompileResult {
  const code =
    error instanceof BuildError
      ? error.code
      : error instanceof Error && error.name === "AbortError"
        ? "BUILD0001"
        : "BUILD9000";
  const message =
    code === "BUILD0001"
      ? "Build cancelled."
      : error instanceof BuildError
        ? error.detail
        : error instanceof Error
          ? error.message
          : String(error);
  return {
    buildId,
    target,
    success: false,
    artifacts: [],
    diagnostics: [...diagnostics, diagnostic(code, message, entry)],
  };
}
