import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  // Execute the exact production leaf with the utility-process channel boundary.
  // Environment metadata must be read at launch, never replaced by a browser build.
  for (const slug of ["motor-test", "sensor-lab"]) {
    const script = `
      let reads = 0;
      const original = process.env;
      process.env = new Proxy(original, { get(target, key) {
        if (key === "KOBRIXA_RESOURCE_OWNER") reads++;
        return target[key];
      }});
      process.parentPort = { once(_name, listener) { listener({ ports: [{
        start() {}, on() {}, off() {}, postMessage() {}
      }] }); } };
      require(process.argv[1]);
      setImmediate(() => {
        if (reads !== 1) throw new Error("Production leaf discarded launch owner metadata");
        console.log("launch-owner-read");
      });
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["-e", script, path.join(output, "plugins", slug, "main.cjs")],
      {
        timeout: 5000,
        env: {
          ...process.env,
          KOBRIXA_RESOURCE_OWNER: JSON.stringify({
            sourceKey: `builtin:kobrixa.${slug}`,
            pluginId: `kobrixa.${slug}`,
            generation: 0,
            hostEpoch: "11111111-1111-4111-8111-111111111111",
            processEpoch: "22222222-2222-4222-8222-222222222222",
          }),
        },
      },
    );
    assert.equal(stdout.trim(), "launch-owner-read");
  }
  await assert.rejects(
    buildBuiltinPayloads(true, output),
    /conflicts with the delivered motor payload/,
  );
  const stage = path.join(root, "stage");
  await mkdir(path.join(stage, ".vite"), { recursive: true });
  await cp(output, path.join(stage, ".vite/build"), { recursive: true });
  await validateBuiltinPayloads(stage, false);
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
  for (const slug of ["motor-test", "sensor-lab"]) {
    const payload = path.join(stage, ".vite/build/plugins", slug);
    const manifest = JSON.parse(await readFile(path.join(payload, "resource-index.json"), "utf8"));
    assert.equal(manifest.pluginId, `kobrixa.${slug}`);
    for (const name of [...manifest.files.map((file) => file.path), "resource-index.json"]) {
      const relative = `.vite/build/plugins/${slug}/${name}`;
      assert.equal(statFile(archive, relative).unpacked, true);
      assert.deepEqual(
        await readFile(path.join(`${archive}.unpacked`, relative)),
        await readFile(path.join(payload, name)),
      );
    }
  }
  assert.equal(statFile(archive, "node_modules/native/addon.node").unpacked, true);
  assert.equal(statFile(archive, ".vite/build/persistence-worker.cjs").unpacked, true);
  assert.equal(
    await readFile(`${archive}.unpacked/.vite/build/persistence-worker.cjs`, "utf8"),
    "worker fixture",
  );
  await writeFile(path.join(leaf, "main.cjs"), "corrupt");
  await assert.rejects(validateBuiltinPayloads(stage, false), { code: "PLUGIN_E_ENTRY" });
  await rm(leaf, { recursive: true });
  await assert.rejects(validateBuiltinPayloads(stage, false), { code: "PLUGIN_E_ENTRY" });
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
