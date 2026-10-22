import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { startPlugins } from "../../apps/desktop/src/main/plugins/controller.js";
import type { PluginDialogs } from "../../apps/desktop/src/main/plugins/dialogs.js";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";

// Three phases share one --user-data-dir: link and quit, use the link and crash while the
// renderer is marked unresponsive, then come back in the locked safe mode and restore.
const [directory, phase] = process.argv.slice(-2) as [string, "first" | "second" | "third"];
const hello = path.join(directory, "hello-ts");
const greet = "kobrixa-samples.hello-ts.greet";
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error(`Plugin GUI smoke (${phase}) timed out`)), 60_000).unref();

// Scripted answers stand in for the native dialogs the user would click through.
const answers = { confirm: true, folder: hello };
const dialogs: PluginDialogs = {
  confirmDeveloperMode: () => Promise.resolve(answers.confirm),
  chooseFolder: () => Promise.resolve(answers.folder),
  confirmLink: () => Promise.resolve(answers.confirm),
  confirmUnlink: () => Promise.resolve(answers.confirm),
  choosePython: () => Promise.resolve(undefined),
};

void app.whenReady().then(async () => {
  const plugins = await startPlugins({
    userData: app.getPath("userData"),
    builtins: [],
    commandLine: { developmentDirectories: [], safeMode: false },
    dialogs,
    locale: "en",
  });
  // This fixture has plugin processes but no device/persistence participants.
  installPluginQuitCleanup(app, () => plugins.shutdown(), fail);
  app.on("quit", () => plugins.finishSession());

  if (phase === "first") {
    assert.equal(plugins.state().developer.enabled, false, "Developer mode starts off");
    answers.confirm = false;
    const declined = await plugins.setDeveloperMode(true);
    assert.equal(declined.ok && declined.outcome, "cancelled");
    assert.equal(plugins.state().developer.enabled, false, "Declining the dialog changes nothing");
    answers.confirm = true;
    assert.equal((await plugins.setDeveloperMode(true)).ok, true);
    assert.equal(plugins.state().developer.enabled, true);
    const linked = await plugins.linkFolder();
    assert.equal(linked.ok, true);
    assert.equal(typeof (linked.ok ? linked.sourceKey : undefined), "string");
    assert.deepEqual(await plugins.execute(greet), { ok: true });
    app.quit();
    return;
  }

  if (phase === "second") {
    const [row] = plugins.state().plugins;
    assert.ok(row?.sourceKey, "The link survived the restart");
    assert.equal(plugins.state().origins[row.sourceKey], "linked");
    assert.deepEqual(await plugins.execute(greet), { ok: true });
    assert.equal((await plugins.reload(row.sourceKey)).ok, true);
    assert.deepEqual(await plugins.execute(greet), { ok: true }, "The command works after reload");
    assert.equal((await plugins.unlink(row.sourceKey)).ok, true);
    assert.deepEqual(plugins.state().plugins, []);
    // Unlinking never deletes the user's files.
    await access(path.join(hello, "kobrixa-plugin.json"));
    assert.equal((await plugins.linkFolder()).ok, true);
    assert.deepEqual(await plugins.execute(greet), { ok: true });
    // A hung renderer is sticky: even though this process dies, the next start must lock.
    plugins.markRendererUnresponsive();
    await writeFile(path.join(directory, "gui-crash-ready.txt"), "ready");
    process.kill(process.pid, "SIGKILL");
    return;
  }

  const locked = plugins.state();
  assert.equal(locked.safeMode, true);
  assert.equal(locked.safeModeLock?.reason, "renderer-unresponsive");
  assert.equal(locked.plugins[0]?.disabledBy, "safe-mode");
  assert.equal((await plugins.clearSafeModeLock()).ok, true);
  const restored = plugins.state();
  assert.equal(restored.safeMode, false);
  assert.equal(restored.safeModeLock, undefined);
  assert.equal(restored.plugins[0]?.status, "enabled");
  assert.deepEqual(await plugins.execute(greet), { ok: true });
  app.quit();
});
