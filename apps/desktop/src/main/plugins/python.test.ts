import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProbe,
  probePython,
  pythonCommands,
  PYTHON_PROBE_SCRIPT,
  runProbe,
} from "./python.js";

afterEach(() => vi.unstubAllEnvs());
const limits = { timeoutMs: 10_000, outputBytes: 4096 };
const node = (code: string) => ({ executable: process.execPath, args: ["-e", code, "--"] });

describe("pythonCommands", () => {
  it("lists PATH candidates, adds py -3 on Windows and keeps a custom saved choice", () => {
    expect(pythonCommands("darwin").map(({ id }) => id)).toEqual(["python3", "python"]);
    const custom = { executable: "C:/Python312/python.exe", args: [] };
    expect(pythonCommands("win32", custom)).toEqual([
      { id: "python3", command: { executable: "python3", args: [] } },
      { id: "python", command: { executable: "python", args: [] } },
      { id: "py", command: { executable: "py", args: ["-3"] } },
      { id: "saved", command: custom },
    ]);
    expect(
      pythonCommands("linux", { executable: "python3", args: [] }).map(({ id }) => id),
    ).toEqual(["python3", "python"]);
  });
});

describe("classifyProbe", () => {
  const report = (value: object) => `noise from sitecustomize\n${JSON.stringify(value)}\n`;
  it.each([
    [
      { version: "3.12.1", path: "/py", sdk: "1.0.0" },
      { status: "ok", version: "3.12.1", path: "/py", sdkApiVersion: "1.0.0" },
    ],
    [
      { version: "3.12.1", path: "/py" },
      { status: "warning", problem: "sdk-missing" },
    ],
    [
      { version: "3.10.0", path: "/py", sdk: "2.0.0" },
      { status: "warning", problem: "sdk-incompatible", sdkApiVersion: "2.0.0" },
    ],
    [
      { version: "3.10.0", path: "/py", sdk: "nonsense" },
      { status: "warning", problem: "sdk-incompatible" },
    ],
    [
      { version: "3.9.18", path: "/py", sdk: "1.0.0" },
      { status: "error", problem: "too-old", version: "3.9.18" },
    ],
  ])("classifies %j", (value, expected) => {
    expect(classifyProbe(report(value))).toMatchObject(expected);
  });
  it("fails on output that is not a report", () => {
    expect(classifyProbe("Python was not found")).toMatchObject({
      status: "error",
      problem: "failed",
    });
    expect(classifyProbe("")).toMatchObject({ status: "error", problem: "failed" });
  });
});

describe("runProbe", () => {
  it("runs the command's own arguments, then -c and the script, without a shell", async () => {
    expect(
      await runProbe(node("process.stdout.write(process.argv.slice(1).join('|'))"), "S", limits),
    ).toBe("-c|S");
  });
  it("stops a probe that hangs and reports the timeout", async () => {
    const started = Date.now();
    expect(
      await probePython(node("setTimeout(() => {}, 60_000)"), (command, script) =>
        runProbe(command, script, { timeoutMs: 200, outputBytes: 4096 }),
      ),
    ).toEqual({ status: "error", problem: "failed", detail: "Timed out after 3 s." });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("stops a probe that floods stdout and reports the output limit", async () => {
    expect(
      await probePython(
        node("process.stdout.write('x'.repeat(100_000)); setTimeout(() => {}, 60_000)"),
        (command, script) => runProbe(command, script, limits),
      ),
    ).toEqual({ status: "error", problem: "failed", detail: "Printed more than 4 KiB." });
  });
  it.each([
    [Object.assign(new Error("probe killed"), { killed: true }), "Timed out after 3 s."],
    [Object.assign(new Error("probe expired"), { code: "ETIMEDOUT" }), "Timed out after 3 s."],
    [new Error("probe timed out"), "Timed out after 3 s."],
    [
      Object.assign(new Error("output limit"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
      }),
      "Printed more than 4 KiB.",
    ],
    [new Error("stdout maxBuffer length exceeded"), "Printed more than 4 KiB."],
    [Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }), "Not found."],
    [Object.assign(new Error("spawn python3 EACCES"), { code: "EACCES" }), "Not executable."],
    [
      new Error(`Command failed: python3 -c ${PYTHON_PROBE_SCRIPT}\nTraceback: failure`),
      "Command failed: python3 -c",
    ],
    [new Error("Unexpected failure\nMore details"), "Unexpected failure"],
  ])("reports a readable runner failure for %s", async (error, detail) => {
    expect(
      await probePython({ executable: "python3", args: [] }, async () => {
        throw error;
      }),
    ).toEqual({ status: "error", problem: "failed", detail });
  });
  const python = ["python3", "python"].find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
        .status === 0,
  );
  it.skipIf(!python)("probes a real interpreter with the repository SDK", async () => {
    vi.stubEnv("PYTHONPATH", fileURLToPath(new URL("../../../../../sdks/python", import.meta.url)));
    expect(await probePython({ executable: python!, args: [] })).toMatchObject({
      status: "ok",
      sdkApiVersion: "1.0.0",
    });
    expect(PYTHON_PROBE_SCRIPT).toContain("import kobrixa");
  });
});
