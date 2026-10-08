import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
const parse = JSON.parse;
const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;
import { updateArtifactName, updateMetadataName } from "../../apps/desktop/src/shared/updates.ts";
import {
  archiveName,
  isMain,
  readVersion,
  repositoryRoot,
  sha256,
  verifyChecksum,
} from "./common.mjs";
import { signingModes } from "../../apps/desktop/signing.ts";

export function installerNames(version, platform, arch, modes = { macos: false }) {
  return [
    ...(platform !== "darwin" || (modes.macos && arch !== "x64")
      ? [updateArtifactName(version, platform, arch)]
      : []),
    ...(platform === "darwin" ? [`Kobrixa-${version}-${platform}-${arch}.dmg`] : []),
  ];
}
export function targetAssets(version, platform, arch, modes = { macos: false, windows: false }) {
  const archives = [
    ...(platform === "darwin" ? [] : [archiveName(version, platform, arch)]),
    ...installerNames(version, platform, arch, modes),
  ];
  return [
    ...archives.flatMap((name) => [name, `${name}.sha256`]),
    ...(platform !== "darwin" || (modes.macos && arch !== "x64")
      ? [updateMetadataName(platform)]
      : []),
  ];
}
export async function sha512(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}
export async function writeUpdateMetadata(directory, version, platform, arch) {
  const name = updateArtifactName(version, platform, arch);
  const file = path.join(directory, name);
  const value = {
    version,
    files: [{ url: name, sha512: await sha512(file), size: (await stat(file)).size }],
    path: name,
    sha512: await sha512(file),
  };
  await writeFile(path.join(directory, updateMetadataName(platform)), stringify(value));
}
export async function verifyUpdateMetadata(directory, version, platform, arch) {
  const metadata = parse(
    await readFile(path.join(directory, updateMetadataName(platform)), "utf8"),
  );
  const name = updateArtifactName(version, platform, arch);
  const file = path.join(directory, name);
  assert.equal(metadata.version, version, "Updater version mismatch");
  assert.deepEqual(
    metadata.files,
    [{ url: name, sha512: await sha512(file), size: (await stat(file)).size }],
    "Updater asset, size or checksum mismatch",
  );
  assert.equal(metadata.path, name, "Updater path mismatch");
  assert.equal(metadata.sha512, await sha512(file), "Updater checksum mismatch");
}
export async function verifyTargetAssets(directory, version, platform, arch, modes) {
  for (const name of targetAssets(version, platform, arch, modes).filter(
    (name) => !name.endsWith(".sha256") && !name.endsWith(".yml"),
  ))
    await verifyChecksum(path.join(directory, name));
  if (platform !== "darwin" || (modes.macos && arch !== "x64"))
    await verifyUpdateMetadata(directory, version, platform, arch);
}
export async function prepareUpdateAssets(version, platform, arch, modes, root = repositoryRoot) {
  const out = path.join(root, "apps/desktop/out");
  await mkdir(path.join(out, "release"), { recursive: true });
  // Remove obsolete local Mac outputs when changing signing modes or upgrading the pipeline.
  if (platform === "darwin") {
    for (const name of [
      archiveName(version, platform, arch),
      ...(!modes.macos ? [updateArtifactName(version, platform, arch)] : []),
    ]) {
      await rm(path.join(out, "release", name), { force: true });
      await rm(path.join(out, "release", `${name}.sha256`), { force: true });
    }
  }
  for (const name of installerNames(version, platform, arch, modes)) {
    const file = path.join(out, "release", name);
    await cp(path.join(out, "installers", name), file);
    await writeFile(`${file}.sha256`, `${await sha256(file)}  ${name}\n`);
  }
  if (platform !== "darwin") {
    await writeUpdateMetadata(path.join(out, "release"), version, platform, arch);
  } else if (arch !== "x64") {
    if (modes.macos) await writeUpdateMetadata(path.join(out, "release"), version, platform, arch);
    else await rm(path.join(out, "release", updateMetadataName(platform)), { force: true });
  }
  await verifyTargetAssets(path.join(out, "release"), version, platform, arch, modes);
}
if (isMain(import.meta))
  await prepareUpdateAssets(
    await readVersion(),
    process.env.TARGET_PLATFORM || process.platform,
    process.env.TARGET_ARCH || process.arch,
    process.env.KOBRIXA_RELEASE_BUILD === "true"
      ? signingModes()
      : { macos: false, windows: false },
  );
