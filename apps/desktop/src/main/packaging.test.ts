import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundledNotices } from "../../packaging.js";

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
