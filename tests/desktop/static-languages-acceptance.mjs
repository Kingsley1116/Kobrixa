import assert from "node:assert/strict";

export async function checkStaticLanguageLifecycle(api, pluginId, languageId) {
  const row = (await api.state()).plugins.find((plugin) => plugin.id === pluginId);
  assert.ok(row, `missing ${pluginId}`);
  assert.equal(row.runtime, "static");
  assert.equal(row.running, false, "static plugin must never be running");
  const sourceKey = row.sourceKey;
  const own = (catalog) =>
    catalog.languages.find(
      (language) => language.sourceKey === sourceKey && language.id === languageId,
    );
  const first = await api.staticLanguages();
  assert.equal(first.formatVersion, 1);
  assert.equal(first.limitsVersion, 1);
  assert.ok(own(first));
  assert.equal((await api.state()).staticLanguagesRevision, first.revision);
  assert.equal((await api.setEnabled(sourceKey, false)).ok, true);
  const disabled = await api.staticLanguages();
  assert.equal(own(disabled), undefined, "disabled language must leave the catalog");
  assert.ok(disabled.revision > first.revision);
  assert.equal((await api.setEnabled(sourceKey, true)).ok, true);
  const enabled = await api.staticLanguages();
  assert.ok(own(enabled));
  assert.ok(enabled.revision > disabled.revision);
  assert.equal((await api.reload(sourceKey)).ok, true);
  const reloaded = await api.staticLanguages();
  assert.ok(own(reloaded).generation > own(enabled).generation);
  const report = {
    sourceKey,
    generation: own(reloaded).generation,
    languageId,
    revision: reloaded.revision,
    reason: "monaco",
    detail: "Acceptance fixture: simulated registration failure",
  };
  assert.equal((await api.reportLanguageRegistrationFailure(report)).accepted, true);
  const isolated = await api.staticLanguages();
  assert.equal(own(isolated), undefined);
  assert.equal((await api.reportLanguageRegistrationFailure(report)).accepted, false);
  assert.equal((await api.staticLanguages()).revision, isolated.revision);
  assert.equal((await api.reload(sourceKey)).ok, true);
  assert.ok(own(await api.staticLanguages()));
  assert.equal(
    (await api.state()).plugins.find((plugin) => plugin.sourceKey === sourceKey).running,
    false,
  );
}
