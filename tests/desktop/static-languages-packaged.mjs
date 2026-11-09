import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function checkPackagedStaticLanguages({ js, until, profile, sourceKey }) {
  const mode = (id) =>
    js(`Boolean(document.querySelector('.editor-stage [data-mode-id="${id}"]'))`);
  const languages = async () => (await js("window.kobrixa.plugins.staticLanguages()")).languages;
  const catalog = await js("window.kobrixa.plugins.staticLanguages()");
  const builtin = catalog.languages.find((language) => language.id === "bp");
  assert.ok(builtin, "packaged raw Basic Plus resources must reach the catalog");
  assert.equal(builtin.pluginId, "kobrixa.basic-plus");
  assert.equal(builtin.tokenizer.tokenPostfix, ".basic-plus");
  assert.equal(builtin.tokenizer.states[0].rules.length, 9);
  assert.equal(Object.hasOwn(builtin.configuration, "wordPattern"), false);
  assert.equal(Object.hasOwn(builtin.configuration, "onEnterRules"), false);
  assert.ok(builtin.resourceBytes.tokenizer > 0 && builtin.resourceBytes.configuration > 0);
  await until(() => mode("bp"));
  const required = await js(
    `window.kobrixa.plugins.setEnabled(${JSON.stringify(builtin.sourceKey)},false)`,
  );
  assert.equal(required.ok, false);
  assert.equal(required.code, "PLUGIN_E_BUILTIN_REQUIRED");
  const state = await js("window.kobrixa.plugins.state()");
  const toy = state.plugins.find((plugin) => plugin.sourceKey === sourceKey);
  assert.equal(toy?.runtime, "static");
  assert.equal(toy?.running, false);
  const contributed = catalog.languages.find((language) => language.id === "toy");
  assert.equal(contributed?.pluginId, toy?.id);
  assert.ok(contributed.resourceBytes.tokenizer > 0);
  const markerFile = path.join(profile, "plugins/session.json");
  const marker = () => readFile(markerFile, "utf8").then(JSON.parse);
  assert.equal((await marker()).thirdPartyStaticContributions, true);
  assert.equal((await marker()).thirdPartyRunning, false);
  const select = async (file, language) => {
    await js(`document.querySelector('[data-tree-path="${file}"]').click()`);
    await until(() => mode(language));
  };
  // The shipped workspace lists and opens only .bp, .bpi, .bpm and .json files, so a
  // third-party static language's own files never reach the project tree or an editor.
  // Packaged acceptance therefore covers the contribution through the catalog, the
  // enable/disable lifecycle and Monaco registration; see docs/en/roadmap.md.
  assert.equal(await js(`Boolean(document.querySelector('[data-tree-path="sample.toy"]'))`), false);
  assert.equal(
    await js(`Boolean(document.querySelector('[data-tree-path="unknown.xyz"]'))`),
    false,
  );
  assert.equal(
    (await js(`window.kobrixa.plugins.setEnabled(${JSON.stringify(sourceKey)},false)`)).ok,
    true,
  );
  await until(async () => !(await languages()).some((language) => language.id === "toy"));
  assert.equal((await marker()).thirdPartyStaticContributions, true);
  await select("data.json", "json");
  await select("main.bp", "bp");
  assert.equal(
    (await js(`window.kobrixa.plugins.setEnabled(${JSON.stringify(sourceKey)},true)`)).ok,
    true,
  );
  await until(async () => (await languages()).some((language) => language.id === "toy"));
  assert.equal(
    (await js("window.kobrixa.plugins.state()")).plugins.find(
      (plugin) => plugin.sourceKey === sourceKey,
    )?.running,
    false,
  );
  await select("data.json", "json");
  await select("main.bp", "bp");
  const resources = await js("performance.getEntriesByType('resource').map(entry=>entry.name)");
  assert.equal(
    resources.some((url) => /\/language\/(tokenizer|configuration)\.json(?:[?#]|$)/.test(url)),
    false,
  );
}
