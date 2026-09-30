import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import { signingModes } from "../../apps/desktop/signing.ts";
import { verifySignedApplication } from "./signing.mjs";
import {
  archiveName,
  isMain,
  readVersion,
  repositoryRoot,
  sha256,
  verifyChecksum,
} from "./common.mjs";

export function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

export async function treeManifest(root, platform) {
  const entries = {};
  async function visit(relative) {
    const full = path.join(root, relative);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      entries[relative] = { link: await readlink(full) };
    } else if (stat.isDirectory()) {
      for (const entry of (await readdir(full)).sort())
        await visit(path.posix.join(relative, entry));
    } else {
      entries[relative] = {
        hash: await sha256(full),
        ...(platform === "win32" ? {} : { executable: stat.mode & 0o111 }),
      };
    }
  }
  await visit("");
  return entries;
}

export async function verifyApplication(directory, platform, version) {
  const resources = path.join(
    directory,
    platform === "darwin" ? "Kobrixa.app/Contents/Resources" : "resources",
  );
  const executable = path.join(
    directory,
    platform === "darwin"
      ? "Kobrixa.app/Contents/MacOS/kobrixa"
      : platform === "win32"
        ? "kobrixa.exe"
        : "kobrixa",
  );
  const executableStat = await lstat(executable);
  assert.ok(executableStat.size > 0, "Packaged executable is empty");
  if (platform !== "win32") assert.ok(executableStat.mode & 0o111, "Executable permission missing");
  const asar = path.join(resources, "app.asar");
  const files = listPackage(asar).map((name) => name.replaceAll("\\", "/").replace(/^\//, ""));
  const manifest = JSON.parse(extractFile(asar, "package.json").toString());
  assert.equal(manifest.version, version, "Packaged version differs from release version");
  for (const required of [
    ".vite/build/main.cjs",
    ".vite/build/language-worker.cjs",
    ".vite/build/preload.cjs",
    ".vite/renderer/main_window/index.html",
    "node_modules/node-hid/package.json",
    "node_modules/node-addon-api/package.json",
    "node_modules/pkg-prebuilds/package.json",
    "LICENSE",
    "THIRD-PARTY-NOTICES.txt",
  ]) {
    assert.ok(files.includes(required), `Missing packaged file: ${required}`);
  }
  const nativeFiles = files.filter(
    (name) => name.startsWith("node_modules/node-hid/") && name.endsWith(".node"),
  );
  assert.ok(nativeFiles.length > 0, "No native USB modules found");
  for (const name of nativeFiles) {
    assert.ok(
      (await lstat(path.join(`${asar}.unpacked`, name))).size > 0,
      `Missing unpacked USB module: ${name}`,
    );
  }
}

export async function packageArchive({
  root = repositoryRoot,
  platform = process.platform,
  arch = process.arch,
  execute = run,
  modes = { macos: false, windows: false },
  verificationEnv = process.env,
  verifySignature = verifySignedApplication,
} = {}) {
  const version = await readVersion(root);
  const name = archiveName(version, platform, arch);
  assert.equal(platform, process.platform, "Archive must be built on its target OS");
  assert.equal(arch, process.arch, "Archive must be built on its target architecture");
  const output = path.join(root, "apps/desktop/out");
  const directoryName = `Kobrixa-${platform}-${arch}`;
  const directory = path.join(output, directoryName);
  await verifyApplication(directory, platform, version);
  await verifySignature(directory, platform, version, modes, verificationEnv);
  const before = await treeManifest(directory, platform);
  const releaseDirectory = path.join(output, "release");
  await mkdir(releaseDirectory, { recursive: true });
  const archive = path.join(releaseDirectory, name);
  // Remove only this target's previous generated files, never a published release.
  await rm(archive, { force: true });
  await rm(`${archive}.sha256`, { force: true });
  if (platform === "darwin") {
    execute("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", directory, archive]);
  } else {
    execute("tar", [platform === "win32" ? "-acf" : "-czf", archive, "-C", output, directoryName]);
  }
  const extracted = await mkdtemp(path.join(tmpdir(), "kobrixa-archive-"));
  try {
    if (platform === "darwin") execute("ditto", ["-x", "-k", archive, extracted]);
    else execute("tar", ["-xf", archive, "-C", extracted]);
    const restored = path.join(extracted, directoryName);
    assert.deepEqual(
      await treeManifest(restored, platform),
      before,
      "Archive changed files, symlinks or executable permissions",
    );
    await verifyApplication(restored, platform, version);
    await verifySignature(restored, platform, version, modes, verificationEnv);
    await writeFile(`${archive}.sha256`, `${await sha256(archive)}  ${name}\n`);
    await verifyChecksum(archive);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
  console.log(`Verified archive: ${archive}`);
  return archive;
}

if (isMain(import.meta)) {
  await packageArchive({
    platform: process.env.TARGET_PLATFORM || process.platform,
    arch: process.env.TARGET_ARCH || process.arch,
    modes:
      process.env.KOBRIXA_RELEASE_BUILD === "true"
        ? signingModes()
        : { macos: false, windows: false },
  });
}
