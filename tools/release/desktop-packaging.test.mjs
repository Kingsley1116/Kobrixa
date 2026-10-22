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
  PERSISTENCE_WORKER_ENTRY,
  withPersistenceWorkerUnpack,
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
  await writeFile(path.join(stage, ".vite/build/persistence-worker.cjs"), "worker fixture");
  const archive = path.join(root, "app.asar");
  await createPackageWithOptions(stage, archive, {
    unpack: withPersistenceWorkerUnpack(BUILTIN_PAYLOAD_UNPACK),
  });
  for (const name of [...index.files.map((file) => file.path), "resource-index.json"]) {
    const relative = `.vite/build/plugins/motor-test/${name}`;
    assert.equal(statFile(archive, relative).unpacked, true);
    assert.deepEqual(
      await readFile(path.join(`${archive}.unpacked`, relative)),
      await readFile(path.join(leaf, name)),
    );
  }
  assert.equal(statFile(archive, "node_modules/native/addon.node").unpacked, true);
  assert.equal(statFile(archive, ".vite/build/persistence-worker.cjs").unpacked, true);
  assert.equal(
    await readFile(`${archive}.unpacked/.vite/build/persistence-worker.cjs`, "utf8"),
    "worker fixture",
  );
  await writeFile(path.join(leaf, "main.cjs"), "corrupt");
  await assert.rejects(validateBuiltinPayloads(stage, true), { code: "PLUGIN_E_ENTRY" });
  await rm(leaf, { recursive: true });
  await assert.rejects(validateBuiltinPayloads(stage, true), { code: "PLUGIN_E_ENTRY" });
});

test("release builder registers the same persistence worker and unpack rule as Forge", async () => {
  assert.equal(PERSISTENCE_WORKER_ENTRY, "src/main/plugins/persistence/worker.ts");
  const builder = await readFile(new URL("./build-desktop.mjs", import.meta.url), "utf8");
  assert.match(
    builder,
    /\["vite\.main\.config\.ts", PERSISTENCE_WORKER_ENTRY, "persistence-worker\.cjs"\]/,
  );
  assert.match(builder, /forgeConfigSelf: \{ entry \}/);
  assert.match(builder, /asarUnpack: \[withPersistenceWorkerUnpack\(BUILTIN_PAYLOAD_UNPACK\)\]/);
});
