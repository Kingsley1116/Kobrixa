import type { CompileResult } from "../../shared/api.js";

/** Use the committed executable name and the source Folder's runtime directory. */
export function deploymentPath(result: CompileResult): string | undefined {
  if (!result.success) return undefined;
  const executable = result.artifacts.find((artifact) => artifact.kind === "rbf");
  if (!executable) return undefined;
  const filename = executable.path.replaceAll("\\", "/").split("/").at(-1);
  return `${result.runtimeDirectory ?? "/home/root/lms2012/prjs"}/${filename}`;
}
