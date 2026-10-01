import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const parse = JSON.parse;
const stringify = JSON.stringify;
import {
  installerNames,
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
      const payload = path.join(directory, installerNames(version, platform, arch)[0]);
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
