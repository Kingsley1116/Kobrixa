import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import semver from "semver";
import { z } from "zod";
import { PLUGIN_API_VERSION } from "@kobrixa/plugin-protocol";
import { messageOf } from "@kobrixa/plugin-runtime";
import type { PythonChoiceId, PythonProbe } from "../../shared/plugins.js";

export const PYTHON_PROBE_TIMEOUT_MS = 3_000;
export const PYTHON_PROBE_OUTPUT_BYTES = 4 * 1024;
export const PYTHON_MINIMUM_VERSION = "3.10.0";
export interface PythonCommand {
  executable: string;
  args: string[];
}
export interface PythonCandidateCommand {
  id: Exclude<PythonChoiceId, "other">;
  command: PythonCommand;
}

/** Prints one JSON line: the interpreter's version and path, and the SDK's API version. */
export const PYTHON_PROBE_SCRIPT = [
  "import json, sys",
  "result = {'version': '%d.%d.%d' % sys.version_info[:3], 'path': sys.executable}",
  "try:",
  "    import kobrixa",
  "    result['sdk'] = str(kobrixa.API_VERSION)",
  "except Exception:",
  "    pass",
  "print(json.dumps(result))",
].join("\n");

export const sameCommand = (a: PythonCommand, b: PythonCommand): boolean =>
  a.executable === b.executable &&
  a.args.length === b.args.length &&
  a.args.every((arg, index) => arg === b.args[index]);
export const commandLabel = (command: PythonCommand): string =>
  [command.executable, ...command.args].join(" ");

/** Interpreters found by name on PATH, plus a saved custom choice that none of them matches. */
export function pythonCommands(
  platform: NodeJS.Platform,
  saved?: PythonCommand,
): PythonCandidateCommand[] {
  const list: PythonCandidateCommand[] = [
    { id: "python3", command: { executable: "python3", args: [] } },
    { id: "python", command: { executable: "python", args: [] } },
  ];
  if (platform === "win32") list.push({ id: "py", command: { executable: "py", args: ["-3"] } });
  if (saved && !list.some(({ command }) => sameCommand(command, saved)))
    list.push({ id: "saved", command: saved });
  return list;
}

const reportSchema = z.object({
  version: z.string().max(32),
  path: z.string().max(4096),
  sdk: z.string().max(64).optional(),
});

export function classifyProbe(output: string): PythonProbe {
  let report: z.infer<typeof reportSchema>;
  try {
    report = reportSchema.parse(JSON.parse(output.trim().split("\n").at(-1) ?? ""));
  } catch {
    return {
      status: "error",
      problem: "failed",
      detail: "The interpreter did not report its version.",
    };
  }
  const found = { version: report.version, path: report.path };
  const version = semver.coerce(report.version);
  if (!version || semver.lt(version, PYTHON_MINIMUM_VERSION))
    return {
      ...found,
      status: "error",
      problem: "too-old",
      detail: `Python ${report.version} is older than 3.10.`,
    };
  if (report.sdk === undefined)
    return {
      ...found,
      status: "warning",
      problem: "sdk-missing",
      detail: "This interpreter cannot import the kobrixa Python SDK.",
    };
  const sdk = semver.valid(report.sdk);
  if (!sdk || semver.major(sdk) !== semver.major(PLUGIN_API_VERSION))
    return {
      ...found,
      sdkApiVersion: report.sdk,
      status: "warning",
      problem: "sdk-incompatible",
      detail: `The kobrixa SDK implements API ${report.sdk}; Kobrixa requires ${PLUGIN_API_VERSION}.`,
    };
  return { ...found, sdkApiVersion: sdk, status: "ok" };
}

export type ProbeRunner = (command: PythonCommand, script: string) => Promise<string>;

/** No shell; killed at the time limit or as soon as stdout passes the output limit. */
export function runProbe(
  command: PythonCommand,
  script: string,
  limits = { timeoutMs: PYTHON_PROBE_TIMEOUT_MS, outputBytes: PYTHON_PROBE_OUTPUT_BYTES },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command.executable,
      [...command.args, "-c", script],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        killSignal: "SIGKILL",
        maxBuffer: limits.outputBytes,
        timeout: limits.timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** A passing probe does not guarantee a working plugin: the launch handshake still checks. */
export async function probePython(
  command: PythonCommand,
  run: ProbeRunner = runProbe,
): Promise<PythonProbe> {
  try {
    return classifyProbe(await run(command, PYTHON_PROBE_SCRIPT));
  } catch (error) {
    return { status: "error", problem: "failed", detail: messageOf(error) };
  }
}
