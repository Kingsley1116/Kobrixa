import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";

// Uses real Electron: utilityProcess, MessagePort transfer and the Python stdio launcher.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-plugins-smoke-"));
const alias = {
  "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
  "@kobrixa/plugin-runtime": path.join(root, "packages/plugin-runtime/src/index.ts"),
  "@kobrixa/plugin-sdk": path.join(root, "packages/plugin-sdk-js/src/index.ts"),
};
const bundle = (entry, outfile, external = []) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external,
  });
const python = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"]
  .filter(Boolean)
  .find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
        .status === 0,
  );
if (!python) throw new Error("The plugin smoke needs Python 3.10+. Set KOBRIXA_TEST_PYTHON.");
let passed = false;
try {
  await bundle(
    path.join(root, "tests/desktop/plugins-smoke-main.ts"),
    path.join(temporary, "main.cjs"),
    ["electron"],
  );
  await cp(
    path.join(root, "plugins/samples/hello-ts/kobrixa-plugin.json"),
    path.join(temporary, "hello-ts/kobrixa-plugin.json"),
  );
  await bundle(
    path.join(root, "plugins/samples/hello-ts/src/index.ts"),
    path.join(temporary, "hello-ts/dist/index.cjs"),
  );
  await cp(
    path.join(root, "plugins/samples/hello-python"),
    path.join(temporary, "插件 測試/hello-python"),
    { recursive: true },
  );
  await bundle(
    path.join(root, "tests/desktop/fixtures/crash-plugin.ts"),
    path.join(temporary, "crash/dist/index.cjs"),
  );
  await writeFile(
    path.join(temporary, "crash/kobrixa-plugin.json"),
    JSON.stringify({
      id: "kobrixa-smoke.crash",
      version: "0.0.0",
      apiVersion: "^1.0.0",
      runtime: { kind: "node", entry: "dist/index.cjs" },
      contributes: { commands: [{ id: "kobrixa-smoke.crash.exit", title: "Crash" }] },
    }),
  );
  const fixture = async (name, runtime, command) => {
    const directory = path.join(temporary, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "kobrixa-plugin.json"),
      JSON.stringify({
        id: `kobrixa-smoke.${name}`,
        version: "0.0.0",
        apiVersion: "^1.0.0",
        runtime,
        contributes: { commands: [{ id: command, title: "Record PID" }] },
      }),
    );
    return directory;
  };
  await fixture("pid-ts", { kind: "node", entry: "dist/index.cjs" }, "kobrixa-smoke.pid-ts.record");
  await bundle(
    path.join(root, "tests/desktop/fixtures/pid-plugin.ts"),
    path.join(temporary, "pid-ts/dist/index.cjs"),
  );
  const pidPython = await fixture(
    "pid-python",
    { kind: "python", entry: "main.py" },
    "kobrixa-smoke.pid-python.record",
  );
  await cp(
    path.join(root, "tests/desktop/fixtures/pid_plugin.py"),
    path.join(pidPython, "main.py"),
  );
  await fixture(
    "stubborn-ts",
    { kind: "node", entry: "dist/index.cjs" },
    "kobrixa-smoke.stubborn-ts.record",
  );
  await bundle(
    path.join(root, "tests/desktop/fixtures/stubborn-plugin.ts"),
    path.join(temporary, "stubborn-ts/dist/index.cjs"),
  );
  const child = spawn(
    process.execPath,
    [
      require.resolve("electron/cli.js"),
      path.join(temporary, "main.cjs"),
      `--user-data-dir=${path.join(temporary, "user-data")}`,
      temporary,
      python,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: path.join(root, "sdks/python") },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Plugin smoke failed (${code})`);
  // The graceful shutdown handshake ran before Electron exited.
  await access(path.join(temporary, "pid-ts/shutdown.txt"));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };
  // No child may outlive Electron, which also kills utilityProcess children on exit.
  // Runtime unit tests independently prove the forced-kill shutdown deadline.
  for (const name of ["pid-ts", "pid-python", "stubborn-ts"]) {
    const pid = Number(await readFile(path.join(temporary, name, "pid.txt"), "utf8"));
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (alive(pid)) throw new Error(`Plugin process ${name} (${pid}) outlived Kobrixa.`);
  }
  console.log("PASS plugins: utilityProcess TS, Python stdio, crash isolation, quit cleanup");
  // The GUI flow: the same controller the settings panel drives, with scripted native dialogs.
  await bundle(
    path.join(root, "tests/desktop/plugins-gui-smoke-main.ts"),
    path.join(temporary, "gui-main.cjs"),
    ["electron"],
  );
  const guiUserData = path.join(temporary, "gui-user-data");
  const runGui = async (phase) => {
    const gui = spawn(
      process.execPath,
      [
        require.resolve("electron/cli.js"),
        path.join(temporary, "gui-main.cjs"),
        `--user-data-dir=${guiUserData}`,
        temporary,
        phase,
      ],
      { stdio: "inherit" },
    );
    return new Promise((resolve, reject) => {
      gui.once("error", reject);
      gui.once("exit", resolve);
    });
  };
  const first = await runGui("first");
  if (first !== 0) throw new Error(`Plugin GUI smoke (first) failed (${first})`);
  // electron/cli.js exits with 1 when Electron is killed by a signal.
  const second = await runGui("second");
  await access(path.join(temporary, "gui-crash-ready.txt")).catch(() => {
    throw new Error(`Plugin GUI smoke (second) failed before the simulated crash (${second})`);
  });
  if (second === 0) throw new Error("Plugin GUI smoke (second) should have been killed");
  const third = await runGui("third");
  if (third !== 0) throw new Error(`Plugin GUI smoke (third) failed (${third})`);
  await access(path.join(temporary, "hello-ts/kobrixa-plugin.json"));
  const marker = await stat(path.join(guiUserData, "plugins/session.json")).catch(() => undefined);
  if (marker) throw new Error("A clean quit must remove the session marker");
  const saved = JSON.parse(await readFile(path.join(guiUserData, "plugins/state.json"), "utf8"));
  if (saved.developerMode !== true || saved.sources.length !== 1 || "safeModeLock" in saved)
    throw new Error(`Unexpected plugin settings after the GUI smoke: ${JSON.stringify(saved)}`);
  console.log("PASS plugin GUI: developer mode, link, reload, unlink, recovery after a hang");
  passed = true;
} finally {
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Plugin smoke artifacts: ${temporary}`);
}
