import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { developmentSourceKey } from "../../packages/plugin-runtime/dist/index.js";
import {
  readStaticLanguageFixtures,
  writeStaticLanguageFixtures,
} from "./static-languages-fixtures.mjs";
import {
  basicPlusSmokeCatalog,
  createStaticLanguagesHarness,
} from "./static-languages-harness.mjs";

test("copies T0 toy bytes and constructs distinct conflict and invalid-resource fixtures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-static-contract-"));
  try {
    const paths = await writeStaticLanguageFixtures(directory);
    const fixtures = await readStaticLanguageFixtures();
    const read = (name, relative) => readFile(path.join(paths[name], relative), "utf8");
    assert.equal(await read("toy", "language/tokenizer.json"), fixtures.toyTokenizer);
    assert.equal(await read("toy", "language/configuration.json"), fixtures.toyConfiguration);
    assert.deepEqual(JSON.parse(await read("toy", "kobrixa-plugin.json")), fixtures.toyManifest);
    const declaration = async (name) =>
      JSON.parse(await read(name, "kobrixa-plugin.json")).contributes.languages[0];
    assert.equal((await declaration("shared")).id, "toy-other");
    assert.deepEqual((await declaration("shared")).extensions, ["toy", "other"]);
    assert.equal((await declaration("duplicate")).id, "toy");
    assert.equal((await declaration("invalid")).id, "toy-invalid");
    const bad = JSON.parse(await read("invalid", "language/tokenizer.json"));
    assert.equal(Object.hasOwn(bad.states[0].rules[0].regex, "flags"), false);
    const hostile = JSON.parse(await read("hostile", "language/tokenizer.json"));
    assert.equal(hostile.states[0].rules[0].regex.pattern, "(a+)+$");
    // Do not compile or execute the hostile regex in this process.
    for (const name of ["toy", "shared", "duplicate", "invalid", "hostile"]) {
      const manifest = JSON.parse(await read(name, "kobrixa-plugin.json"));
      assert.deepEqual(manifest.runtime, { kind: "static" });
      assert.equal(Object.hasOwn(manifest, "sourceKey"), false);
      assert.match(developmentSourceKey(await realpath(paths[name])), /^dev:/);
    }
    assert.notEqual(
      developmentSourceKey(await realpath(paths.toy)),
      developmentSourceKey(await realpath(paths.duplicate)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test builtin has an owned frontend/service and a complete same-owner binding", async () => {
  const { builtin, binding } = await readStaticLanguageFixtures();
  assert.equal(builtin.kind, "builtin");
  assert.equal(builtin.manifest.id, binding.pluginId);
  assert.equal(binding.sourceKey, `builtin:${binding.pluginId}`);
  assert.deepEqual(builtin.manifest.contributes.frontends, [binding.frontend]);
  assert.deepEqual(builtin.manifest.contributes.languageServices, [
    {
      language: binding.language,
      extensions: binding.extensions,
      capabilities: binding.capabilities,
    },
  ]);
  assert.deepEqual(builtin.manifest.contributes.languages[0].extensions, binding.extensions);
  assert.deepEqual(Object.keys(builtin.resources).sort(), [
    "language/configuration.json",
    "language/tokenizer.json",
  ]);
});

test("smoke snapshot includes full owner identity, original byte sizes, and defensive clones", async () => {
  const catalog = await basicPlusSmokeCatalog();
  const harness = createStaticLanguagesHarness(catalog);
  const state = harness.state();
  assert.equal(state.staticLanguagesRevision, catalog.revision);
  assert.deepEqual(state.staticLanguageOwners, [
    {
      sourceKey: "builtin:kobrixa.basic-plus",
      pluginId: "kobrixa.basic-plus",
      generation: 1,
      languageId: "bp",
      extensions: ["bp", "bpi", "bpm"],
    },
  ]);
  const { basicPlusTokenizer, basicPlusConfiguration } = await readStaticLanguageFixtures();
  assert.deepEqual(catalog.languages[0].resourceBytes, {
    tokenizer: Buffer.byteLength(basicPlusTokenizer),
    configuration: Buffer.byteLength(basicPlusConfiguration),
  });
  assert.equal(catalog.languages[0].expandedRules, 9);
  state.staticLanguageOwners[0].extensions.length = 0;
  harness.staticLanguages().languages.length = 0;
  assert.equal(harness.staticLanguages().languages.length, 1);
  assert.equal(harness.state().staticLanguageOwners[0].extensions.length, 3);
});

test("legacy smoke tokenization calls use bp while theme token classes retain basic-plus", async () => {
  for (const name of ["highlighting-smoke.mjs", "indentation-smoke.mjs"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /,\s*'basic-plus'\)/);
    assert.match(source, /,\s*'bp'\)/);
    assert.match(source, /keyword\.control\.basic-plus/);
  }
});

test("packaged runner invokes static acceptance from a copied app with a temporary cwd", async () => {
  const source = await readFile(new URL("./packaged-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /await checkPackagedStaticLanguages\(/);
  assert.match(source, /await cp\(appDirectory, installedDirectory/);
  assert.match(source, /cwd: profile/);
  assert.match(source, /--plugin-dev-dir=/);
});
