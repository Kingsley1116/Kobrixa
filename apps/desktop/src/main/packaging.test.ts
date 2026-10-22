import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBundledNotices,
  copyNativeDependencies,
  PERSISTENCE_WORKER_ENTRY,
  persistenceWorkerPath,
  withPersistenceWorkerUnpack,
} from "../../packaging.js";

const roots: string[] = [];

async function put(root: string, name: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), content);
}

async function fixture(
  sources: string[],
  workerSources: string[] = [],
): Promise<{ buildPath: string; nodeModules: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-notices-"));
  roots.push(root);
  const nodeModules = path.join(root, "node_modules");
  const buildPath = path.join(root, "stage");
  await put(buildPath, ".vite/build/main.cjs.map", JSON.stringify({ version: 3, sources }));
  await put(
    buildPath,
    ".vite/renderer/main_window/assets/workers/editor.worker.js.map",
    JSON.stringify({ version: 3, sources: workerSources }),
  );
  for (const [directory, name] of [
    ["node_modules/yjs", "yjs"],
    ["node_modules/@nodelib/fs.stat", "@nodelib/fs.stat"],
    ["node_modules/fast-glob/node_modules/glob-parent", "glob-parent"],
    ["node_modules/.pnpm/lib0@1.0.0/node_modules/lib0", "lib0"],
    ["node_modules/monaco-editor", "monaco-editor"],
  ] as const) {
    await put(root, `${directory}/package.json`, JSON.stringify({ name, version: "1.0.0" }));
    await put(root, `${directory}/LICENSE`, `${name} license`);
  }
  return { buildPath, nodeModules };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundled dependency notices", () => {
  it("copies native transitive packages and their matching notices without hoisting", async () => {
    const { buildPath, nodeModules } = await fixture([]);
    const root = path.dirname(nodeModules);
    const desktopPackage = path.join(root, "apps/desktop/package.json");
    await put(root, "apps/desktop/package.json", "{}");
    const hid = path.join(nodeModules, ".pnpm/node-hid@3.4.0/node_modules/node-hid");
    const addon = path.join(nodeModules, ".pnpm/node-addon-api@8.9.2/node_modules/node-addon-api");
    const prebuild = path.join(nodeModules, ".pnpm/pkg-prebuilds@1.1.0/node_modules/pkg-prebuilds");
    for (const [directory, name, version, license] of [
      [hid, "node-hid", "3.4.0", "LICENSE-bsd.txt"],
      [addon, "node-addon-api", "8.9.2", "LICENSE.md"],
      [prebuild, "pkg-prebuilds", "1.1.0", "LICENSE"],
    ] as const) {
      await put(directory, "package.json", JSON.stringify({ name, version }));
      await put(directory, license, `${name} ${version} license`);
    }
    await mkdir(path.join(root, "apps/desktop/node_modules"));
    await symlink(hid, path.join(root, "apps/desktop/node_modules/node-hid"), "junction");
    await symlink(addon, path.join(hid, "../node-addon-api"), "junction");
    await symlink(prebuild, path.join(hid, "../pkg-prebuilds"), "junction");
    await put(hid, "prebuilds/node-darwin-arm64/hid.node", "target");
    await put(hid, "prebuilds/node-win32-x64/hid.node", "foreign");
    await copyNativeDependencies(buildPath, "darwin", "arm64", desktopPackage);
    expect(await readdir(path.join(buildPath, "node_modules/node-hid/prebuilds"))).toEqual([
      "node-darwin-arm64",
    ]);
    const notices = await readFile(path.join(buildPath, "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const name of ["node-hid", "node-addon-api", "pkg-prebuilds"]) {
      const copied = JSON.parse(
        await readFile(path.join(buildPath, "node_modules", name, "package.json"), "utf8"),
      ) as { name: string; version: string };
      expect(notices).toContain(`${copied.name} ${copied.version} license`);
    }
  });
  it("lists every package referenced by staged source maps, including scoped and nested ones", async () => {
    const { buildPath, nodeModules } = await fixture(
      [
        "../../src/main/index.ts",
        "../../../../node_modules/yjs/dist/yjs.mjs",
        "../../../../node_modules/yjs/dist/internals.mjs",
        "../../../../node_modules/@nodelib/fs.stat/out/index.js",
        "../../../../node_modules/fast-glob/node_modules/glob-parent/index.js",
        "../../../../node_modules/.pnpm/lib0@1.0.0/node_modules/lib0/encoding.js",
        "\u0000commonjsHelpers.js",
      ],
      // Workers are emitted deeper than the main bundle, so their relative paths differ.
      ["../../../../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
    );
    const notices = await collectBundledNotices(buildPath, nodeModules);
    expect(notices.map(({ name, text }) => [name, text])).toEqual([
      ["@nodelib/fs.stat", "@nodelib/fs.stat license"],
      ["glob-parent", "glob-parent license"],
      ["lib0", "lib0 license"],
      ["monaco-editor", "monaco-editor license"],
      ["yjs", "yjs license"],
    ]);
  });

  it("fails instead of omitting a bundled package without a license file", async () => {
    const { buildPath, nodeModules } = await fixture(["../../../../node_modules/yjs/dist/yjs.mjs"]);
    await rm(path.join(nodeModules, "yjs/LICENSE"));
    await expect(collectBundledNotices(buildPath, nodeModules)).rejects.toThrow(
      "No license file for bundled dependency yjs",
    );
  });

  it("fails when the staged bundles carry no source maps", async () => {
    const { buildPath, nodeModules } = await fixture([]);
    await rm(path.join(buildPath, ".vite"), { recursive: true });
    await mkdir(path.join(buildPath, ".vite"));
    await expect(collectBundledNotices(buildPath, nodeModules)).rejects.toThrow("No source maps");
  });
});

import { BUILTIN_PAYLOAD_UNPACK, DELIVERED_BUILTIN_PROCESS_BUILDS } from "../../packaging.js";
import { builtinPluginConfig } from "../../vite.plugin.config.js";
it("keeps native unpack and feature payload unpack in the same packaging rule", () => {
  expect(BUILTIN_PAYLOAD_UNPACK).toBe("{**/*.node,**/.vite/build/plugins/**}");
  expect(DELIVERED_BUILTIN_PROCESS_BUILDS).toEqual([]);
});
it("does not externalize SDK or protocol or share chunks between process leaves", () => {
  const result = builtinPluginConfig({
    slug: "acceptance-builtin",
    pluginId: "acceptance.ui",
    sourceRoot: "/fixture",
  });
  expect(result.build?.rollupOptions?.external).toEqual([]);
  expect(result.build?.rollupOptions?.output).toMatchObject({
    format: "cjs",
    inlineDynamicImports: true,
  });
});

describe("persistence worker packaging", () => {
  it("selects only the development or installed artifact root", () => {
    expect(PERSISTENCE_WORKER_ENTRY).toBe("src/main/plugins/persistence/worker.ts");
    expect(
      persistenceWorkerPath({ packaged: false, resourcesPath: "ignored", buildRoot: "/build" }),
    ).toBe(path.join("/build", "persistence-worker.cjs"));
    expect(
      persistenceWorkerPath({
        packaged: true,
        resourcesPath: "/installed/resources",
        buildRoot: "ignored",
      }),
    ).toBe(
      path.join(
        "/installed/resources",
        "app.asar.unpacked",
        ".vite",
        "build",
        "persistence-worker.cjs",
      ),
    );
    for (const packaged of [false, true]) {
      expect(() =>
        persistenceWorkerPath({ packaged, resourcesPath: "relative", buildRoot: "relative" }),
      ).toThrow("absolute");
    }
  });

  it("preserves nested native and plugin unpack patterns and adds the worker once", () => {
    const worker = "**/.vite/build/persistence-worker.cjs";
    for (const existing of [
      "",
      "**/*.node",
      BUILTIN_PAYLOAD_UNPACK,
      "{**/*.{node,dll},**/plugin-bundles/**}",
      worker,
      `{**/*.node,${worker}}`,
    ]) {
      const once = withPersistenceWorkerUnpack(existing);
      expect(withPersistenceWorkerUnpack(once)).toBe(once);
      expect(once.split(worker)).toHaveLength(2);
      if (existing.includes("**/*.node")) expect(once).toContain("**/*.node");
      if (existing.includes("**/*.{node,dll}")) expect(once).toContain("**/*.{node,dll}");
      if (existing.includes("**/.vite/build/plugins/**"))
        expect(once).toContain("**/.vite/build/plugins/**");
    }
    expect(withPersistenceWorkerUnpack(BUILTIN_PAYLOAD_UNPACK)).toBe(
      "{**/*.node,**/.vite/build/plugins/**,**/.vite/build/persistence-worker.cjs}",
    );
  });

  it("registers one worker entry without replacing the main entry", async () => {
    const config = await readFile(new URL("../../forge.config.ts", import.meta.url), "utf8");
    expect(config.match(/entry:\s*PERSISTENCE_WORKER_ENTRY/g)).toHaveLength(1);
    expect(config).toContain("withPersistenceWorkerUnpack(BUILTIN_PAYLOAD_UNPACK)");
    const mainConfig = await readFile(
      new URL("../../vite.main.config.ts", import.meta.url),
      "utf8",
    );
    expect(mainConfig).toContain('"persistence-worker.cjs"');
    expect(mainConfig).toContain('"main.cjs"');
  });
});

const installedResources = process.env.PERSISTENCE_INSTALLED_RESOURCES;
it.skipIf(!installedResources)(
  "starts the installed worker from arbitrary cwd and observes normal exit",
  async () => {
    if (!installedResources) throw new Error("installed resources required");
    const entry = persistenceWorkerPath({
      packaged: true,
      resourcesPath: installedResources,
      buildRoot: "unused",
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "kobrixa-installed-worker-"));
    roots.push(cwd);
    const script = `
    const { Worker } = require("node:worker_threads");
    const { mkdirSync, realpathSync } = require("node:fs");
    const path = require("node:path");
    const directory = path.join(process.cwd(), "store");
    mkdirSync(directory, { mode: 0o700 });
    const root = realpathSync(directory);
    // Match the host's openStoreRoot bootstrap before passing its private root.
    mkdirSync(path.join(root, "namespaces"), { mode: 0o700 });
    const held = new SharedArrayBuffer(16 + 1024 * 16 + 1024 * 4);
    Atomics.store(new Int32Array(held), 0, 1);
    const worker = new Worker(process.argv[1], { workerData: {} });
    let ready = false;
    const timer = setTimeout(() => {
      console.error("installed worker did not exit normally");
      worker.terminate().then(() => { process.exitCode = 2; });
    }, 10000);
    worker.once("error", error => { console.error(error); process.exitCode = 1; });
    worker.once("message", message => {
      if (message.version !== 1 || message.kind !== "ready" || message.recovery !== "ready") {
        console.error("invalid worker readiness", JSON.stringify(message));
        worker.terminate().then(() => { process.exitCode = 3; });
        return;
      }
      ready = true;
      worker.postMessage({ version: 1, kind: "close" });
    });
    worker.once("exit", code => {
      clearTimeout(timer);
      Atomics.store(new Int32Array(held), 0, 0);
      if (ready && code === 0) process.stdout.write("installed-worker-ready-and-exited");
      else process.exitCode = 4;
    });
    worker.postMessage({ version: 1, kind: "boot", hostEpoch: "10000000-0000-4000-8000-000000000001", root, held });
  `;
    const child = spawn(process.execPath, ["-e", script, entry], {
      cwd,
      env: { ...process.env, PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 12000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(stdout).toBe("installed-worker-ready-and-exited");
    } finally {
      clearTimeout(timeout);
    }
  },
  15000,
);
