import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import type { PluginSource } from "@kobrixa/plugin-runtime";
import type { PluginsApi } from "../../apps/desktop/src/shared/plugins.js";
import type { LanguageBinding } from "../../apps/desktop/src/shared/language-services.js";
import { registerIpc } from "../../apps/desktop/src/main/ipc.js";
import { BUILTIN_PLUGIN_SOURCES } from "../../apps/desktop/src/main/plugins/builtin.js";
import { startPlugins } from "../../apps/desktop/src/main/plugins/controller.js";
import { registerPluginIpc } from "../../apps/desktop/src/main/plugins/ipc.js";
import {
  SessionMarkerFile,
  watchRendererHealth,
} from "../../apps/desktop/src/main/plugins/session.js";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";
import { resolveLexicalLanguage } from "../../apps/desktop/src/renderer/editor/static-language-routing.js";
import { checkStaticLanguageLifecycle } from "./static-languages-acceptance.mjs";
import { STRESS_EVENT_PREFIX } from "./static-languages-stress.mjs";

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
  const stress = phase === "hostile-tokenization" || phase === "recover-hostile";
  const names =
    phase === "conflicts"
      ? ["toy", "shared", "duplicate", "invalid", "hostile"]
      : stress
        ? ["toy", "hostile"]
        : ["toy"];
  let launches = 0;
  const plugins = await startPlugins({
    userData: app.getPath("userData"),
    builtins: phase === "browser" || stress ? BUILTIN_PLUGIN_SOURCES : [input.builtin],
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
  installPluginQuitCleanup(app, () => plugins.shutdown(), fail);
  app.on("quit", () => plugins.finishSession());
  const rendererUrl = process.argv.at(-3)!;
  const windowOptions = {
    show: false,
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  const win = new BrowserWindow(windowOptions);
  if (phase === "hostile-tokenization") {
    // Exactly the product's health wiring; never synthesize an unresponsive event.
    watchRendererHealth(win, () => plugins.markRendererUnresponsive());
    win.on("unresponsive", () => {
      console.log(STRESS_EVENT_PREFIX + JSON.stringify({ type: "unresponsive" }));
    });
    win.webContents.on("console-message", (event) => {
      if (event.message.startsWith(STRESS_EVENT_PREFIX)) console.log(event.message);
    });
  }
  type RegisterArgs = Parameters<typeof registerIpc>;
  // Unused product-service fixtures let us install the actual trust wrapper.
  // No plugin, IPC, validator, catalog or renderer-language implementation is mocked.
  registerIpc(
    () => win.webContents,
    {} as RegisterArgs[1],
    {} as RegisterArgs[2],
    {} as RegisterArgs[3],
    {} as RegisterArgs[4],
    {} as RegisterArgs[5],
    {} as RegisterArgs[6],
    undefined,
    undefined,
    undefined,
    [
      (handle) => {
        const unsubscribe = registerPluginIpc(handle, plugins, (event) => {
          if (!win.isDestroyed()) win.webContents.send("plugins:event", event);
        });
        app.on("will-quit", unsubscribe);
      },
    ],
  );
  const browserUrl = new URL(rendererUrl);
  browserUrl.searchParams.set("phase", phase);
  if (phase === "recover-hostile")
    browserUrl.searchParams.set("hostileDirectory", input.paths.hostile!);
  await win.loadURL(phase === "browser" || stress ? browserUrl.href : "about:blank");
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    win.webContents.executeJavaScript(
      `window.kobrixa.plugins[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
    ) as Promise<T>;
  const api: Pick<
    PluginsApi,
    "state" | "staticLanguages" | "reportLanguageRegistrationFailure" | "setEnabled" | "reload"
  > = {
    state: () => call("state"),
    staticLanguages: () => call("staticLanguages"),
    reportLanguageRegistrationFailure: (report) =>
      call("reportLanguageRegistrationFailure", report),
    setEnabled: (key, enabled) => call("setEnabled", key, enabled),
    reload: (key) => call("reload", key),
  };
  if (phase === "lifecycle") {
    const stranger = new BrowserWindow(windowOptions);
    try {
      await stranger.loadURL("about:blank");
      for (const method of ["staticLanguages", "reportLanguageRegistrationFailure"]) {
        await assert.rejects(
          stranger.webContents.executeJavaScript(`window.kobrixa.plugins.${method}({})`),
          /untrusted sender/,
        );
      }
    } finally {
      stranger.destroy();
    }
    for (const detail of [
      "/private/plugin/tokenizer.json",
      "C:\\plugin\\tokenizer.json",
      "x".repeat(2049),
    ]) {
      await assert.rejects(
        api.reportLanguageRegistrationFailure({
          sourceKey: "development:forged",
          generation: 1,
          languageId: "toy",
          revision: 1,
          reason: "monaco",
          detail,
        }),
      );
    }
  }
  const markerFile = path.join(app.getPath("userData"), "plugins/session.json");
  const marker = async () =>
    JSON.parse(await readFile(markerFile, "utf8")) as {
      thirdPartyStaticContributions: boolean;
      thirdPartyRunning: boolean;
      rendererUnresponsive: boolean;
    };
  const toy = () => plugins.state().plugins.find((row) => row.id === "acme.toy");
  const builtinId = input.binding.language;

  if (phase === "browser") {
    await win.webContents.executeJavaScript("window.staticAcceptance");
  } else if (phase === "hostile-tokenization") {
    const ready = (await win.webContents.executeJavaScript("window.staticAcceptance")) as object;
    const before = await marker();
    assert.equal(before.thirdPartyStaticContributions, true);
    assert.equal(before.thirdPartyRunning, false);
    assert.equal(launches, 0);
    console.log(
      STRESS_EVENT_PREFIX +
        JSON.stringify({
          ...ready,
          type: "ready",
          launches,
          rendererPid: win.webContents.getOSProcessId(),
        }),
    );
    // This promise should never settle. The separate Node parent owns the deadline.
    await win.webContents.executeJavaScript("window.staticHostileTokenize()");
    throw new Error("Hostile Monaco tokenization unexpectedly completed");
  } else if (phase === "recover-hostile") {
    const proof = JSON.parse(
      await readFile(path.join(directory, "stress-result.json"), "utf8"),
    ) as {
      marker: { rendererUnresponsive: boolean };
    };
    const reason = proof.marker.rendererUnresponsive ? "renderer-unresponsive" : "unclean-exit";
    assert.equal(plugins.state().safeMode, true);
    assert.equal(plugins.state().safeModeLock?.reason, reason);
    // Bootstrap only: the browser waits for this call before Disable and Restore.
    await win.webContents.executeJavaScript("window.staticAcceptance");
    const recovery = (await win.webContents.executeJavaScript("window.staticHostileRecover()")) as {
      hostileSourceKey: string;
    };
    const saved = JSON.parse(
      await readFile(path.join(app.getPath("userData"), "plugins/state.json"), "utf8"),
    ) as { disabled: string[] };
    assert.ok(saved.disabled.includes(recovery.hostileSourceKey));
    assert.equal(plugins.state().safeMode, false);
    assert.equal(plugins.state().safeModeLock, undefined);
    await writeFile(
      path.join(directory, "stress-recovery.json"),
      JSON.stringify({ reason, ...recovery }),
    );
  } else if (phase === "lifecycle") {
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
    const sourceKey = toy()!.sourceKey;
    const disabled = await api.setEnabled(sourceKey, false);
    assert.equal(disabled.ok, true);
    if (disabled.ok) assert.notEqual(disabled.persisted, false);
    const saved = JSON.parse(
      await readFile(path.join(app.getPath("userData"), "plugins/state.json"), "utf8"),
    ) as { disabled: string[] };
    assert.ok(saved.disabled.includes(sourceKey));
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
