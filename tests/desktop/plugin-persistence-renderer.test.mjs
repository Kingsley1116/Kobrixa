import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFoundationRenderer } from "./plugin-persistence-renderer-build.mjs";

test("retained renderer evidence rejects changed preload, page, script, and substituted paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "persistence-renderer-oracle-"));
  const files = {
    "preload.cjs": "oracle preload",
    "renderer/index.html": "oracle page",
    "renderer/app.js": "oracle script",
  };
  const receipt = path.join(root, "renderer-artifact.json");
  const artifact = {
    format: 1,
    root,
    preload: path.join(root, "preload.cjs"),
    rendererUrl: pathToFileURL(path.join(root, "renderer/index.html")).href,
    sha256: Object.fromEntries(
      Object.entries(files).map(([file, bytes]) => [
        file,
        createHash("sha256").update(bytes).digest("hex"),
      ]),
    ),
  };
  try {
    await mkdir(path.join(root, "renderer"));
    for (const [file, bytes] of Object.entries(files))
      await writeFile(path.join(root, file), bytes);
    await writeFile(receipt, JSON.stringify(artifact));
    assert.equal((await readFoundationRenderer(receipt)).preload, artifact.preload);
    for (const [file, bytes] of Object.entries(files)) {
      await writeFile(path.join(root, file), `${bytes} changed`);
      await assert.rejects(readFoundationRenderer(receipt), /Changed renderer artifact/);
      await writeFile(path.join(root, file), bytes);
    }
    for (const mutate of [
      (value) => {
        value.preload = path.join(root, "foreign.cjs");
      },
      (value) => {
        value.rendererUrl = "https://invalid.example/";
      },
      (value) => {
        delete value.sha256["renderer/app.js"];
      },
      (value) => {
        value.sha256["../foreign.cjs"] = "a".repeat(64);
      },
    ]) {
      const changed = structuredClone(artifact);
      mutate(changed);
      await writeFile(receipt, JSON.stringify(changed));
      await assert.rejects(readFoundationRenderer(receipt));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
