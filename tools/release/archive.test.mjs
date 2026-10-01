import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPackageWithOptions } from "@electron/asar";
import {
  archiveName,
  expectedAssets,
  parseVersion,
  sha256,
  validateVersions,
  verifyChecksum,
} from "./common.mjs";
import { packageArchive, treeManifest, verifyApplication } from "./archive.mjs";

const version = "0.1.0-v1-candidate.0";
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, name, content = "fixture") {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}
async function fixture(t) {
  const root = await temporary(t);
  await put(root, "package.json", JSON.stringify({ version }));
  const directory = path.join(root, `apps/desktop/out/Kobrixa-${process.platform}-${process.arch}`);
  const app = path.join(root, "fixture-app");
  for (const file of [
    ".vite/build/main.cjs",
    ".vite/build/language-worker.cjs",
    ".vite/build/preload.cjs",
    ".vite/renderer/main_window/index.html",
    "node_modules/electron-updater/out/main.js",
    "node_modules/electron-updater/package.json",
    "node_modules/node-hid/package.json",
    "node_modules/node-addon-api/package.json",
    "node_modules/pkg-prebuilds/package.json",
    "node_modules/node-hid/build/Release/HID.node",
    "LICENSE",
    "THIRD-PARTY-NOTICES.txt",
  ])
    await put(app, file);
  await put(app, "package.json", JSON.stringify({ version }));
  const resources = path.join(
    directory,
    process.platform === "darwin" ? "Kobrixa.app/Contents/Resources" : "resources",
  );
  await mkdir(resources, { recursive: true });
  await put(
    resources,
    "app-update.yml",
    JSON.stringify({
      provider: "generic",
      url: "https://github.com/Kingsley1116/Kobrixa/releases/download/",
    }),
  );
  await put(resources, "kobrixa-update.json", JSON.stringify({ signedMac: false }));
  await createPackageWithOptions(app, path.join(resources, "app.asar"), { unpack: "**/*.node" });
  const executable = await put(
    directory,
    process.platform === "darwin"
      ? "Kobrixa.app/Contents/MacOS/kobrixa"
      : process.platform === "win32"
        ? "kobrixa.exe"
        : "kobrixa",
  );
  const header = Buffer.alloc(128);
  if (process.platform === "darwin") {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x0100000c, 4);
  } else if (process.platform === "linux") {
    Buffer.from("7f454c460201", "hex").copy(header);
    header.writeUInt16LE(62, 18);
  } else {
    header.write("MZ");
    header.writeUInt32LE(64, 60);
    header.writeUInt32LE(0x00004550, 64);
    header.writeUInt16LE(0x8664, 68);
  }
  await writeFile(executable, header);
  await chmod(executable, 0o755);
  await put(directory, ".hidden-resource", "must survive archiving");
  if (process.platform !== "win32")
    await symlink(path.relative(directory, executable), path.join(directory, "executable-link"));
  return { root, directory, resources, executable };
}

test("validates SemVer, prereleases and target archive names", () => {
  assert.equal(parseVersion(version).prerelease, true);
  assert.equal(parseVersion("1.2.3+build.5").prerelease, false);
  for (const invalid of ["01.2.3", "1.2", "1.2.3-01", "1.2.3/../x", "1.2.3-", "v1.2.3"])
    assert.throws(() => parseVersion(invalid));
  assert.equal(archiveName(version, "linux", "x64"), `Kobrixa-${version}-linux-x64.tar.gz`);
  assert.equal(archiveName(version, "win32", "x64"), `Kobrixa-${version}-win32-x64.zip`);
  assert.equal(archiveName(version, "darwin", "arm64"), `Kobrixa-${version}-darwin-arm64.zip`);
  assert.throws(() => archiveName(version, "darwin", "x64"));
  assert.equal(expectedAssets(version).length, 6);
});

