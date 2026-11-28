import assert from "node:assert/strict";
import path from "node:path";

import type { runUiLoad } from "./declarative-ui-load-main.js";
import { loadEvaluation, loadResult, waitForLoad } from "./declarative-ui-load-fixture.js";
import { rssSettingsValues } from "./b2-process-rss-settings.js";
import type { PressureRow } from "./plugin-persistence-pressure.js";
import { startRss } from "./b2-process-rss-observer.js";

// The renderer checks document.hasFocus() inside each open. A ten-minute
// workload and the second window can leave the load window visible but inactive.
export async function withLoadForeground<T>(
  window: Electron.BrowserWindow,
  activate: () => void,
  operation: () => Promise<T>,
) {
  const focus = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    activate();
    window.focus();
    window.webContents.focus();
  };
  let pending: NodeJS.Immediate | undefined;
  const regain = () => {
    pending ??= setImmediate(() => {
      pending = undefined;
      focus();
    });
  };
  window.on("blur", regain);
  window.on("hide", regain);
  window.on("minimize", regain);
  try {
    focus();
    return await operation();
  } finally {
    window.off("blur", regain);
    window.off("hide", regain);
    window.off("minimize", regain);
    if (pending) clearImmediate(pending);
  }
}

export async function runRssPressure(
  input: Parameters<typeof runUiLoad>[0],
  config: PressureRow,
  snapshots: () => unknown[],
  settings: () => Promise<PressureRow>,
  settingsWindow: Electron.BrowserWindow,
  finalStage: (pluginId: string) => string,
) {
  const { window, composition, workload } = input;
  assert.ok(workload);
  const js = async (code: string, target = window) =>
    loadResult<PressureRow>(await target.webContents.executeJavaScript(loadEvaluation(code)));
  const settingsJs = (code: string) => js(code, settingsWindow);
  const shell = async () => {
    await window.loadFile(path.join(input.directory, "renderer/index.html"));
    const { app } = await import("electron");
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
    await js("window.uiLoad.ready");
    assert.equal(await js("window.uiLoad.count()"), 0);
  };
  await shell();
  assert.ok((await composition.plugins.setDeveloperMode(true)).ok);
  const main = () => snapshots().map((counters, id) => ({ id, counters }));
  const baselineCounters = main();
  const sampler = await startRss(config.rss);
  for (const folder of input.folders)
    assert.ok((await composition.plugins.linkFolder()).ok, folder);
  await waitForLoad(
    () => js("window.uiLoad.count()"),
    (n) => Number(n) === 32,
    "32 catalog entries",
  );
  await js("window.uiLoad.openAll()");
  const fullCounters = { main: main(), renderer: await js("window.uiLoad.sample()") };
  const saved = await settings();
  const url = new URL(config.rendererUrl);
  url.searchParams.set("view", "rss-settings");
  await settingsWindow.loadURL(url.href);
  settingsWindow.showInactive();
  const observed = await waitForLoad(
    () => settingsJs("window.persistenceAcceptance?.settingsSnapshot()?.[0] ?? null"),
    Boolean,
    "settings form ready",
  );
  assert.deepEqual(observed.state.baseline.values, rssSettingsValues());
  const fields = await settingsJs(
    'Array.from(document.querySelectorAll("[data-persistence-settings] input"), e=>e.value)',
  );
  assert.deepEqual(
    fields,
    rssSettingsValues()
      .slice(0, 16)
      .map((v) => v.value),
  );
  const settingsProof = {
    values: observed.state.baseline.values,
    fields,
    revision: observed.state.baseline.revision,
    saved: saved.result,
  };
  assert.equal(settingsProof.revision, saved.result.revision);
  await workload.prepare();
  await workload.start();
  const start = performance.now();
  let steps = 0;
  while (performance.now() - start < input.durationMs) {
    await workload.step(steps++, { main: main(), renderer: await js("window.uiLoad.sample()") });
  }
  const durationMs = performance.now() - start;
  await sampler.cleanup();
  await workload.finish();
  const { app } = await import("electron");
  const cycleCounters = await withLoadForeground(
    window,
    () => app.focus({ steal: true }),
    () => js(`window.uiLoad.cycles(${input.cycles})`),
  );
  await js("window.uiLoad.dispose()");
  for (const source of composition.plugins
    .state()
    .plugins.filter((s) => s.source === "development"))
    assert.ok((await composition.plugins.unlink(source.sourceKey)).ok);
  await settingsJs("window.declarativeAcceptance.disposeFoundationRenderer()");
  await settingsWindow.loadURL("about:blank");
  settingsWindow.hide();
  const detail = composition.plugins.persistence170!.detail;
  assert.equal(detail.entries().length, 0, "Unexpected recovery before pressure owner retirement");
  const retirements = [];
  for (const id of ["pressure-a", "pressure-b"]) {
    const key = "builtin:acceptance.ui-" + id;
    assert.ok((await composition.plugins.setEnabled(key, false)).ok);
    const pluginId = "acceptance.ui-" + id;
    const write = finalStage(pluginId);
    const recoveryIds = detail.entries().map((entry) => entry.item.id);
    assert.deepEqual(recoveryIds, [], "Retired pressure owner left a recovery row");
    retirements.push({ pluginId, write, recoveryIds });
    assert.ok((await composition.plugins.setEnabled(key, true)).ok);
  }
  await shell();
  const final = main();
  assert.deepEqual(final, baselineCounters);
  await sampler.idle();
  return {
    durationMs,
    cycles: input.cycles,
    cycleCounters,
    settingsProof,
    fullCounters,
    baselineCounters,
    idleCounters: final,
    retirements,
  };
}
