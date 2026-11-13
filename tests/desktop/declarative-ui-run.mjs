import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { build } from "esbuild";
import { fixture, root } from "./declarative-ui-harness.mjs";

assert.deepEqual(
  process.argv.slice(2),
  ["--transport-only"],
  "This runner currently implements --transport-only. Browser/load/installed acceptance is not implemented yet.",
);
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const electron = require("electron");
const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-ui-acceptance-"));
const python = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(Boolean).find(
  (command) =>
    spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"], {
      stdio: "ignore",
    }).status === 0,
);
assert.ok(python, "Python 3.10+ is mandatory; missing interpreter is not a pass");
let passed = false;
let child;
let timedOut = false;
const log = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
function terminateTree() {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
try {
  const js = path.join(directory, "interop-js");
  const py = path.join(directory, "interop-python");
  await cp(fileURLToPath(fixture), js, { recursive: true });
  await cp(fileURLToPath(fixture), py, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(py, "kobrixa-plugin.json"), "utf8"));
  manifest.runtime = { kind: "python", entry: "consumer.py" };
  await writeFile(path.join(py, "kobrixa-plugin.json"), JSON.stringify(manifest));
  // Test-only log banners, retained in the hashed artifacts. No runtime PID API.
  const pythonSource = await readFile(path.join(py, "consumer.py"), "utf8");
  await writeFile(
    path.join(py, "consumer.py"),
    'import os, sys\nprint("UI_PID:" + str(os.getpid()), file=sys.stderr, flush=True)\n' +
      pythonSource,
  );
  const main = path.join(directory, "main.cjs");
  const alias = Object.fromEntries(
    [
      ["plugin-protocol", "plugin-protocol"],
      ["plugin-runtime", "plugin-runtime"],
      ["plugin-sdk", "plugin-sdk-js"],
    ].map(([name, folder]) => [
      `@kobrixa/${name}`,
      path.join(root, `packages/${folder}/src/index.ts`),
    ]),
  );
  await build({
    entryPoints: [fileURLToPath(new URL("consumer.ts", fixture))],
    outfile: path.join(js, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    banner: { js: 'console.error("UI_PID:" + process.pid);' },
  });
  await build({
    entryPoints: [path.join(root, "tests/desktop/declarative-ui-main.ts")],
    outfile: main,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external: ["electron"],
  });
  const files = ["main.cjs", "interop-js/main.cjs", "interop-python/consumer.py"];
  const artifact = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
        .length > 0,
    sha256: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(path.join(directory, file)))
            .digest("hex"),
        ]),
      ),
    ),
  };
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(artifact, null, 2),
  );
  const input = path.join(directory, "input.json");
  const output = path.join(directory, "transport.json");
  await writeFile(input, JSON.stringify({ js, python: py, pythonExecutable: python, artifact }));
  const env = {
    ...process.env,
    PYTHONPATH: path.join(root, "sdks/python"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  };
  child = spawn(
    electron,
    [
      main,
      "--ui-acceptance-mode=transport",
      `--ui-acceptance-input=${input}`,
      `--ui-acceptance-output=${output}`,
      `--user-data-dir=${path.join(directory, "profile")}`,
    ],
    {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log.push(chunk.toString());
      process.stderr.write(chunk);
    });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree();
  }, 90_000);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(timedOut, false, "Electron transport exceeded 90 seconds");
  assert.equal(result.code, 0, `Electron: ${result.signal}`);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(report.artifact, artifact);
  const deadline = performance.now() + 5000;
  while (report.results.some((row) => alive(row.pid)) && performance.now() < deadline)
    await pause(20);
  report.remainingPids = report.results.filter((row) => alive(row.pid)).map((row) => row.pid);
  await writeFile(output, JSON.stringify(report, null, 2));
  assert.deepEqual(report.remainingPids, [], "A normal close left a real plugin process alive");
  const checked = spawnSync(
    process.execPath,
    ["--test", path.join(root, "tests/desktop/declarative-ui-interop.test.mjs")],
    { cwd: root, env: { ...env, KOBRIXA_UI_REPORT: output }, stdio: "inherit", timeout: 30_000 },
  );
  assert.equal(checked.status, 0, `Receipt assertions failed: ${checked.error ?? checked.signal}`);
  passed = true;
} catch (error) {
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify({ error: String(error), stack: error.stack }, null, 2),
  );
  throw error;
} finally {
  if (!passed) terminateTree();
  await writeFile(path.join(directory, "electron.log"), log.join(""));
  console.log(`${passed ? "PASS transport only" : "FAIL"}; evidence directory ${directory}`);
}
