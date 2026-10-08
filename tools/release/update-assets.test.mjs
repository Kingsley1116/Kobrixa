import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const parse = JSON.parse;
const stringify = JSON.stringify;
import {
  installerNames,
  prepareUpdateAssets,
  targetAssets,
  writeUpdateMetadata,
  verifyUpdateMetadata,
} from "./update-assets.mjs";
import { updateMetadataName } from "../../apps/desktop/src/shared/updates.ts";

test("release metadata describes final bytes and rejects stale hashes and external paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-updates-"));
  try {
    for (const platform of ["win32", "darwin", "linux"]) {
      const arch = platform === "darwin" ? "arm64" : "x64",
        version = "1.0.0-v1-candidate.3";
      const payload = path.join(
        directory,
        installerNames(version, platform, arch, { macos: true })[0],
      );
      await writeFile(payload, "final signed bytes");
      await writeUpdateMetadata(directory, version, platform, arch);
      await verifyUpdateMetadata(directory, version, platform, arch);
      await writeFile(payload, "modified after signing");
      await assert.rejects(
        verifyUpdateMetadata(directory, version, platform, arch),
        /checksum mismatch/,
      );
      await writeUpdateMetadata(directory, version, platform, arch);
      const metadataFile = path.join(directory, updateMetadataName(platform));
      const metadata = parse(await readFile(metadataFile, "utf8"));
      metadata.files[0].url = "https://example.org/not-a-release.exe";
      await writeFile(metadataFile, stringify(metadata));
      await assert.rejects(verifyUpdateMetadata(directory, version, platform, arch), /asset/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("only signed macOS builds advertise automatic updates", () => {
  assert.ok(!targetAssets("1.0.0", "darwin", "arm64", { macos: false }).includes("latest-mac.yml"));
  assert.ok(targetAssets("1.0.0", "darwin", "arm64", { macos: true }).includes("latest-mac.yml"));
  assert.ok(targetAssets("1.0.0", "win32", "x64", { windows: false }).includes("latest.yml"));
});

test("unsigned Mac releases contain only DMG and its staging checksum", () => {
  assert.deepEqual(targetAssets("1.0.0", "darwin", "arm64"), [
    "Kobrixa-1.0.0-darwin-arm64.dmg",
    "Kobrixa-1.0.0-darwin-arm64.dmg.sha256",
  ]);
  const signed = targetAssets("1.0.0", "darwin", "arm64", { macos: true });
  assert.ok(signed.includes("Kobrixa-1.0.0-darwin-arm64-update.zip"));
  assert.ok(!signed.includes("Kobrixa-1.0.0-darwin-arm64.zip"));
});

test("switching Mac signing off removes stale update and ordinary ZIP outputs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-mac-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = path.join(root, "apps/desktop/out");
  await mkdir(path.join(out, "installers"), { recursive: true });
  const version = "1.0.0";
  for (const name of installerNames(version, "darwin", "arm64", { macos: true }))
    await writeFile(path.join(out, "installers", name), "application fixture");
  await prepareUpdateAssets(version, "darwin", "arm64", { macos: true }, root);
  for (const suffix of [".zip", ".zip.sha256"])
    await writeFile(
      path.join(out, "release", `Kobrixa-${version}-darwin-arm64${suffix}`),
      "obsolete",
    );
  await prepareUpdateAssets(version, "darwin", "arm64", { macos: false }, root);
  assert.deepEqual(
    (await readdir(path.join(out, "release"))).sort(),
    targetAssets(version, "darwin", "arm64").sort(),
  );
});

test("packaging arm64 followed by x64 preserves the arm64 update metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-mac-multiarch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = path.join(root, "apps/desktop/out");
  await mkdir(path.join(out, "installers"), { recursive: true });
  const version = "1.0.0";
  for (const name of installerNames(version, "darwin", "arm64", { macos: true }))
    await writeFile(path.join(out, "installers", name), "arm64 fixture");
  await prepareUpdateAssets(version, "darwin", "arm64", { macos: true }, root);

  const metadataPath = path.join(out, "release", updateMetadataName("darwin"));
  const arm64Metadata = await readFile(metadataPath, "utf8");
  assert.ok(arm64Metadata.includes(`Kobrixa-${version}-darwin-arm64-update.zip`));

  for (const name of installerNames(version, "darwin", "x64", { macos: true }))
    await writeFile(path.join(out, "installers", name), "x64 fixture");
  await prepareUpdateAssets(version, "darwin", "x64", { macos: true }, root);

  const preservedMetadata = await readFile(metadataPath, "utf8");
  assert.equal(preservedMetadata, arm64Metadata);
});
