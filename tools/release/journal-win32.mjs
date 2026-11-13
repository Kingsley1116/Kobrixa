import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./common.mjs";

const desktop = path.join(repositoryRoot, "apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));
export const JOURNAL_PACKAGED = "native/journal-win32/journal_win32.node";
export const JOURNAL_DEVELOPMENT = "native/journal-win32/build/Release/journal_win32.node";
export const JOURNAL_PRODUCTION_EXPORTS = Object.freeze([
  "apiVersion",
  "arch",
  "capabilities",
  "durableReplace",
  "initializeDirectory",
  "napiVersion",
  "syncDirectory",
]);
export const JOURNAL_TEST_EXPORTS = [
  "inspect",
  "probeDirectoryFlush",
  "replaceCandidate",
  "withExclusiveFile",
];
export function withJournalUnpack(pattern, platform) {
  return platform === "win32" ? `{${pattern},${JOURNAL_PACKAGED}}` : pattern;
}

// Export names are literal N-API registration strings, including in stripped PE files.
// Check both architecture and test-only registrations before copying any binary.
export function validateProductionJournal(bytes, arch) {
  assert.ok(["x64", "arm64"].includes(arch), `Unsupported journal architecture: ${arch}`);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ", "Journal must be a Windows PE addon");
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", pe, pe + 4), "PE\0\0", "Invalid journal PE header");
  assert.equal(
    bytes.readUInt16LE(pe + 4),
    arch === "x64" ? 0x8664 : 0xaa64,
    "Journal architecture does not match target",
  );
  // "inspect" is also an internal error phase in the production source. The
  // other three names occur only in the hook export table; do not mistake dead
  // diagnostic strings for registered exports. Electron checks the full API below.
  for (const name of JOURNAL_TEST_EXPORTS.slice(1))
    assert.equal(
      bytes.includes(Buffer.from(`${name}\0`)),
      false,
      `Test-hook addon cannot ship: ${name}`,
    );
  for (const name of ["capabilities", "durableReplace", "syncDirectory", "initializeDirectory"])
    assert.ok(
      bytes.includes(Buffer.from(`${name}\0`)),
      `Missing production journal export: ${name}`,
    );
}

export function journalBuildArgs(directory, electronVersion, arch) {
  assert.ok(["x64", "arm64"].includes(arch), `Unsupported journal architecture: ${arch}`);
  return [
    "rebuild",
    `--directory=${directory}`,
    `--target=${electronVersion}`,
    `--arch=${arch}`,
    "--dist-url=https://electronjs.org/headers",
    `--devdir=${directory}/headers`,
    "--journal_test_hooks=0",
  ];
}

export async function buildProductionJournal({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "win32") return null;
  assert.equal(process.platform, "win32", "Build the Windows journal on a Windows host");
  const directory = await mkdtemp(
    path.join(process.env.RUNNER_TEMP || tmpdir(), "kobrixa-journal-production-"),
  );
  console.log(`Production journal build and evidence: ${directory}`);
  for (const file of ["journal.cc", "binding.gyp"])
    await copyFile(path.join(desktop, "native/journal-win32", file), path.join(directory, file));
  const electronVersion = require("electron/package.json").version;
  const args = journalBuildArgs(directory, electronVersion, arch);
  const build = spawnSync(
    process.execPath,
    [require.resolve("node-gyp/bin/node-gyp.js"), ...args],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = `${build.stdout ?? ""}\n${build.stderr ?? ""}`;
  await writeFile(path.join(directory, "build.log"), log);
  process.stdout.write(log);
  if (build.error) throw build.error;
  assert.equal(
    build.status,
    0,
    `Production journal build failed (${build.signal ?? build.status}); see ${directory}`,
  );
  const binary = path.join(directory, "build/Release/journal_win32.node");
  const bytes = await readFile(binary);
  validateProductionJournal(bytes, arch);
  // The same-arch build must also load in the pinned Electron runtime. Cross-arch
  // packages retain PE validation and require native target-host acceptance.
  if (arch === process.arch) {
    const validation = spawnSync(
      require("electron"),
      [
        "-e",
        `
      const assert = require('node:assert/strict'), addon = require(process.argv[1]);
      assert.equal(addon.apiVersion, '1'); assert.equal(addon.napiVersion, '8');
      assert.equal(addon.arch, process.arch);
      assert.deepEqual(Object.keys(addon).sort(), ${JSON.stringify(JOURNAL_PRODUCTION_EXPORTS)}.sort());
      console.log(JSON.stringify({ electron: process.versions.electron, arch: process.arch, exports: Object.keys(addon) }));
    `,
        binary,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
    );
    await writeFile(
      path.join(directory, "electron-load.log"),
      `${validation.stdout ?? ""}\n${validation.stderr ?? ""}`,
    );
    if (validation.error) throw validation.error;
    assert.equal(
      validation.status,
      0,
      `Production journal failed pinned Electron load; see ${directory}`,
    );
  }
  const hashes = {};
  for (const file of ["journal.cc", "binding.gyp", "build/Release/journal_win32.node"])
    hashes[file] = createHash("sha256")
      .update(await readFile(path.join(directory, file)))
      .digest("hex");
  await writeFile(
    path.join(directory, "build-receipt.json"),
    JSON.stringify({ electronVersion, arch, args, testHooks: false, hashes }, null, 2),
  );
  return binary;
}

export async function stageProductionJournal(
  stage,
  platform,
  arch,
  build = buildProductionJournal,
) {
  if (platform !== "win32") return;
  const binary = await build({ platform, arch });
  const bytes = await readFile(binary);
  validateProductionJournal(bytes, arch);
  const destination = path.join(stage, JOURNAL_PACKAGED);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

export async function buildDevelopmentJournal(options) {
  const binary = await buildProductionJournal(options);
  if (!binary) return;
  const destination = path.join(desktop, JOURNAL_DEVELOPMENT);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(binary, destination);
  console.log(`Production development journal: ${destination}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(
    process.argv.length,
    2,
    "This command builds only the host production addon; no hook or target overrides",
  );
  await buildDevelopmentJournal();
}
