import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { PluginManager } from "../../packages/plugin-runtime/dist/index.js";
import { validateStaticLanguageResources } from "../../packages/plugin-protocol/dist/index.js";
import {
  writeStaticLanguageFixtures,
  readStaticLanguageFixtures,
} from "./static-languages-fixtures.mjs";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

async function withManager(sources, check) {
  let launches = 0;
  const manager = await PluginManager.create({
    sources,
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
    safeMode: false,
    locale: "en",
    launcher: async () => {
      launches++;
      throw new Error("Unexpected process launch");
    },
  });
  try {
    await check(manager);
    assert.equal(launches, 0);
  } finally {
    await manager.shutdown();
  }
}

test("real validation, mixed runtimes, failure quarantine and fresh enable generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-real-"));
  try {
    const paths = await writeStaticLanguageFixtures(root);
    const file = path.join(paths.toy, "kobrixa-plugin.json");
    const original = JSON.parse(await readFile(file, "utf8"));
    for (const kind of ["static", "node", "python"]) {
      const manifest = structuredClone(original);
      manifest.runtime = kind === "static" ? { kind } : { kind, entry: "entry.txt" };
      await writeFile(path.join(paths.toy, "entry.txt"), "must not execute");
      await writeFile(file, JSON.stringify(manifest));
      await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
        const first = manager.staticLanguages();
        const language = first.languages.find((value) => value.id === "toy");
        assert.ok(language);
        assert.equal(manager.state().plugins[0].running, false);
        const report = {
          sourceKey: language.sourceKey,
          generation: language.generation,
          languageId: language.id,
          revision: first.revision,
          reason: "monaco",
          detail: "Integration registration failure",
        };
        assert.equal(manager.reportLanguageRegistrationFailure(report).accepted, true);
        const failed = manager.staticLanguages();
        assert.equal(failed.languages.length, 0);
        assert.equal(manager.reportLanguageRegistrationFailure(report).accepted, false);
        assert.equal(manager.staticLanguages().revision, failed.revision);
        assert.equal((await manager.setEnabled(language.sourceKey, false)).ok, true);
        assert.equal((await manager.setEnabled(language.sourceKey, true)).ok, true);
        const enabled = manager.staticLanguages().languages[0];
        assert.ok(enabled.generation > language.generation, "R1: fresh enable generation");
        assert.equal((await manager.reloadSource(language.sourceKey)).ok, true);
        assert.ok(manager.staticLanguages().languages[0].generation > enabled.generation);
      });
    }
    const forbidden = structuredClone(original);
    forbidden.contributes.languageServices = [];
    await writeFile(file, JSON.stringify(forbidden));
    await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
      const row = manager.state().plugins[0];
      assert.equal(row.status, "invalid");
      assert.ok(row.problems.some((p) => p.code === "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN"));
    });
    await writeFile(file, JSON.stringify(original));
    const resource = path.join(paths.toy, "language/tokenizer.json");
    const raw = await readFile(resource, "utf8");
    await writeFile(resource, "\uFEFF" + raw);
    await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
      assert.equal(
        manager.staticLanguages().languages[0].resourceBytes.tokenizer,
        Buffer.byteLength(raw, "utf8") + 3,
      );
    });
    const invalid = JSON.parse(raw);
    invalid.states[0].rules[0].regex.pattern = String.raw`\$S1`;
    await writeFile(resource, JSON.stringify(invalid));
    await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
      assert.equal(manager.staticLanguages().languages.length, 0);
      assert.equal(manager.state().plugins[0].status, "enabled");
      assert.ok(
        manager
          .state()
          .plugins[0].problems.some(
            (p) => p.code === "PLUGIN_E_STATIC_LANGUAGE" && p.detail.languageId === "toy",
          ),
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontend reservation and extension conflicts are independent of source order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-conflict-"));
  try {
    const paths = await writeStaticLanguageFixtures(root);
    const { builtin, binding } = await readStaticLanguageFixtures();
    const broken = structuredClone(builtin);
    broken.resources["language/tokenizer.json"] = "{}";
    const sources = [
      broken,
      { kind: "development", directory: paths.toy },
      { kind: "development", directory: paths.shared },
    ];
    let expected;
    for (const order of [sources, [...sources].reverse()]) {
      await withManager(order, async (manager) => {
        const catalog = manager.staticLanguages();
        assert.equal(catalog.extensionRoutes.toy, null);
        assert.equal(
          catalog.languages.some((value) => value.id === binding.language),
          false,
        );
        const normalized = {
          ids: catalog.languages.map((value) => value.id).sort(),
          conflicts: catalog.conflicts
            .map((value) => [
              value.kind,
              value.key,
              value.sources.map((source) => source.pluginId).sort(),
            ])
            .sort(),
        };
        if (expected) assert.deepEqual(normalized, expected);
        expected = normalized;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped raw resources pass the real validator and esbuild preserves their bytes", async () => {
  const base = new URL("../../plugins/basic-plus/", import.meta.url);
  const tokenizer = await readFile(new URL("language/tokenizer.json", base), "utf8");
  const configuration = await readFile(new URL("language/configuration.json", base), "utf8");
  const result = validateStaticLanguageResources({
    languageId: "bp",
    formatVersion: 1,
    limitsVersion: 1,
    tokenizer: JSON.parse(tokenizer),
    configuration: JSON.parse(configuration),
    resourceBytes: {
      tokenizer: Buffer.byteLength(tokenizer),
      configuration: Buffer.byteLength(configuration),
    },
    resourcePaths: {
      tokenizer: "language/tokenizer.json",
      configuration: "language/configuration.json",
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.rules, result.regexes, result.expandedRules], [9, 11, 9]);
  const bundled = await build({
    stdin: {
      contents: 'export { default } from "./plugins/basic-plus/language/tokenizer.json?raw";',
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [rawResourcePlugin()],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  assert.equal(module.default, tokenizer);
});

test("production IPC, preload and browser acceptance entries bundle without fixture loaders", async () => {
  for (const entry of [
    "tests/desktop/static-languages-main.ts",
    "apps/desktop/src/preload/index.ts",
  ]) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      plugins: [rawResourcePlugin()],
    });
    assert.ok(result.outputFiles[0].contents.length > 0);
  }
  const browser = await build({
    entryPoints: ["tests/desktop/static-languages-browser.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    loader: { ".css": "empty", ".ttf": "dataurl" },
  });
  assert.ok(browser.outputFiles[0].contents.length > 0);
});