test("checks versions in root and every workspace, including web", async (t) => {
  const root = await temporary(t);
  for (const name of [
    "package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/compiler/package.json",
    "frontends/basic-plus/package.json",
  ])
    await put(root, name, JSON.stringify({ version }));
  assert.equal((await validateVersions(`v${version}`, root)).version, version);
  await put(root, "apps/web/package.json", JSON.stringify({ version: "9.0.0" }));
  await assert.rejects(validateVersions(`v${version}`, root), /apps[/\\]web/);
  await assert.rejects(validateVersions(version, root), /start with v/);
});

test("round-trips the host archive preserving all files, hidden resources, links and permissions", async (t) => {
  const { root, directory } = await fixture(t);
  const before = await treeManifest(directory, process.platform);
  assert.ok(before[".hidden-resource"]);
  const archive = await packageArchive({ root });
  assert.ok((await readFile(archive)).length > 0);
  assert.equal(
    await readFile(`${archive}.sha256`, "utf8"),
    `${await sha256(archive)}  ${path.basename(archive)}\n`,
  );
  await verifyChecksum(archive);
  await writeFile(archive, "corrupted after upload");
  await assert.rejects(verifyChecksum(archive), /Checksum mismatch/);
});

test("rejects missing packages, wrong package versions and missing native USB files", async (t) => {
  const { root, directory, resources } = await fixture(t);
  await assert.rejects(verifyApplication(directory, process.platform, "9.0.0"), /version/);
  await rm(path.join(resources, "app.asar.unpacked"), { recursive: true });
  await assert.rejects(packageArchive({ root }), /ENOENT/);
  await rm(directory, { recursive: true });
  await assert.rejects(packageArchive({ root }), /ENOENT/);
});

test("signed archives are verified again after extraction before a checksum can be published", async (t) => {
  const { root } = await fixture(t);
  const calls = [];
  const modes = { macos: true, windows: true };
  const archive = await packageArchive({
    root,
    modes,
    verifySignature: (directory, _platform, actualVersion, actualModes) => {
      calls.push(directory);
      assert.equal(actualVersion, version);
      assert.deepEqual(actualModes, modes);
    },
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
  let checked = 0;
  await assert.rejects(
    packageArchive({
      root,
      modes,
      verifySignature: () => {
        if (++checked === 2) throw new Error("Extracted signature failed");
      },
    }),
    /Extracted signature failed/,
  );
  await assert.rejects(readFile(`${archive}.sha256`), /ENOENT/);
});

test("rejects missing .vite entrypoints and lost executable permissions", async (t) => {
  const { root, directory, resources, executable } = await fixture(t);
  if (process.platform !== "win32") {
    await chmod(executable, 0o644);
    await assert.rejects(verifyApplication(directory, process.platform, version), /permission/);
    await chmod(executable, 0o755);
  }
  const broken = path.join(root, "broken-app");
  await put(broken, "package.json", JSON.stringify({ version }));
  const asar = path.join(resources, "app.asar");
  // Use a fresh location because the ASAR library caches headers by path.
  await rm(asar);
  const { uncache } = await import("@electron/asar");
  uncache(asar);
  await createPackageWithOptions(broken, asar, {});
  await assert.rejects(
    verifyApplication(directory, process.platform, version),
    /Missing packaged file/,
  );
});

test("rejects a renamed binary of the wrong architecture and external symlinks", async (t) => {
  const { directory, executable } = await fixture(t);
  const header = await readFile(executable);
  header.writeUInt16LE(
    0,
    process.platform === "darwin" ? 4 : process.platform === "linux" ? 18 : 68,
  );
  await writeFile(executable, header);
  await assert.rejects(
    verifyApplication(directory, process.platform, version),
    /Expected (arm64|x64)/,
  );
  if (process.platform !== "win32") {
    await symlink(executable, path.join(directory, "absolute-link"));
    await assert.rejects(treeManifest(directory, process.platform), /Non-portable/);
  }
});
