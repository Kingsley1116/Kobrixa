// W04: read-only current-source checks; receipts are written only to an explicit output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const schemaPaths = [
  "packages/plugin-protocol/schema/plugin-protocol.schema.json",
  "sdks/python/kobrixa/plugin-protocol.schema.json",
];
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (file) => readFile(path.join(root, file), "utf8");
export async function publication() {
  const protocol = await read("packages/plugin-protocol/src/limits.ts");
  const python = await read("sdks/python/kobrixa/_plugin.py");
  const schemas = await Promise.all(schemaPaths.map(read));
  assert.match(protocol, /PLUGIN_API_VERSION = "1\.8\.0"/);
  assert.match(python, /API_VERSION = "1\.8\.0"/);
  assert.equal(schemas[0], schemas[1]);
  assert.equal(
    JSON.parse(schemas[0]).$id,
    "https://kobrixa.com/schemas/plugin-protocol/1.8.0.json",
  );
  const manifests = {};
  for (const [name, range] of [
    ["motor-test", "^1.6.0"],
    ["sensor-lab", "^1.8.0"],
    ["device-ev3", "^1.8.0"],
  ]) {
    const manifest = JSON.parse(await read(`plugins/${name}/kobrixa-plugin.json`));
    assert.equal(manifest.apiVersion, range);
    manifests[name] = range;
  }
  return {
    apiVersion: "1.8.0",
    schemaSha256: sha(schemas[0]),
    jsDistribution: JSON.parse(await read("packages/plugin-sdk-js/package.json")).version,
    pythonDistribution: (await read("sdks/python/pyproject.toml")).match(
      /^version = "([^"]+)"/m,
    )[1],
    manifests,
  };
}
export async function sourceHashes() {
  const files = [
    ...schemaPaths,
    "tsconfig.base.json",
    "pnpm-lock.yaml",
    "vitest.config.ts",
    "tools/run-python-tests.mjs",
    "tests/desktop/stage-3-contracts-run.mjs",
    "tests/desktop/stage-3-contracts.test.mjs",
    "tests/desktop/plugin-persistence-compatibility.ts",
    "tests/desktop/plugin-persistence-compatibility.test.mjs",
  ];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (["node_modules", "dist", "__pycache__", ".vite"].includes(entry.name)) continue;
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && !file.endsWith(".tsbuildinfo")) files.push(file);
    }
  }
  for (const directory of [
    "packages/plugin-protocol",
    "packages/plugin-sdk-js",
    "packages/plugin-runtime",
    "sdks/python",
  ])
    await walk(directory);
  for (const name of ["motor-test", "sensor-lab", "device-ev3"])
    files.push(`plugins/${name}/kobrixa-plugin.json`);
  return Object.fromEntries(
    await Promise.all(
      [...new Set(files)]
        .sort()
        .map(async (file) => [file, sha(await readFile(path.join(root, file)))]),
    ),
  );
}
export async function validateNative(input) {
  const { verifyCompatibility } = await import("./plugin-persistence-compatibility.ts");
  const { verifyRunReceipt } = await import("./plugin-persistence-harness.mjs");
  assert.equal(input.level, "real-process");
  const receipts = input.reports.filter((report) => report.case === "compatibility");
  assert.equal(receipts.length, 1, "Exactly one native compatibility receipt required");
  const receipt = receipts[0];
  verifyRunReceipt(receipt);
  assert.equal(
    receipt.evidence.compatibility.hostVersion,
    "1.8.0",
    "Historical publication is not current acceptance",
  );
  const result = verifyCompatibility(receipt.evidence.compatibility);
  for (const file of schemaPaths)
    assert.equal(receipt.evidence.compatibility.schema.first, await read(file), file);
  assert.ok(receipt.evidence.compatibility.artifacts.length > 0, "Missing native artifacts");
  for (const artifact of receipt.evidence.compatibility.artifacts)
    assert.equal(sha(await readFile(artifact.path)), artifact.sha256, artifact.path);
  for (const entry of receipt.evidence.compatibility.cases.filter((entry) => entry.sdk === "1.8.0"))
    for (const [file, hash] of Object.entries(entry.sourceHashes))
      assert.equal(sha(await readFile(path.join(root, file))), hash, file);
  return result;
}
export async function run(output, nativeInput) {
  assert.ok(path.isAbsolute(output), "Output must be a new absolute path");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "kobrixa-w04-"));
  const receipt = {
    format: 1,
    started: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    runtime: process.version,
    scratch,
    commands: [],
    failures: [],
    native: { status: "NOT RUN" },
  };
  function command(label, executable, args, cwd = root) {
    const result = spawnSync(executable, args, {
      cwd,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", CI: "1" },
    });
    const observation = {
      label,
      executable,
      args,
      cwd,
      exit: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error?.message ?? null,
    };
    receipt.commands.push(observation);
    assert.equal(result.status, 0, `${label}: ${observation.stderr.slice(-2000)}`);
    return observation.stdout;
  }
  async function check(label, fn) {
    try {
      await fn();
    } catch (error) {
      receipt.failures.push({ label, error: error.message });
    }
  }
  receipt.before = await sourceHashes();
  await check("publication", async () => {
    receipt.publication = await publication();
  });
  await check("contract validators", () =>
    command("contract validators", process.execPath, [
      "--experimental-transform-types",
      "--import",
      "./tests/desktop/persistence-source-loader.mjs",
      "--test",
      "tests/desktop/stage-3-contracts.test.mjs",
      "tests/desktop/plugin-persistence-compatibility.test.mjs",
    ]),
  );
  await check("unit suites", () =>
    command("protocol SDK runtime", process.execPath, [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/plugin-protocol/src",
      "packages/plugin-sdk-js/src",
      "packages/plugin-runtime/src",
    ]),
  );
  await check("Python SDK", () =>
    command("Python SDK", process.execPath, ["tools/run-python-tests.mjs"]),
  );
  receipt.schemas = [];
  for (const generation of [1, 2])
    await check(`schema generation ${generation}`, async () => {
      // Execute the unchanged package schema script in two independent source copies.
      // This preserves the package write boundary, including generated dist files.
      const workspace = path.join(scratch, `generation-${generation}`);
      const pkg = path.join(workspace, "packages/plugin-protocol");
      await mkdir(pkg, { recursive: true });
      for (const file of ["src", "scripts", "package.json", "tsconfig.json"])
        await cp(path.join(root, "packages/plugin-protocol", file), path.join(pkg, file), {
          recursive: true,
        });
      await cp(path.join(root, "tsconfig.base.json"), path.join(workspace, "tsconfig.base.json"));
      await symlink(
        path.join(root, "node_modules"),
        path.join(workspace, "node_modules"),
        "junction",
      );
      await symlink(
        path.join(root, "packages/plugin-protocol/node_modules"),
        path.join(pkg, "node_modules"),
        "junction",
      );
      for (const file of schemaPaths)
        await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      command(
        `schema ${generation} tsc`,
        process.execPath,
        [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
        pkg,
      );
      command(`schema ${generation} export`, process.execPath, ["scripts/export-schema.mjs"], pkg);
      const bytes = await Promise.all(
        schemaPaths.map((file) => readFile(path.join(workspace, file))),
      );
      assert.deepEqual(bytes[0], bytes[1]);
      for (const file of schemaPaths)
        assert.deepEqual(bytes[0], await readFile(path.join(root, file)), file);
      command(`schema ${generation} git diff`, "git", [
        "diff",
        "--exit-code",
        "--",
        ...schemaPaths,
      ]);
      receipt.schemas.push({
        generation,
        sha256: sha(bytes[0]),
        paths: schemaPaths.map((file) => path.join(workspace, file)),
      });
    });
  if (nativeInput)
    await check("native compatibility", async () => {
      receipt.native = {
        status: "PASSED",
        input: nativeInput,
        sha256: sha(await readFile(nativeInput)),
        checks: await validateNative(JSON.parse(await readFile(nativeInput, "utf8"))),
      };
    });
  receipt.after = await sourceHashes();
  await check("source stability", () => assert.deepEqual(receipt.after, receipt.before));
  receipt.status = receipt.failures.length
    ? "FAILED"
    : receipt.native.status === "PASSED"
      ? "PASSED"
      : "PARTIAL";
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify(
      { output, status: receipt.status, failures: receipt.failures, scratch },
      null,
      2,
    ),
  );
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(process.argv[2], process.argv[3]);
    if (result.status !== "PASSED") process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
