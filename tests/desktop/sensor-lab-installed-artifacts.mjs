import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
export async function verifyLeaf(directory, pluginId = "kobrixa.sensor-lab") {
  const rootReal = await realpath(directory);
  assert.equal(
    rootReal,
    path.resolve(directory),
    "Artifact root cannot alias a checkout through a symlink",
  );
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
    assert.equal(item.resource.version, 2);
    return item.resource.path;
  });
  assert.deepEqual(paths, [...new Set(["main.cjs", "kobrixa-plugin.json", ...resources])].sort());
  return index;
}
