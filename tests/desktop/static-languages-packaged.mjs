import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function checkPackagedStaticLanguages({ js, send, until, profile, sourceKey }) {
  const catalog = await js("window.kobrixa.plugins.staticLanguages()");
  const builtin = catalog.languages.find((language) => language.id === "bp");
  assert.ok(builtin, "packaged raw Basic Plus resources must reach the catalog");
  assert.equal(builtin.pluginId, "kobrixa.basic-plus");
  assert.equal(builtin.tokenizer.tokenPostfix, ".basic-plus");
  assert.equal(builtin.tokenizer.states[0].rules.length, 9);
  assert.equal(Object.hasOwn(builtin.configuration, "wordPattern"), false);
  assert.equal(Object.hasOwn(builtin.configuration, "onEnterRules"), false);
  assert.ok(builtin.resourceBytes.tokenizer > 0 && builtin.resourceBytes.configuration > 0);
  assert.equal(
    await js(
      "Boolean(document.querySelector('.editor-stage .monaco-editor[data-mode-id=\"bp\"]'))",
    ),
    true,
  );
  const required = await js(
    `window.kobrixa.plugins.setEnabled(${JSON.stringify(builtin.sourceKey)},false)`,
  );
  assert.equal(required.ok, false);
  assert.equal(required.code, "PLUGIN_E_BUILTIN_REQUIRED");
  const state = await js("window.kobrixa.plugins.state()");
  const toy = state.plugins.find((plugin) => plugin.sourceKey === sourceKey);
  assert.equal(toy?.runtime, "static");
  assert.equal(toy?.running, false);
  const markerFile = path.join(profile, "plugins/session.json");
  const marker = () => readFile(markerFile, "utf8").then(JSON.parse);
  assert.equal((await marker()).thirdPartyStaticContributions, true);
  assert.equal((await marker()).thirdPartyRunning, false);
  const mode = (id) =>
    js(`Boolean(document.querySelector('.editor-stage .monaco-editor[data-mode-id="${id}"]'))`);
  const select = async (file, language) => {
    await js(`document.querySelector('[data-tree-path="${file}"]').click()`);
    await until(() => mode(language));
  };
  await select("sample.toy", "toy");
  assert.match(await js('document.querySelector(".status-details").textContent'), /Toy/);
  await send("Page.bringToFront");
  await js('document.querySelector(".editor-stage .monaco-editor textarea").focus()');
  await send("Input.insertText", { text: "draft_value 42 " });
  await until(() =>
    js('document.querySelector(".editor-stage .view-lines").textContent.includes("draft_value")'),
  );
  const edited = await js('document.querySelector(".editor-stage .view-lines").textContent');
  assert.equal(
    (await js(`window.kobrixa.plugins.setEnabled(${JSON.stringify(sourceKey)},false)`)).ok,
    true,
  );
  await until(() => mode("plaintext"));
  assert.equal(await js('document.querySelector(".editor-stage .view-lines").textContent'), edited);
  assert.match(
    await js('document.querySelector(".status-details").textContent'),
    /Plain Text|純文字/,
  );
  assert.equal((await marker()).thirdPartyStaticContributions, true);
  // Hide the dirty toy document while its contribution is unavailable, then restore it.
  await select("main.bp", "bp");
  assert.equal(
    (await js(`window.kobrixa.plugins.setEnabled(${JSON.stringify(sourceKey)},true)`)).ok,
    true,
  );
  await select("sample.toy", "toy");
  assert.equal(await js('document.querySelector(".editor-stage .view-lines").textContent'), edited);
  await select("unknown.xyz", "plaintext");
  await select("data.json", "json");
  await select("main.bp", "bp");
  const resources = await js("performance.getEntriesByType('resource').map(entry=>entry.name)");
  assert.equal(
    resources.some((url) => /\/language\/(tokenizer|configuration)\.json(?:[?#]|$)/.test(url)),
    false,
  );
}
