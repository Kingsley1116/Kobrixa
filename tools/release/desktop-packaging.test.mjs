import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "vite";
import { buildProduction } from "./production-vite.mjs";
import { assertProductionRenderer } from "./production-renderer.mjs";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPackageWithOptions, listPackage, statFile } from "@electron/asar";
import {
  buildDesktopEntry,
  buildBuiltinPayloads,
  validateBuiltinPayloads,
  BUILTIN_PAYLOAD_UNPACK,
  PERSISTENCE_WORKER_ENTRY,
  withPersistenceWorkerUnpack,
} from "./desktop-packaging.mjs";

test("importing desktop-packaging preserves NODE_ENV", async () => {
  for (const previous of [undefined, "development", "test", "production"]) {
    const env = { ...process.env };
    if (previous === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previous;
    // A fresh process per value exercises top-level evaluation every time.
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const before = process.env.NODE_ENV;
      await import(${JSON.stringify(new URL("./desktop-packaging.mjs", import.meta.url).href)});
      assert.equal(process.env.NODE_ENV, before);
    `,
      ],
      { env },
    );
  }
});

test("production Vite builds emit production React even with a development caller", async (t) => {
  const previous = process.env.NODE_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  process.env.NODE_ENV = "development";
  const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const config = {
    configFile: false,
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: desktopRequire.resolve("react-dom/client") } },
  };
  async function check(result) {
    const chunks = result.output.filter((entry) => entry.type === "chunk");
    const scripts = new Map(chunks.map(({ fileName, code }) => [fileName, code]));
    await assertProductionRenderer([...scripts.keys()], (file) => scripts.get(file));
  }
  await check(await buildProduction(build, config));
  assert.equal(process.env.NODE_ENV, "development");
  await assert.rejects(
    check(await build({ ...config, mode: "production" })),
    /Development React marker/,
  );
});

test("renderer checks reject mixed React chunks and missing production code", async () => {
  const files = {
    "vendor.js": "Minified React error #",
    "worker.js": 'const transform = "jsxDEV"',
    "app.js": "runtime.jsxDEV(Component)",
    "app.js.map": "react-dom-client.development.js",
  };
  const read = (name) => files[name];
  await assertProductionRenderer(["vendor.js", "worker.js", "app.js.map"], read);
  await assert.rejects(
    assertProductionRenderer(Object.keys(files), read),
    /Development React marker in app.js/,
  );
  await assert.rejects(assertProductionRenderer(["worker.js"], read), /Missing production React/);
});

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
      let cryptoLoads = 0;
      const Module = require("node:module"), originalLoad = Module._load;
      Module._load = function (id, ...args) {
        if (id === "node:crypto" || id === "crypto") cryptoLoads++;
        return originalLoad.call(this, id, ...args);
      };
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
        if (${JSON.stringify(slug)} === "sensor-lab" && cryptoLoads === 0)
          throw new Error("Production Lab must use Node crypto, not a browser shim");
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
  const inventory = new Set(listPackage(archive));
  async function assertUnpacked(relative) {
    // ASAR traverses directories by path.sep: member lookup must use host paths,
    // even though resource-index paths and unpack glob patterns use forward slashes.
    const member = path.normalize(relative);
    assert.ok(inventory.has(path.join(path.sep, member)), `Missing ASAR member: ${member}`);
    const entry = statFile(archive, member);
    assert.equal(entry.unpacked, true, member);
    const source = await readFile(path.join(stage, member));
    assert.deepEqual(await readFile(path.join(`${archive}.unpacked`, member)), source);
    assert.equal(entry.integrity.hash, createHash("sha256").update(source).digest("hex"));
  }
  for (const slug of ["motor-test", "sensor-lab", "device-ev3"]) {
    const payload = path.join(stage, ".vite/build/plugins", slug);
    const manifest = JSON.parse(await readFile(path.join(payload, "resource-index.json"), "utf8"));
    assert.equal(manifest.pluginId, `kobrixa.${slug}`);
    for (const name of [...manifest.files.map((file) => file.path), "resource-index.json"]) {
      const relative = `.vite/build/plugins/${slug}/${name}`;
      await assertUnpacked(relative);
    }
  }
  await assertUnpacked("node_modules/native/addon.node");
  await assertUnpacked(".vite/build/persistence-worker.cjs");
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
  assert.match(builder, /await buildDesktopEntry\(config, entry, name\)/);
  const helper = await readFile(new URL("./desktop-packaging.mjs", import.meta.url), "utf8");
  assert.match(helper, /forgeConfigSelf: \{ entry \}/);
  assert.match(
    builder,
    /withJournalUnpack\(withPersistenceWorkerUnpack\(BUILTIN_PAYLOAD_UNPACK\), platform\)/,
  );
});

test(
  "production persistence entry boots beside an existing native main bundle",
  { timeout: 15000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-release-worker-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const main = path.join(directory, "main.cjs");
    await writeFile(main, "native main fixture");
    await buildDesktopEntry(
      "vite.main.config.ts",
      PERSISTENCE_WORKER_ENTRY,
      "persistence-worker.cjs",
      directory,
    );
    assert.equal(await readFile(main, "utf8"), "native main fixture");
    const root = path.join(directory, "plugins/persistence-v1");
    await mkdir(path.join(root, "namespaces"), { recursive: true, mode: 0o700 });
    const held = new SharedArrayBuffer(16 + 1024 * 16 + 1024 * 4);
    Atomics.store(new Int32Array(held), 0, 1);
    const worker = new Worker(path.join(directory, "persistence-worker.cjs"), { workerData: {} });
    t.after(async () => {
      await worker.terminate();
      Atomics.store(new Int32Array(held), 0, 0);
    });
    const ready = once(worker, "message");
    worker.postMessage({
      version: 1,
      kind: "boot",
      hostEpoch: "10000000-0000-4000-8000-000000000001",
      root,
      held,
    });
    const [message] = await ready;
    assert.equal(message.version, 1);
    assert.equal(message.kind, "ready");
    assert.equal(message.recovery, "ready");
    const exit = once(worker, "exit");
    worker.postMessage({ version: 1, kind: "close" });
    assert.deepEqual(await exit, [0]);
  },
);

test("Windows packages contain only the production journal at the exact unpacked loader path", async (t) => {
  const { stageProductionJournal, withJournalUnpack, JOURNAL_PACKAGED } =
    await import("./journal-win32.mjs");
  const { journalFixture } = await import("./journal-win32-fixture.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-journal-package-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const production = path.join(root, "production.node");
  const hooks = path.join(root, "hooks.node");
  await writeFile(production, journalFixture());
  await writeFile(hooks, journalFixture("x64", true));
  for (const platform of ["win32", "darwin", "linux"]) {
    const stage = path.join(root, platform);
    await mkdir(stage);
    await writeFile(path.join(stage, "package.json"), "{}");
    let builds = 0;
    await stageProductionJournal(stage, platform, "x64", async (target) => {
      assert.deepEqual(target, { platform: "win32", arch: "x64" });
      builds++;
      return production;
    });
    assert.equal(builds, platform === "win32" ? 1 : 0);
    const archive = path.join(root, `${platform}.asar`);
    const base = withPersistenceWorkerUnpack(BUILTIN_PAYLOAD_UNPACK);
    const unpack = withJournalUnpack(base, platform);
    if (platform !== "win32") assert.equal(unpack, base, "POSIX unpack rule must not change");
    await createPackageWithOptions(stage, archive, { unpack });
    const journalMembers = listPackage(archive).filter((member) => member.endsWith(".node"));
    if (platform === "win32") {
      assert.deepEqual(journalMembers, [path.join(path.sep, JOURNAL_PACKAGED)]);
      assert.equal(statFile(archive, path.normalize(JOURNAL_PACKAGED)).unpacked, true);
      assert.deepEqual(
        await readFile(path.join(`${archive}.unpacked`, JOURNAL_PACKAGED)),
        journalFixture(),
      );
    } else assert.deepEqual(journalMembers, []);
  }
  const rejected = path.join(root, "rejected");
  await assert.rejects(
    stageProductionJournal(rejected, "win32", "x64", async () => hooks),
    /Test-hook addon cannot ship/,
  );
  await assert.rejects(readFile(path.join(rejected, JOURNAL_PACKAGED)), { code: "ENOENT" });
  await assert.rejects(
    stageProductionJournal(rejected, "win32", "arm64", async () => production),
    /architecture does not match/,
  );
});
