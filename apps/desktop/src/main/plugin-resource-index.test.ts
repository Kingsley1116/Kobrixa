import { fileURLToPath } from "node:url";
import { build } from "vite";
import { validateBuiltinLeaf } from "./plugins/builtin-launch.js";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { emitResourceIndex } from "../../plugin-resource-index.js";
import { builtinPluginConfig } from "../../vite.plugin.config.js";

const indexRoots: string[] = [];
afterEach(async () => {
  await Promise.all(indexRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("copies original bytes and indexes the executable, manifest and declared JSON only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-index-"));
  indexRoots.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(path.join(source, "ui"), { recursive: true });
  await mkdir(output);
  const manifest = {
    id: "acme.fixture",
    version: "1.0.0",
    apiVersion: "^1.6.0",
    runtime: { kind: "node", entry: "main.cjs" },
    permissions: ["ui.panels"],
    contributes: {
      panels: [
        {
          id: "acme.fixture.panel",
          title: { en: "Fixture" },
          location: "right",
          resource: { version: 1, path: "ui/panel.json" },
        },
      ],
    },
  };
  const resource = Buffer.from('{\n "version": 1, "unicode": "世界"\n}\n');
  await writeFile(path.join(source, "kobrixa-plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(source, "ui/panel.json"), resource);
  await writeFile(path.join(output, "main.cjs"), "module.exports = {};\n");
  const index = await emitResourceIndex(source, output, "acme.fixture");
  expect(index.files.map((file) => file.path)).toEqual([
    "kobrixa-plugin.json",
    "main.cjs",
    "ui/panel.json",
  ]);
  expect(await readFile(path.join(output, "ui/panel.json"))).toEqual(resource);
  expect(index.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  expect(index.files.some((file) => file.path === "resource-index.json")).toBe(false);
  await rm(path.join(source, "ui/panel.json"));
  await expect(emitResourceIndex(source, output, "acme.fixture")).rejects.toBeDefined();
});
it("uses isolated leaf cleanup, CJS, inline dynamic imports and no workspace external", () => {
  const config = builtinPluginConfig({
    slug: "motor-test",
    pluginId: "kobrixa.motor-test",
    sourceRoot: "/trusted/source",
    buildRoot: "/trusted/build",
  });
  expect(config.build).toMatchObject({
    outDir: "/trusted/build/plugins/motor-test",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [],
      output: {
        format: "cjs",
        entryFileNames: "main.cjs",
        inlineDynamicImports: true,
      },
    },
  });
  expect(config.build?.outDir).not.toBe("/trusted/build");
});

it("uses the CLI outDir for bundle, manifest, index and resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-outdir-"));
  try {
    const sourceRoot = fileURLToPath(
      new URL("../../../../tests/desktop/fixtures/builtin-process", import.meta.url),
    );
    const output = path.join(root, "override");
    const config = builtinPluginConfig({
      slug: "motor-test",
      pluginId: "kobrixa.motor-test",
      sourceRoot,
    });
    await build({ ...config, configFile: false, build: { ...config.build, outDir: output } });
    const payload = await validateBuiltinLeaf(output, "kobrixa.motor-test");
    expect(payload.root).toBe(await realpath(output));
    expect(payload.index.files.map((file) => file.path)).toContain("main.cjs");
    expect(payload.index.files.map((file) => file.path)).toContain("kobrixa-plugin.json");
    expect(Object.keys(payload.resources).length).toBeGreaterThan(0);
    expect(
      JSON.parse(await readFile(path.join(output, "resource-index.json"), "utf8")).pluginId,
    ).toBe("kobrixa.motor-test");
    const code = await readFile(path.join(output, "main.cjs"), "utf8");
    expect(code).not.toMatch(/\brequire\(["']@kobrixa\//);
    const map = JSON.parse(await readFile(path.join(output, "main.cjs.map"), "utf8")) as {
      sources: string[];
    };
    expect(
      map.sources.some((source) => source.includes("packages/plugin-sdk-js/src/index.ts")),
    ).toBe(true);
    expect(
      map.sources.some((source) => source.includes("packages/plugin-protocol/src/peer.ts")),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
