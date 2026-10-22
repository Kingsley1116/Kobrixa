import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageWithOptions, statFile } from "@electron/asar";
import {
  buildBuiltinPayloads,
  validateBuiltinPayloads,
  BUILTIN_PAYLOAD_UNPACK,
} from "./desktop-packaging.mjs";

test("release packaging builds, validates and unpacks the same builtin leaves as Forge", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-release-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "build");
  await buildBuiltinPayloads(false, output);
  await assert.rejects(readFile(path.join(output, "plugins/motor-test/main.cjs")), {
    code: "ENOENT",
  });
  await buildBuiltinPayloads(true, output);
  const stage = path.join(root, "stage");
  await mkdir(path.join(stage, ".vite"), { recursive: true });
  await cp(output, path.join(stage, ".vite/build"), { recursive: true });
  await validateBuiltinPayloads(stage, true);
  const leaf = path.join(stage, ".vite/build/plugins/motor-test");
  const index = JSON.parse(await readFile(path.join(leaf, "resource-index.json"), "utf8"));
  assert.equal(index.pluginId, "kobrixa.motor-test");
  await mkdir(path.join(stage, "node_modules/native"), { recursive: true });
  await writeFile(path.join(stage, "node_modules/native/addon.node"), "native");
  const archive = path.join(root, "app.asar");
  await createPackageWithOptions(stage, archive, { unpack: BUILTIN_PAYLOAD_UNPACK });
  for (const name of [...index.files.map((file) => file.path), "resource-index.json"]) {
    const relative = `.vite/build/plugins/motor-test/${name}`;
    assert.equal(statFile(archive, relative).unpacked, true);
    assert.deepEqual(
      await readFile(path.join(`${archive}.unpacked`, relative)),
      await readFile(path.join(leaf, name)),
    );
  }
  assert.equal(statFile(archive, "node_modules/native/addon.node").unpacked, true);
  await writeFile(path.join(leaf, "main.cjs"), "corrupt");
  await assert.rejects(validateBuiltinPayloads(stage, true), { code: "PLUGIN_E_ENTRY" });
  await rm(leaf, { recursive: true });
  await assert.rejects(validateBuiltinPayloads(stage, true), { code: "PLUGIN_E_ENTRY" });
});
