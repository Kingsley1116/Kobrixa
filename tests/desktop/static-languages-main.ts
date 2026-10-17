import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, type IpcMainInvokeEvent } from "electron";
import type { PluginSource } from "@kobrixa/plugin-runtime";
import type { PluginsApi } from "../../apps/desktop/src/shared/plugins.js";
import type { LanguageBinding } from "../../apps/desktop/src/shared/language-services.js";
import type { IpcHandle } from "../../apps/desktop/src/main/ipc.js";
import { startPlugins } from "../../apps/desktop/src/main/plugins/controller.js";
import { registerPluginIpc } from "../../apps/desktop/src/main/plugins/ipc.js";
import { SessionMarkerFile } from "../../apps/desktop/src/main/plugins/session.js";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";
import { resolveLexicalLanguage } from "../../apps/desktop/src/renderer/editor/static-language-routing.js";
import { checkStaticLanguageLifecycle } from "./static-languages-acceptance.mjs";

const [directory, phase] = process.argv.slice(-2) as [string, string];
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error(`static acceptance timed out: ${phase}`)), 60_000).unref();

void app.whenReady().then(async () => {
  const input = JSON.parse(await readFile(path.join(directory, "input.json"), "utf8")) as {
    paths: Record<string, string>;
    builtin: PluginSource;
    binding: LanguageBinding;
  };
  const names =
    phase === "conflicts" ? ["toy", "shared", "duplicate", "invalid", "hostile"] : ["toy"];
  let launches = 0;
  const plugins = await startPlugins({
    userData: app.getPath("userData"),
    builtins: [input.builtin],
    commandLine: {
      developmentDirectories: names.map((name) => input.paths[name]!),
      safeMode: phase === "cli-safe",
    },
    dialogs: {
      confirmDeveloperMode: async () => true,
      chooseFolder: async () => undefined,
      confirmLink: async () => true,
      confirmUnlink: async () => true,
      choosePython: async () => undefined,
    },
    locale: "en",
    launcher: () => async () => {
      launches++;
      throw new Error("static contribution attempted process launch");
    },
  });
  installPluginQuitCleanup(app, plugins);
  app.on("quit", () => plugins.finishSession());
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const handle: IpcHandle = (channel, action) => {
    handlers.set(channel, action as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  };
  const off = registerPluginIpc(handle, plugins, () => {});
  app.on("will-quit", off);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const action = handlers.get(channel);
    assert.ok(action, `missing channel ${channel}`);
    return action({} as IpcMainInvokeEvent, ...args);
  };
  const api = {
    state: async () => plugins.state(),
    staticLanguages: async () => invoke("plugins:static-languages"),
    reportLanguageRegistrationFailure: async (value: unknown) =>
      invoke("plugins:report-language-registration-failure", value),
    setEnabled: async (key: string, enabled: boolean) =>
      invoke("plugins:set-enabled", key, enabled),
    reload: async (key: string) => invoke("plugins:reload", key),
  } as Pick<
    PluginsApi,
    "state" | "staticLanguages" | "reportLanguageRegistrationFailure" | "setEnabled" | "reload"
  >;
  const markerFile = path.join(app.getPath("userData"), "plugins/session.json");
  const marker = async () =>
    JSON.parse(await readFile(markerFile, "utf8")) as {
      thirdPartyStaticContributions: boolean;
      thirdPartyRunning: boolean;
    };
  const toy = () => plugins.state().plugins.find((row) => row.id === "acme.toy");
  const builtinId = input.binding.language;

  if (phase === "lifecycle") {
    await checkStaticLanguageLifecycle(api, "acme.toy", "toy");
    assert.equal((await marker()).thirdPartyStaticContributions, true);
    await api.setEnabled(toy()!.sourceKey, false);
    assert.equal(
      (await marker()).thirdPartyStaticContributions,
      true,
      "risk marker stays sticky after disable",
    );
    await api.setEnabled(toy()!.sourceKey, true);
  } else if (phase === "conflicts") {
    let catalog = await api.staticLanguages();
    const duplicate = catalog.conflicts.find(
      (conflict) => conflict.kind === "id" && conflict.key === "toy",
    );
    assert.deepEqual(duplicate?.sources.map((source) => source.pluginId).sort(), [
      "acme.duplicate",
      "acme.toy",
    ]);
    assert.equal(
      catalog.languages.some((language) => language.id === "toy"),
      false,
    );
    const duplicateRow = plugins.state().plugins.find((row) => row.id === "acme.duplicate")!;
    assert.equal((await api.setEnabled(duplicateRow.sourceKey, false)).ok, true);
    catalog = await api.staticLanguages();
    assert.equal(catalog.extensionRoutes.toy, null);
    assert.equal(catalog.extensionRoutes.other, "toy-other");
    const route = (binding?: LanguageBinding) =>
      resolveLexicalLanguage({
        file: "main.toy",
        catalog,
        activeOwners: plugins.state().staticLanguageOwners,
        coreExtensionRoutes: { json: "json" },
        ...(binding ? { binding } : {}),
      });
    assert.equal(route().monacoLanguage, "plaintext");
    assert.equal(route(input.binding).monacoLanguage, builtinId);
    assert.equal(
      plugins.state().plugins.find((row) => row.id === "acme.invalid")?.status,
      "enabled",
    );
    assert.ok(
      plugins
        .state()
        .plugins.find((row) => row.id === "acme.invalid")
        ?.problems.some(
          (problem) =>
            problem.code === "PLUGIN_E_STATIC_LANGUAGE" &&
            problem.detail?.languageId === "toy-invalid",
        ),
    );
    // A resource-only load of the hostile fixture must finish without running document regexes.
    assert.equal(
      plugins.state().plugins.find((row) => row.id === "acme.hostile")?.status,
      "enabled",
    );
    const required = await api.setEnabled(input.binding.sourceKey, false);
    assert.equal(required.ok, false);
    if (!required.ok) assert.equal(required.code, "PLUGIN_E_BUILTIN_REQUIRED");
  } else if (phase === "unclean" || phase === "hang") {
    await api.staticLanguages();
    assert.equal((await marker()).thirdPartyStaticContributions, true);
    assert.equal((await marker()).thirdPartyRunning, false);
    if (phase === "hang") plugins.markRendererUnresponsive();
    // Persist a per-source disable before dying: restoring the lock must not undo it.
    await api.setEnabled(toy()!.sourceKey, false);
    await writeFile(path.join(directory, `${phase}-ready.json`), JSON.stringify({ launches }));
    process.kill(process.pid, "SIGKILL");
    return;
  } else if (phase === "recover" || phase === "recover-hang" || phase === "cli-safe") {
    assert.equal(plugins.state().safeMode, true);
    if (phase !== "cli-safe")
      assert.equal(
        plugins.state().safeModeLock?.reason,
        phase === "recover-hang" ? "renderer-unresponsive" : "unclean-exit",
      );
    assert.equal(
      (await api.staticLanguages()).languages.every((language) =>
        language.sourceKey.startsWith("builtin:"),
      ),
      true,
    );
    assert.ok(
      (await api.staticLanguages()).languages.some((language) => language.id === builtinId),
    );
    if (phase !== "cli-safe") {
      assert.equal((await plugins.clearSafeModeLock()).ok, true);
      assert.equal(
        (await api.staticLanguages()).languages.some((language) => language.id === "toy"),
        false,
      );
      assert.equal((await api.setEnabled(toy()!.sourceKey, true)).ok, true);
      assert.ok((await api.staticLanguages()).languages.some((language) => language.id === "toy"));
    }
  } else if (phase === "marker-failure") {
    // The runner persists toy as disabled before startup, so no third-party catalog was delivered.
    assert.equal((await marker()).thirdPartyStaticContributions, false);
    const original = SessionMarkerFile.prototype.markThirdPartyStaticContributions;
    SessionMarkerFile.prototype.markThirdPartyStaticContributions = () => {
      throw new Error("fixture marker write failure");
    };
    try {
      await api.setEnabled(toy()!.sourceKey, true);
      const catalog = await api.staticLanguages();
      assert.equal(
        catalog.languages.some((language) => language.id === "toy"),
        false,
      );
      assert.ok(catalog.languages.some((language) => language.id === builtinId));
      const afterFailure = plugins.state();
      assert.ok(
        afterFailure.stateProblem?.code === "PLUGIN_E_STATE_SAVE" ||
          afterFailure.plugins.some((row) =>
            row.problems.some((problem) => problem.code === "PLUGIN_E_STATE_SAVE"),
          ),
      );
      console.log(
        "PASS refuses post-startup static catalog delivery when marker persistence fails",
      );
      assert.equal((await marker()).thirdPartyStaticContributions, false);
    } finally {
      SessionMarkerFile.prototype.markThirdPartyStaticContributions = original;
    }
  } else throw new Error(`unknown phase ${phase}`);
  assert.equal(launches, 0, "static-only launcher/handshake count");
  console.log(`PASS static acceptance: ${phase}`);
  app.quit();
});
