import assert from "node:assert/strict";
import { app } from "electron";
import {
  PLUGIN_SHUTDOWN_DEADLINE_MS,
  PluginManager,
  type PluginNotice,
} from "@kobrixa/plugin-runtime";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";
import { filePluginStateStore } from "../../apps/desktop/src/main/plugins/state-store.js";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";
import { recordSmokeQuit } from "./plugins-smoke-process.mjs";

const [directory, python] = process.argv.slice(-2) as [string, string];
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error("Plugin smoke timed out")), 60_000).unref();

void app.whenReady().then(async () => {
  const manager = await PluginManager.create({
    sources: [
      "hello-ts",
      "插件 測試/hello-python",
      "crash",
      "pid-ts",
      "pid-python",
      "stubborn-ts",
    ].map((name) => ({
      kind: "development" as const,
      directory: `${directory}/${name}`,
    })),
    store: filePluginStateStore(`${directory}/user-data`),
    safeMode: false,
    launcher: createDesktopLauncher({ python: () => ({ executable: python, args: [] }) }),
    locale: "zh-TW",
  });
  // The same quit path as apps/desktop/src/main/index.ts.
  installPluginQuitCleanup(app, manager);
  recordSmokeQuit(app, directory, PLUGIN_SHUTDOWN_DEADLINE_MS);
  const notices: PluginNotice[] = [];
  manager.onEvent((event) => {
    if (event.type === "notice") notices.push(event.notice);
  });
  assert.deepEqual(
    manager.state().plugins.map((plugin) => plugin.status),
    ["enabled", "enabled", "enabled", "enabled", "enabled", "enabled"],
  );
  assert.deepEqual(await manager.executeCommand("kobrixa-samples.hello-ts.greet"), { ok: true });
  assert.deepEqual(await manager.executeCommand("kobrixa-samples.hello-python.greet"), {
    ok: true,
  });
  const crashed = await manager.executeCommand("kobrixa-smoke.crash.exit");
  assert.equal(crashed.ok, false);
  assert.equal(crashed.ok ? undefined : crashed.code, "PLUGIN_E_CRASHED");
  assert.deepEqual(
    await manager.executeCommand("kobrixa-samples.hello-ts.greet"),
    { ok: true },
    "Other plugins keep working after a crash",
  );
  assert.deepEqual(
    notices.map((notice) => [notice.pluginId, notice.message]),
    [
      ["kobrixa-samples.hello-ts", "來自 TypeScript 插件的問候"],
      ["kobrixa-samples.hello-python", "來自 Python 插件的問候"],
      ["kobrixa-samples.hello-ts", "來自 TypeScript 插件的問候"],
    ],
  );
  assert.deepEqual(await manager.executeCommand("kobrixa-smoke.pid-ts.record"), { ok: true });
  assert.deepEqual(await manager.executeCommand("kobrixa-smoke.pid-python.record"), { ok: true });
  assert.deepEqual(await manager.executeCommand("kobrixa-smoke.stubborn-ts.record"), { ok: true });
  // Quit through Electron's real lifecycle instead of awaiting shutdown(); the runner then checks
  // that the TS plugin's deactivate ran and that no plugin process outlived the app.
  app.quit();
});
