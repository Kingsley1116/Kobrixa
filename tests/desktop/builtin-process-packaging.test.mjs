import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyLeaf } from "./builtin-process-installed.mjs";

async function makeLeaf(directory) {
  const manifest = {
    id: "acceptance.ui",
    runtime: { kind: "node", entry: "main.cjs" },
    contributes: { panels: [{ resource: { version: 1, path: "panel.json" } }] },
  };
  const files = {
    "main.cjs": "process.exit(0);",
    "kobrixa-plugin.json": JSON.stringify(manifest),
    "panel.json": '{"kind":"panel"}',
  };
  await mkdir(directory, { recursive: true });
  const index = { version: 1, pluginId: manifest.id, files: [] };
  for (const name of Object.keys(files).sort()) {
    const contents = files[name];
    await writeFile(path.join(directory, name), contents);
    index.files.push({
      path: name,
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  await writeFile(path.join(directory, "resource-index.json"), JSON.stringify(index));
  return index;
}
test("U14/B1-RF5: missing/corrupt/foreign/traversing payloads fail closed", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ui-payload-audit-"));
  try {
    const leaf = path.join(temporary, "leaf");
    let index = await makeLeaf(leaf);
    assert.deepEqual(await verifyLeaf(leaf, "acceptance.ui"), index);
    await rm(path.join(leaf, "main.cjs"));
    await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    index = await makeLeaf(leaf);
    await writeFile(path.join(leaf, "main.cjs"), "corruption");
    await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    await makeLeaf(leaf);
    await assert.rejects(verifyLeaf(leaf, "another.plugin"));
    for (const change of [
      (i) => {
        i.files.push(i.files[0]);
      },
      (i) => {
        i.files[0].path = "../escape.json";
      },
      (i) => {
        i.files[0].sha256 = i.files[0].sha256.toUpperCase();
      },
      (i) => {
        i.files.reverse();
      },
      (i) => {
        i.files.push({ path: "resource-index.json", bytes: 1, sha256: "a".repeat(64) });
      },
      (i) => {
        i.files[0].bytes++;
      },
      (i) => {
        i.extra = true;
      },
      (i) => {
        i.files[0].extra = true;
      },
    ]) {
      index = await makeLeaf(leaf);
      change(index);
      await writeFile(path.join(leaf, "resource-index.json"), JSON.stringify(index));
      await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    }
    await makeLeaf(leaf);
    await writeFile(path.join(leaf, "resource-index.json"), " ".repeat(16385));
    await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    if (process.platform !== "win32") {
      await makeLeaf(leaf);
      const outside = path.join(temporary, "outside.cjs");
      await writeFile(outside, "process.exit(0);");
      await rm(path.join(leaf, "main.cjs"));
      await symlink(outside, path.join(leaf, "main.cjs"));
      await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test(
  "U14: installed receipt contains actual isolated process evidence",
  {
    skip: process.env.KOBRIXA_BUILTIN_REPORT
      ? false
      : "controller-installed run required; audit-only is not installed evidence",
  },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_BUILTIN_REPORT, "utf8"));
    assert.equal(report.kind, "installed-builtin");
    assert.equal(report.packaged, true);
    assert.equal(report.noPathNode, true);
    assert.equal(report.noNodePath, true);
    assert.equal(report.arbitraryCwd, true);
    assert.equal(report.missingRejected, true);
    assert.equal(report.corruptRejected, true);
    assert.equal(report.productionFixtureRegistered, false);
    assert.equal(report.resolvedFromInstalledRoot, true);
    assert.equal(report.results[0].exited, true);
    assert.deepEqual(report.remainingPids, []);
  },
);
