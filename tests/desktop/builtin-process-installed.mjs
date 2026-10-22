import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createPackageWithOptions, listPackage, statFile } from "@electron/asar";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { BUILTIN_PAYLOAD_UNPACK } from "../../tools/release/desktop-packaging.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function boundedFile(rootReal, relative, limit) {
  let current = rootReal;
  for (const segment of relative.split("/")) {
    assert.ok(segment && segment !== "." && segment !== "..");
    current = path.join(current, segment);
    assert.equal((await lstat(current)).isSymbolicLink(), false);
  }
  const resolved = await realpath(current);
  assert.equal(resolved, current);
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= limit);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    assert.ok(size <= limit);
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function verifyLeaf(directory, pluginId) {
  const rootReal = await realpath(directory);
  const raw = await boundedFile(rootReal, "resource-index.json", 16 * 1024);
  const index = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(Object.keys(index).sort(), ["files", "pluginId", "version"]);
  assert.equal(index.version, 1);
  assert.equal(index.pluginId, pluginId);
  assert.ok(index.files.length >= 2 && index.files.length <= 32);
  const paths = index.files.map((file) => file.path);
  assert.deepEqual(paths, [...new Set(paths)].sort());
  assert.ok(paths.includes("main.cjs") && paths.includes("kobrixa-plugin.json"));
  assert.equal(paths.includes("resource-index.json"), false);
  for (const file of index.files) {
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "path", "sha256"]);
    assert.ok(
      file.path === "main.cjs" ||
        /^(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.json$/.test(file.path),
    );
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
    const limit =
      file.path === "main.cjs"
        ? 16 * 1024 * 1024
        : file.path === "kobrixa-plugin.json"
          ? 64 * 1024
          : 1024 * 1024;
    assert.ok(file.bytes <= limit);
    const contents = await boundedFile(rootReal, file.path, limit);
    assert.equal(contents.length, file.bytes);
    assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256);
  }
  const manifest = JSON.parse(
    (await boundedFile(rootReal, "kobrixa-plugin.json", 64 * 1024)).toString("utf8"),
  );
  assert.equal(manifest.id, pluginId);
  assert.deepEqual(manifest.runtime, { kind: "node", entry: "main.cjs" });
  const resources = [
    ...(manifest.contributes.panels ?? []),
    ...(manifest.contributes.status ?? []),
  ].map((item) => {
    assert.equal(item.resource.version, 1);
    return item.resource.path;
  });
  assert.deepEqual(paths, [...new Set(["main.cjs", "kobrixa-plugin.json", ...resources])].sort());
  return index;
}
async function run(executable, args, options) {
  const child = spawn(executable, args, {
    ...options,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") child.kill("SIGKILL");
      }
    }
  }, 60_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(timedOut, false, "installed test timed out; process tree terminated");
    assert.equal(result.code, 0, `installed test failed: ${result.signal}`);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-installed-ui-"));
  console.log(`Installed fixture workspace (retained on failure): ${directory}`);
  const installed = path.join(directory, "installed");
  // This is a SYNTHETIC packaged host. The production packaged smoke remains a separate gate.
  await cp(
    path.join(root, `apps/desktop/out/Kobrixa-${process.platform}-${process.arch}`),
    installed,
    { recursive: true, verbatimSymlinks: true },
  );
  const appName =
    process.platform === "darwin"
      ? (await readdir(installed)).find((name) => name.endsWith(".app"))
      : null;
  assert.ok(process.platform !== "darwin" || appName);
  const resources = path.join(
    installed,
    process.platform === "darwin" ? `${appName}/Contents/Resources` : "resources",
  );
  const executable = path.join(
    installed,
    process.platform === "darwin"
      ? `${appName}/Contents/MacOS/kobrixa`
      : process.platform === "win32"
        ? "kobrixa.exe"
        : "kobrixa",
  );
  const source = path.join(directory, "asar-source");
  const leaf = path.join(source, ".vite/build/plugins/motor-test");
  await mkdir(source, { recursive: true });
  // Use the payload emitted by the REAL release builder. Rebuilding it here would
  // hide a missing build, validation or unpack step in the release path.
  const releaseArchive = path.join(resources, "app.asar");
  const releaseLeaf = path.join(`${releaseArchive}.unpacked`, ".vite/build/plugins/motor-test");
  const releaseIndex = await verifyLeaf(releaseLeaf, "kobrixa.motor-test");
  for (const name of [...releaseIndex.files.map((file) => file.path), "resource-index.json"])
    assert.equal(statFile(releaseArchive, `.vite/build/plugins/motor-test/${name}`).unpacked, true);
  await cp(releaseLeaf, leaf, { recursive: true });
  const builtIndex = await verifyLeaf(leaf, "kobrixa.motor-test");
  assert.ok(builtIndex.files.some((file) => file.path === "panel.json"));
  for (const name of ["main.cjs", "kobrixa-plugin.json", "resource-index.json", "panel.json"])
    assert.ok((await lstat(path.join(leaf, name))).isFile(), name);
  const registry = await readFile(
    path.join(root, "apps/desktop/src/main/plugins/builtin.ts"),
    "utf8",
  );
  assert.equal(registry.includes("motor-test"), false);
  assert.equal(registry.includes("kobrixa.motor-test"), false);
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "kobrixa-ui-installed-test", version: "0.0.0", main: "main.cjs" }),
  );
  await build({
    entryPoints: [path.join(root, "tests/desktop/declarative-ui-main.ts")],
    outfile: path.join(source, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: Object.fromEntries(
      [
        ["plugin-protocol", "plugin-protocol"],
        ["plugin-runtime", "plugin-runtime"],
        ["plugin-sdk", "plugin-sdk-js"],
      ].map(([name, folder]) => [
        `@kobrixa/${name}`,
        path.join(root, `packages/${folder}/src/index.ts`),
      ]),
    ),
    external: ["electron", "node-hid", "electron-updater"],
    plugins: [rawResourcePlugin()],
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
      MAIN_WINDOW_VITE_NAME: '"main_window"',
    },
  });
  const artifact = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
        .length > 0,
    hostSha256: createHash("sha256")
      .update(await readFile(path.join(source, "main.cjs")))
      .digest("hex"),
    releasePayloadIndex: builtIndex,
    platform: process.platform,
    arch: process.arch,
    syntheticHost: true,
  };
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(artifact, null, 2),
  );
  const archive = path.join(resources, "app.asar");
  await rm(archive, { force: true });
  await rm(`${archive}.unpacked`, { recursive: true, force: true });
  await createPackageWithOptions(source, archive, { unpack: BUILTIN_PAYLOAD_UNPACK });
  const packagedLeaf = path.join(`${archive}.unpacked`, ".vite/build/plugins/motor-test");
  const index = await verifyLeaf(packagedLeaf, "kobrixa.motor-test");
  const archived = listPackage(archive).map((name) => name.replaceAll("\\", "/"));
  for (const file of [...index.files.map((item) => item.path), "resource-index.json"]) {
    const name = `.vite/build/plugins/motor-test/${file}`;
    assert.ok(archived.includes(`/${name}`));
    assert.equal(statFile(archive, name).unpacked, true);
  }
  const cwd = path.join(directory, "unrelated-cwd");
  await mkdir(cwd);
  const emptyPath = path.join(directory, "empty-path");
  await mkdir(emptyPath);
  const env = { ...process.env, PATH: emptyPath };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PYTHONPATH"])
    delete env[key];
  const input = path.join(directory, "input.json");
  const output = path.join(directory, "installed.json");
  const launch = async (expectRejected, suffix) => {
    if (process.platform === "darwin") {
      // Only this temporary synthetic test host is changed. Keep a valid local
      // ad-hoc signature for each negative payload case; never bypass Gatekeeper
      // or modify the original packaged application's signature.
      await run(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          "-",
          "--timestamp=none",
          "--preserve-metadata=entitlements,requirements,flags",
          path.join(installed, appName),
        ],
        { cwd: directory },
      );
      await run(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", path.join(installed, appName)],
        { cwd: directory },
      );
    }
    await writeFile(input, JSON.stringify({ expectRejected }));
    await rm(output, { force: true });
    await run(
      executable,
      [
        "--ui-acceptance-mode=installed",
        `--ui-acceptance-input=${input}`,
        `--ui-acceptance-output=${output}`,
        `--user-data-dir=${path.join(directory, suffix)}`,
      ],
      { cwd, env },
    );
    return JSON.parse(await readFile(output, "utf8"));
  };
  const result = await launch(false, "healthy-profile");
  const entry = path.join(packagedLeaf, "main.cjs");
  const original = await readFile(entry);
  await rm(entry);
  const missing = await launch(true, "missing-profile");
  assert.equal(missing.phase, "resolve-before-launch");
  assert.equal(missing.launched, false);
  await writeFile(entry, Buffer.concat([original, Buffer.from("\n// changed hash\n")]));
  const corrupt = await launch(true, "corrupt-profile");
  assert.equal(corrupt.phase, "resolve-before-launch");
  assert.equal(corrupt.launched, false);
  await writeFile(entry, original);
  Object.assign(result, {
    noPathNode: env.PATH === emptyPath,
    noNodePath: !env.NODE_PATH,
    arbitraryCwd: cwd !== root,
    productionFixtureRegistered: false,
    missingRejected: missing.rejected,
    corruptRejected: corrupt.rejected,
    releasePayloadIndex: releaseIndex,
    missing,
    corrupt,
    artifact,
  });
  await writeFile(output, JSON.stringify(result, null, 2));
  await run(
    process.execPath,
    ["--test", path.join(root, "tests/desktop/builtin-process-packaging.test.mjs")],
    { cwd, env: { ...process.env, KOBRIXA_BUILTIN_REPORT: output } },
  );
  console.log(`Synthetic installed evidence: ${output}`);
  console.log(
    "Clean installation/offline/no-checkout access remains a controller environment gate.",
  );
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main();
