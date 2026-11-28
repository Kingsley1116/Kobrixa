import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const MACOS_NESTED_SANDBOX_BLOCKED = "ERR_INSTALLED_MACOS_SANDBOX_NESTING";

export async function checkMacInstalledSandbox(profile, evidence, run = execute) {
  // Apple's sandbox.h: an already sandboxed process cannot apply another
  // profile. Chromium helpers must do exactly that before loading Chromium.
  // Check the primitive without Electron so this is not misdiagnosed as a
  // renderer discovery timeout. No unsandboxed fallback is permitted.
  const outer = ["-f", profile];
  evidence.status = "running";
  evidence.commands = [
    ["/usr/bin/sandbox-exec", ...outer, "/usr/bin/true"],
    [
      "/usr/bin/sandbox-exec",
      ...outer,
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1)(allow default)",
      "/usr/bin/true",
    ],
  ];
  evidence.results = [];
  for (const [index, [file, ...args]] of evidence.commands.entries()) {
    try {
      const result = await run(file, args, { timeout: 10_000 });
      evidence.results.push({ code: 0, stdout: result.stdout, stderr: result.stderr });
    } catch (cause) {
      evidence.results.push({
        code: cause.code,
        signal: cause.signal,
        message: cause.message,
        stdout: cause.stdout,
        stderr: cause.stderr,
      });
      evidence.status = index === 0 ? "failed" : "blocked";
      if (index === 0) throw cause;
      const error = new Error(
        "macOS installed isolation blocked: the outer Seatbelt profile runs, but nested sandbox initialization fails; Chromium helpers require their own sandbox. A separate-user filesystem/network isolation adapter is required; no isolated product acceptance was run.",
        { cause },
      );
      error.code = MACOS_NESTED_SANDBOX_BLOCKED;
      throw error;
    }
  }
  // This is only a prerequisite. It never establishes Chromium startup or any
  // source/network denial; the original installed assertions must still run.
  evidence.status = "prerequisite-passed";
}
