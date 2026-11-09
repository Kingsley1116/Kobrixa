import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  DIAGNOSTIC_HELP_LIMITS,
  diagnosticHelpProblems,
  pluginDiagnosticHelpFileSchema,
  type DiagnosticHelpDecl,
  type PluginDiagnosticHelpEntry,
} from "@kobrixa/plugin-protocol";
import { messageOf, type PluginProblem } from "./errors.js";

export interface LoadedDiagnosticHelp {
  entries: PluginDiagnosticHelpEntry[];
  /** UTF-8 size of the file as read; counts toward DIAGNOSTIC_HELP_LIMITS.totalBytes. */
  bytes: number;
}
type Result = { ok: true; help: LoadedDiagnosticHelp } | { ok: false; problem: PluginProblem };
const fail = (file: string, reason: string): Result => ({
  ok: false,
  problem: { code: "PLUGIN_E_DIAGNOSTIC_HELP", message: `${file}: ${reason}` },
});

/** Reads one plugin's help resource without following links out of the plugin folder. */
export async function readDiagnosticHelp(
  root: string,
  decl: DiagnosticHelpDecl,
  // Injected only by tests that change the file between stat and read.
  deps: { stat: (file: string) => Promise<{ isFile(): boolean }> } = { stat },
): Promise<Result> {
  const limit = DIAGNOSTIC_HELP_LIMITS.fileBytes;
  let text: string;
  let length = 0;
  try {
    const base = await realpath(root);
    const file = await realpath(path.resolve(base, decl.path));
    const relative = path.relative(base, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return fail(decl.path, "resolves outside the plugin folder.");
    if (!(await deps.stat(file)).isFile()) return fail(decl.path, "is not a regular file.");
    const handle = await open(file, "r");
    try {
      if (!(await handle.stat()).isFile()) return fail(decl.path, "is not a regular file.");
      // Read one byte past the limit so a file that grew after stat is still rejected.
      const buffer = Buffer.alloc(limit + 1);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > limit) return fail(decl.path, "is larger than 1 MiB.");
      }
      text = buffer
        .subarray(0, length)
        .toString("utf8")
        .replace(/^\uFEFF/, "");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return fail(decl.path, `cannot be read: ${messageOf(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(decl.path, `is not valid JSON: ${messageOf(error)}`);
  }
  const parsed = pluginDiagnosticHelpFileSchema.safeParse(value);
  if (!parsed.success)
    return fail(
      decl.path,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const problems = diagnosticHelpProblems(parsed.data);
  if (problems.length) return fail(decl.path, problems.join(" "));
  return { ok: true, help: { entries: parsed.data.entries, bytes: length } };
}
