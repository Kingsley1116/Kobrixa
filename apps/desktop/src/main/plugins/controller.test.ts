import type * as LifecycleModule from "../device-broker/lifecycle-coordinator.js";
import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
import type {
  ResourceOwner as ImportedResourceOwner,
  RpcPeer as ImportedRpcPeer,
} from "@kobrixa/plugin-protocol";
import { BUILTIN_PLUGIN_SOURCES } from "./builtin.js";
import { readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  developmentSourceKey,
  emptyStaticLanguagesCatalog,
  type StaticLanguagesCatalog,
  type ValidatedStaticLanguage,
  type ReportLanguageRegistrationFailureInput,
  PluginError,
  PluginManager,
  type PluginManagerOptions,
  type PluginPersistedState,
  type LaunchablePlugin,
  type PluginManagerEvent,
  type PluginsSnapshot,
} from "@kobrixa/plugin-runtime";
import type { PluginsViewEvent, PythonProbe } from "../../shared/plugins.js";
import {
  PluginController,
  desktopDeviceAccess,
  startPlugins,
  type PluginManagerPort,
  type StartPluginsOptions,
} from "./controller.js";
import { PluginLogs, PluginNotices } from "./logs.js";
import { registerPluginIpc } from "./ipc.js";
import type { IpcMainInvokeEvent } from "electron";
import type { PluginStateDocument } from "./state-store.js";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  dialog: { showSaveDialog: vi.fn() },
  clipboard: { writeText: vi.fn() },
  utilityProcess: {},
  MessageChannelMain: class {},
}));

let root: string;
let userData: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-controller-")));
  userData = path.join(root, "user-data");
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

async function pluginFolder(name: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.cjs"), "");
  await writeFile(
    path.join(directory, "kobrixa-plugin.json"),
    JSON.stringify({
      id: `acme.${name}`,
      version: "1.0.0",
      apiVersion: "^1.0.0",
      displayName: { en: `Hello ${name}`, "zh-TW": `哈囉 ${name}` },
      runtime: { kind: "node", entry: "index.cjs" },
      contributes: { commands: [{ id: `acme.${name}.greet`, title: "Greet" }] },
    }),
  );
  return directory;
}
const fakeDialogs = () => ({
  confirmDeveloperMode: vi.fn(async () => true),
  chooseFolder: vi.fn(async (): Promise<string | undefined> => undefined),
  confirmLink: vi.fn(async () => true),
  confirmUnlink: vi.fn(async () => true),
  choosePython: vi.fn(async (): Promise<string | undefined> => undefined),
});
const usable: PythonProbe = {
  status: "ok",
  version: "3.12.0",
  path: "/usr/bin/python3",
  sdkApiVersion: "1.0.0",
};
let hooks: Parameters<NonNullable<StartPluginsOptions["launcher"]>>[0];
const start = (dialogs = fakeDialogs(), options: Partial<StartPluginsOptions> = {}) =>
  startPlugins({
    userData,
    builtins: [],
    commandLine: { developmentDirectories: [], safeMode: false },
    dialogs,
    locale: "en",
    launcher: (given) => {
      hooks = given;
      return async () => {
        throw new PluginError("PLUGIN_E_LAUNCH", "Plugins do not run in these tests.");
      };
    },
    probe: async () => usable,
    platform: "linux",
    ...options,
  });
const enabled = async (dialogs = fakeDialogs(), options: Partial<StartPluginsOptions> = {}) => {
  const controller = await start(dialogs, options);
  expect(await controller.setDeveloperMode(true)).toMatchObject({ ok: true });
  return controller;
};
const saved = async () =>
  JSON.parse(await readFile(path.join(userData, "plugins/state.json"), "utf8"));

it("accepts same-revision sibling failures through IPC and the real controller/runtime", async () => {
  const sources = structuredClone(BUILTIN_PLUGIN_SOURCES);
  const source = sources[0]!;
  if (source.kind !== "builtin") throw new Error("Expected a builtin fixture");
  const manifest = source.manifest as {
    contributes: { languages: { id: string; extensions: string[] }[] };
  };
  manifest.contributes.languages.push({
    ...manifest.contributes.languages[0]!,
    id: "second",
    extensions: ["second"],
  });
  const controller = await start(fakeDialogs(), { builtins: sources });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const off = registerPluginIpc(
    (channel, action) => {
      handlers.set(channel, action as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
    },
    controller,
    () => {},
  );
  try {
    const catalog = controller.staticLanguages();
    expect(catalog.languages).toHaveLength(2);
    const report = handlers.get("plugins:report-language-registration-failure")!;
    const reports = catalog.languages.map((language) => ({
      sourceKey: language.sourceKey,
      generation: language.generation,
      languageId: language.id,
      revision: catalog.revision,
      reason: "dto-version",
      detail: "Unsupported catalog version.",
    }));
    expect(reports.map((input) => report({} as IpcMainInvokeEvent, input))).toEqual([
      { accepted: true, revision: catalog.revision + 1 },
      { accepted: true, revision: catalog.revision + 2 },
    ]);
    expect(controller.staticLanguages().languages).toEqual([]);
    expect(controller.state().plugins[0]!.problems).toEqual(
      reports.map((input) =>
        expect.objectContaining({
          code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
          detail: { languageId: input.languageId },
        }),
      ),
    );
    for (const input of reports)
      expect(report({} as IpcMainInvokeEvent, input)).toEqual({
        accepted: false,
        revision: catalog.revision + 2,
      });
  } finally {
    off();
    await controller.shutdown();
  }
});

describe("startPlugins", () => {
  it("starts with developer mode off and refuses developer actions before any dialog", async () => {
    const dialogs = fakeDialogs();
    const controller = await start(dialogs);
    expect(controller.state()).toMatchObject({
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      safeMode: false,
      inflight: [],
      python: { pendingReload: [] },
    });
    for (const result of [
      await controller.linkFolder(),
      await controller.reload("dev:0123456789abcdef"),
      await controller.unlink("dev:0123456789abcdef"),
      await controller.setPython("python3"),
      await controller.setEnabled("dev:0123456789abcdef", true),
    ])
      expect(result).toMatchObject({ ok: false, code: "PLUGIN_E_DEVELOPER_MODE" });
    expect(dialogs.chooseFolder).not.toHaveBeenCalled();
  });

  it("turns developer mode on only after confirmation and remembers it", async () => {
    const dialogs = fakeDialogs();
    dialogs.confirmDeveloperMode.mockResolvedValueOnce(false);
    const controller = await start(dialogs);
    expect(await controller.setDeveloperMode(true)).toMatchObject({
      ok: true,
      outcome: "cancelled",
      state: { developer: { enabled: false } },
    });
    expect(await controller.setDeveloperMode(true)).toMatchObject({
      ok: true,
      state: { developer: { enabled: true } },
    });
    expect((await saved()).developerMode).toBe(true);
    expect((await start()).state().developer.enabled).toBe(true);
  });

  it("links a folder after confirmation, keeps it across restarts and refuses it twice", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, sourceKey: key });
    expect(dialogs.confirmLink).toHaveBeenCalledWith({
      name: "Hello hello",
      id: "acme.hello",
      runtime: "node",
      directory: folder,
      problems: [],
    });
    expect(controller.state()).toMatchObject({
      origins: { [key]: "linked" },
      developer: { linkedCount: 1 },
    });
    expect(controller.state().plugins.map((plugin) => [plugin.sourceKey, plugin.status])).toEqual([
      [key, "enabled"],
    ]);
    expect((await saved()).sources).toEqual([{ directory: folder }]);
    expect((await start()).state().origins).toEqual({ [key]: "linked" });
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    expect(await controller.linkFolder()).toMatchObject({
      ok: true,
      outcome: "duplicate",
      sourceKey: key,
    });
    expect(dialogs.confirmLink).toHaveBeenCalledOnce();
  });

  it("stores only one source when links of the same folder overlap", async () => {
    const folder = await pluginFolder("hello");
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValue(folder);
    let confirm!: (value: boolean) => void;
    const confirmed = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    let confirmations = 0;
    dialogs.confirmLink.mockImplementation(() => {
      confirmations += 1;
      if (confirmations === 2) confirm(true);
      return confirmed;
    });
    const results = await Promise.all([controller.linkFolder(), controller.linkFolder()]);
    expect(dialogs.confirmLink).toHaveBeenCalledTimes(2);
    for (const result of results)
      expect(result).toMatchObject({ ok: true, sourceKey: developmentSourceKey(folder) });
    expect((await saved()).sources).toEqual([{ directory: folder }]);
    expect(controller.state().plugins).toHaveLength(1);
    expect(controller.state().developer.linkedCount).toBe(1);
    expect((await start()).state().plugins).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "treats a symlink to a linked folder as a duplicate",
    async () => {
      const folder = await pluginFolder("hello");
      const alias = path.join(root, "alias");
      await symlink(folder, alias);
      const dialogs = fakeDialogs();
      const controller = await enabled(dialogs);
      dialogs.chooseFolder.mockResolvedValueOnce(folder).mockResolvedValueOnce(alias);
      await controller.linkFolder();
      expect(await controller.linkFolder()).toMatchObject({
        outcome: "duplicate",
        sourceKey: developmentSourceKey(folder),
      });
    },
  );

  it("treats a differently-cased path that resolves to a linked folder as a duplicate", async () => {
    const folder = await pluginFolder("hello");
    const dialogs = fakeDialogs();
    // On a case-insensitive file system realpath returns the folder's real spelling.
    const controller = await enabled(dialogs, {
      realpath: async (directory) =>
        directory.toLowerCase() === folder.toLowerCase() ? folder : directory,
    });
    dialogs.chooseFolder.mockResolvedValueOnce(folder).mockResolvedValueOnce(folder.toUpperCase());
    await controller.linkFolder();
    expect(await controller.linkFolder()).toMatchObject({
      outcome: "duplicate",
      sourceKey: developmentSourceKey(folder),
    });
    expect(controller.state().plugins).toHaveLength(1);
  });

  it("changes nothing when the folder dialog is cancelled or the link is declined", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, outcome: "cancelled" });
    dialogs.chooseFolder.mockResolvedValueOnce(await pluginFolder("hello"));
    dialogs.confirmLink.mockResolvedValueOnce(false);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(controller.state().plugins).toEqual([]);
    expect((await saved()).sources).toEqual([]);
  });

  it("re-checks permission after the confirmation dialog closes", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(await pluginFolder("hello"));
    dialogs.confirmLink.mockImplementationOnce(async () => {
      await controller.shutdown();
      return true;
    });
    expect(await controller.linkFolder()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SHUTTING_DOWN",
    });
    expect((await saved()).sources).toEqual([]);
    expect(await controller.setDeveloperMode(false)).toMatchObject({
      code: "PLUGIN_E_SHUTTING_DOWN",
    });
    await controller.resume();
    expect(await controller.setDeveloperMode(false)).toMatchObject({ ok: true });
  });

  it("turning developer mode off stops development plugins but keeps links and disables", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await controller.linkFolder();
    await controller.setEnabled(key, false);
    expect(await controller.setDeveloperMode(false)).toMatchObject({
      ok: true,
      state: { plugins: [], developer: { enabled: false, linkedCount: 1 } },
    });
    expect(await saved()).toMatchObject({
      developerMode: false,
      sources: [{ directory: folder }],
      disabled: [key],
    });
    await controller.setDeveloperMode(true);
    expect(controller.state().plugins).toMatchObject([
      { sourceKey: key, status: "disabled", disabledBy: "user" },
    ]);
    expect(dialogs.confirmDeveloperMode).toHaveBeenCalledTimes(2);
  });

  it("treats --plugin-dev-dir folders as session sources that authorize developer mode", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await start(dialogs, {
      commandLine: { developmentDirectories: [folder], safeMode: false },
    });
    expect(controller.state()).toMatchObject({
      developer: { enabled: true, commandLine: true },
      origins: { [key]: "session" },
    });
    expect(await controller.unlink(key)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SESSION_SOURCE",
    });
    await expect(readFile(path.join(userData, "plugins/state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, sourceKey: key });
    expect(controller.state().origins).toEqual({ [key]: "linked" });
    expect(controller.state().plugins).toHaveLength(1);
  });

  it("unlinks after confirmation, keeps the files and clears the source's logs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await controller.linkFolder();
    const launched: LaunchablePlugin = {
      id: "acme.hello",
      sourceKey: key,
      directory: folder,
      entry: path.join(folder, "index.cjs"),
      runtime: "node",
      permissions: [],
      commands: ["acme.hello.greet"],
    };
    hooks.onOutput(launched, "hello from it");
    expect(controller.readLog(key, 0).lines.map((line) => line.text)).toEqual(["hello from it"]);
    dialogs.confirmUnlink.mockResolvedValueOnce(false);
    expect(await controller.unlink(key)).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(controller.state().plugins).toHaveLength(1);
    expect(await controller.unlink(key)).toMatchObject({
      ok: true,
      state: { plugins: [], developer: { linkedCount: 0 } },
    });
    expect(dialogs.confirmUnlink).toHaveBeenLastCalledWith({
      name: "Hello hello",
      directory: folder,
    });
    expect(controller.readLog(key, 0).lines).toEqual([]);
    expect((await saved()).sources).toEqual([]);
    await expect(readFile(path.join(folder, "kobrixa-plugin.json"), "utf8")).resolves.toContain(
      "acme.hello",
    );
  });

  it("refreshes a plugin's display name in the help catalog after a reload changes its revision", async () => {
    const folder = await pluginFolder("hello");
    const controller = await start(fakeDialogs(), {
      commandLine: { developmentDirectories: [folder], safeMode: false },
    });
    const first = controller.diagnosticHelp();
    expect(first.plugins["acme.hello"]).toEqual({
      displayName: { en: "Hello hello", "zh-TW": "哈囉 hello" },
      entries: [],
    });
    const file = path.join(folder, "kobrixa-plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.displayName = { en: "Renamed hello", "zh-TW": "新名 hello" };
    await writeFile(file, JSON.stringify(manifest));
    expect(await controller.reload(developmentSourceKey(folder))).toMatchObject({ ok: true });
    const refreshed = controller.diagnosticHelp();
    expect(refreshed.plugins["acme.hello"]).toEqual({
      displayName: manifest.displayName,
      entries: [],
    });
    expect(refreshed.revision).toBeGreaterThan(first.revision);
    expect(controller.state().diagnosticHelpRevision).toBe(refreshed.revision);
  });

  it("points a linked folder that moved at its new location", async () => {
    const folder = await pluginFolder("hello");
    const oldKey = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await controller.linkFolder();
    const moved = path.join(root, "moved");
    await rename(folder, moved);
    await controller.reload(oldKey);
    expect(controller.state().plugins[0]!.status).toBe("invalid");
    expect(controller.state().plugins[0]!.problems[0]!.code).toBe("PLUGIN_E_MANIFEST");
    dialogs.chooseFolder.mockResolvedValueOnce(moved);
    expect(await controller.relinkFolder(oldKey)).toMatchObject({
      ok: true,
      sourceKey: developmentSourceKey(moved),
    });
    expect(controller.state().plugins.map((plugin) => [plugin.sourceKey, plugin.status])).toEqual([
      [developmentSourceKey(moved), "enabled"],
    ]);
    expect((await saved()).sources).toEqual([{ directory: moved }]);
  });

  it("in --safe-mode refuses linking and reloading but allows disabling and unlinking", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const first = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await first.linkFolder();
    const controller = await start(dialogs, {
      commandLine: { developmentDirectories: [], safeMode: true },
    });
    expect(controller.state()).toMatchObject({
      safeMode: true,
      plugins: [{ sourceKey: key, disabledBy: "safe-mode" }],
    });
    expect(controller.state().safeModeLock).toBeUndefined();
    expect(await controller.linkFolder()).toMatchObject({ code: "PLUGIN_E_SAFE_MODE" });
    expect(await controller.reload(key)).toMatchObject({ code: "PLUGIN_E_SAFE_MODE" });
    // --safe-mode lasts the whole session, even after restoring.
    expect(await controller.clearSafeModeLock()).toMatchObject({
      ok: true,
      state: { safeMode: true },
    });
    expect(await controller.setEnabled(key, false)).toMatchObject({ ok: true });
    expect(await controller.unlink(key)).toMatchObject({ ok: true });
    expect((await saved()).safeModeLock).toBeUndefined();
  });

  it.each([false, true])(
    "locks recovery after renderer hangs even without development sources (developer mode: %s)",
    async (developerMode) => {
      const controller = await enabled();
      await controller.setDeveloperMode(developerMode);
      controller.markRendererUnresponsive();
      const marker = JSON.parse(
        await readFile(path.join(userData, "plugins/session.json"), "utf8"),
      );
      expect.soft(marker.rendererUnresponsive).toBe(true);
      controller.finishSession();
      const restarted = await start();
      expect.soft(restarted.state().safeMode).toBe(true);
      expect
        .soft(restarted.state().safeModeLock)
        .toMatchObject({ reason: "renderer-unresponsive" });
      expect((await saved()).safeModeLock).toMatchObject({ reason: "renderer-unresponsive" });
    },
  );

  it.each([
    { developerMode: false, linked: false },
    { developerMode: true, linked: false },
    { developerMode: false, linked: true },
  ])(
    "ignores an unclean marker without session development sources: %j",
    async ({ developerMode, linked }) => {
      const dialogs = fakeDialogs();
      const controller = await enabled(dialogs);
      if (linked) {
        dialogs.chooseFolder.mockResolvedValueOnce(await pluginFolder("hello"));
        await controller.linkFolder();
      }
      await controller.setDeveloperMode(developerMode);
      await writeFile(
        path.join(userData, "plugins/session.json"),
        JSON.stringify({
          startedAt: "2026-10-15T00:00:00.000Z",
          thirdPartyRunning: true,
          rendererUnresponsive: false,
        }),
      );
      const restarted = await start();
      expect.soft(restarted.state().safeMode).toBe(false);
      expect.soft(restarted.state().safeModeLock).toBeUndefined();
      expect((await saved()).safeModeLock).toBeUndefined();
      expect(
        JSON.parse(await readFile(path.join(userData, "plugins/session.json"), "utf8")),
      ).toMatchObject({
        thirdPartyRunning: false,
        rendererUnresponsive: false,
      });
    },
  );

  it("locks safe mode after a renderer hang with command-line development sources", async () => {
    const commandLine = { developmentDirectories: [await pluginFolder("hello")], safeMode: false };
    const controller = await start(fakeDialogs(), { commandLine });
    controller.markRendererUnresponsive();
    controller.finishSession();
    const restarted = await start(fakeDialogs(), { commandLine });
    expect(restarted.state()).toMatchObject({
      safeMode: true,
      safeModeLock: { reason: "renderer-unresponsive" },
    });
    expect((await saved()).safeModeLock.reason).toBe("renderer-unresponsive");
  });

  it.each(
    [
      { reason: "unclean-exit", disable: "before-crash" },
      { reason: "renderer-unresponsive", disable: "before-crash" },
      { reason: "unclean-exit", disable: "in-safe-mode" },
      { reason: "renderer-unresponsive", disable: "in-safe-mode" },
    ].flatMap((scenario) => [
      { ...scenario, spelling: "alias-only" },
      { ...scenario, spelling: "alias-and-canonical" },
    ]),
  )(
    "preserves an aliased session source disable across $reason ($disable, $spelling)",
    async ({ reason, disable, spelling }) => {
      const folder = path.join(root, "toy");
      await cp(
        new URL(
          "../../../../../packages/plugin-protocol/test-fixtures/static-languages/toy/",
          import.meta.url,
        ),
        folder,
        { recursive: true },
      );
      const alias = path.join(root, "toy-alias");
      await symlink(folder, alias, "dir");
      const key = developmentSourceKey(folder);
      const aliasKey = developmentSourceKey(alias);
      expect(aliasKey).not.toBe(key);
      // Also exercise deduplication when both spellings were supplied on the command line.
      const commandLine = {
        developmentDirectories: spelling === "alias-only" ? [alias] : [alias, folder, alias],
        safeMode: false,
      };
      const launcher = vi.fn(async () => {
        throw new Error("Static contributions must not launch a process.");
      });
      const options = { commandLine, builtins: BUILTIN_PLUGIN_SOURCES, launcher: () => launcher };
      const first = await start(fakeDialogs(), options);
      expect(first.staticLanguages().languages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "toy", sourceKey: key })]),
      );
      if (reason === "renderer-unresponsive") first.markRendererUnresponsive();
      if (disable === "before-crash") {
        const result = await first.setEnabled(key, false);
        expect(result.ok).toBe(true);
        expect(result).not.toHaveProperty("persisted", false);
        expect(await saved()).toMatchObject({ sources: [], disabled: [key] });
      }
      expect(
        JSON.parse(await readFile(path.join(userData, "plugins/session.json"), "utf8")),
      ).toMatchObject({
        thirdPartyStaticContributions: true,
        thirdPartyRunning: false,
        rendererUnresponsive: reason === "renderer-unresponsive",
      });
      // Do not finish the first session: the next controller reads its real persisted crash marker.
      const resolve = vi.fn((directory: string) => realpath(directory));
      const recovered = await start(fakeDialogs(), { ...options, realpath: resolve });
      expect(resolve).not.toHaveBeenCalled();
      expect(recovered.state()).toMatchObject({ safeMode: true, safeModeLock: { reason } });
      expect(
        recovered
          .staticLanguages()
          .languages.every((language) => language.sourceKey.startsWith("builtin:")),
      ).toBe(true);
      if (disable === "in-safe-mode") {
        expect(await recovered.setEnabled(aliasKey, false)).toMatchObject({ ok: true });
        expect((await saved()).disabled).toEqual([aliasKey]);
      }
      const events: PluginsViewEvent[] = [];
      const off = recovered.onEvent((event) => events.push(event));
      expect(await recovered.clearSafeModeLock()).toMatchObject({ ok: true });
      off();
      expect(recovered.staticLanguages().languages.some((language) => language.id === "toy")).toBe(
        false,
      );
      expect(
        recovered
          .staticLanguages()
          .languages.some((language) => language.sourceKey.startsWith("builtin:")),
      ).toBe(true);
      expect(
        recovered.state().plugins.filter((plugin) => plugin.source === "development"),
      ).toMatchObject([{ sourceKey: key, status: "disabled", disabledBy: "user" }]);
      expect(
        events
          .filter((event) => event.type === "state")
          .every((event) =>
            event.state.staticLanguageOwners.every((owner) =>
              owner.sourceKey.startsWith("builtin:"),
            ),
          ),
      ).toBe(true);
      expect(await saved()).toMatchObject({ sources: [], disabled: [key] });
      expect((await saved()).safeModeLock).toBeUndefined();
      expect(await recovered.setEnabled(key, true)).toMatchObject({ ok: true });
      expect(recovered.staticLanguages().languages.some((language) => language.id === "toy")).toBe(
        true,
      );
      expect((await saved()).disabled).toEqual([]);
      recovered.finishSession();
      const restarted = await start(fakeDialogs(), options);
      expect(restarted.state().safeMode).toBe(false);
      expect(restarted.staticLanguages().languages.some((language) => language.id === "toy")).toBe(
        true,
      );
      expect(launcher).not.toHaveBeenCalled();
      restarted.finishSession();
    },
  );

  it("locks safe mode after an unclean exit with third-party plugins running until restored", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const first = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await first.linkFolder();
    // The previous session crashed while a plugin process ran.
    await writeFile(
      path.join(userData, "plugins/session.json"),
      JSON.stringify({
        startedAt: "2026-10-15T00:00:00.000Z",
        thirdPartyRunning: true,
        rendererUnresponsive: false,
      }),
    );
    const locked = await start(dialogs, { now: () => new Date("2026-10-15T08:00:00.000Z") });
    expect(locked.state()).toMatchObject({
      safeMode: true,
      safeModeLock: { since: "2026-10-15T08:00:00.000Z", reason: "unclean-exit" },
      plugins: [{ sourceKey: key, disabledBy: "safe-mode" }],
    });
    // The lock survives restarts until the user restores plugins.
    const still = await start(dialogs);
    expect(still.state()).toMatchObject({
      safeMode: true,
      safeModeLock: { reason: "unclean-exit" },
    });
    expect(await still.clearSafeModeLock()).toMatchObject({
      ok: true,
      state: { safeMode: false, plugins: [{ sourceKey: key, status: "enabled" }] },
    });
    expect(still.state().safeModeLock).toBeUndefined();
    expect((await saved()).safeModeLock).toBeUndefined();
    expect((await start(dialogs)).state().safeMode).toBe(false);
  });
});

describe("session source recovery regressions", () => {
  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function fixture(safeMode = false) {
    const folder = path.join(root, "toy");
    await cp(
      new URL(
        "../../../../../packages/plugin-protocol/test-fixtures/static-languages/toy/",
        import.meta.url,
      ),
      folder,
      { recursive: true },
    );
    const alias = path.join(root, "toy-alias");
    await symlink(folder, alias, "dir");
    const key = developmentSourceKey(folder);
    const aliasKey = developmentSourceKey(alias);
    await mkdir(path.join(userData, "plugins"), { recursive: true });
    await writeFile(
      path.join(userData, "plugins/state.json"),
      JSON.stringify({
        schemaVersion: 2,
        developerMode: false,
        sources: [],
        disabled: [],
        legacyDisabledIds: [],
        ...(!safeMode
          ? { safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" } }
          : {}),
      }),
    );
    const resolve = vi.fn((directory: string) => realpath(directory));
    const launcher = vi.fn(async () => {
      throw new Error("Static contributions must not launch a process.");
    });
    const options = {
      commandLine: { developmentDirectories: [alias], safeMode },
      builtins: BUILTIN_PLUGIN_SOURCES,
      realpath: resolve,
      launcher: () => launcher,
    };
    const controller = await start(fakeDialogs(), options);
    expect(resolve).not.toHaveBeenCalled();
    return { controller, folder, alias, key, aliasKey, options, resolve, launcher };
  }

  function observe(controller: PluginController) {
    const states = [controller.state()];
    controller.onEvent((event) => {
      if (event.type === "state") states.push(event.state);
    });
    return () => {
      for (const state of states)
        expect(
          state.staticLanguageOwners.every((owner) => owner.sourceKey.startsWith("builtin:")),
        ).toBe(true);
      expect(controller.staticLanguages().languages.map((language) => language.id)).not.toContain(
        "toy",
      );
    };
  }

  async function blockStateWrites() {
    const file = path.join(userData, "plugins/state.json");
    const backup = `${file}.saved`;
    await rename(file, backup);
    await mkdir(file);
    return async () => {
      await rm(file, { recursive: true });
      await rename(backup, file);
    };
  }

  it("reports a missing folder, retains its alias and disable, and migrates on retry", async () => {
    const { controller, folder, alias, aliasKey, key, resolve } = await fixture();
    expect(await controller.setEnabled(aliasKey, false)).toMatchObject({ ok: true });
    const assertNoToy = observe(controller);
    await rename(folder, `${folder}-away`);
    expect(await controller.clearSafeModeLock()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_MANIFEST",
      message: expect.stringContaining(alias),
    });
    expect(controller.state()).toMatchObject({ safeMode: true });
    expect(await controller.reload(aliasKey)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SAFE_MODE",
    });
    expect(controller.state().plugins).toContainEqual(
      expect.objectContaining({ sourceKey: aliasKey, disabledBy: "user" }),
    );
    expect((await saved()).disabled).toEqual([aliasKey]);
    await rename(`${folder}-away`, folder);
    expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
    expect(resolve).toHaveBeenCalledWith(alias);
    expect((await saved()).disabled).toEqual([key]);
    assertNoToy();
  });

  it("retries Restore after a failed migration save without losing or reviving a disable", async () => {
    const { controller, aliasKey, key } = await fixture();
    await controller.setEnabled(aliasKey, false);
    const assertNoToy = observe(controller);
    const repair = await blockStateWrites();
    expect(await controller.clearSafeModeLock()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_STATE_SAVE",
    });
    expect(controller.state().safeMode).toBe(true);
    await repair();
    expect((await saved()).disabled).toEqual([aliasKey]);
    expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
    expect(await saved()).toMatchObject({ sources: [], disabled: [key] });
    expect((await saved()).safeModeLock).toBeUndefined();
    assertNoToy();
  });

  it("leaves no stale alias after an alias-removal write failure and a later successful save", async () => {
    const { controller, aliasKey, key } = await fixture();
    await controller.setEnabled(aliasKey, false);
    const remove = PluginManager.prototype.removeSource;
    vi.spyOn(PluginManager.prototype, "removeSource").mockImplementationOnce(async function (
      this: PluginManager,
      sourceKey,
      options,
    ) {
      const repair = await blockStateWrites();
      try {
        return await remove.call(this, sourceKey, options);
      } finally {
        await repair();
      }
    });
    expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
    expect(await saved()).toMatchObject({ sources: [], disabled: [key] });
  });

  it("Restore under CLI safe mode never resolves or loads a development folder", async () => {
    const { controller, aliasKey, resolve, launcher } = await fixture(true);
    await controller.setEnabled(aliasKey, false);
    const assertNoToy = observe(controller);
    expect(await controller.clearSafeModeLock()).toMatchObject({
      ok: true,
      state: { safeMode: true },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(launcher).not.toHaveBeenCalled();
    expect(await controller.reload(aliasKey)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SAFE_MODE",
    });
    expect((await saved()).disabled).toEqual([aliasKey]);
    assertNoToy();
  });

  it.each(["cli", "developer-off"] as const)(
    "migrates a %s session alias disable on the next normal startup",
    async (condition) => {
      const { controller, options, aliasKey, key, resolve } = await fixture(condition === "cli");
      await controller.setEnabled(aliasKey, false);
      if (condition === "developer-off") await controller.setDeveloperMode(false);
      if (condition !== "cli")
        expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
      controller.finishSession();
      const restarted = await start(fakeDialogs(), {
        ...options,
        commandLine: { ...options.commandLine, safeMode: false },
      });
      expect(restarted.state().safeMode).toBe(false);
      expect(restarted.state().plugins).toContainEqual(
        expect.objectContaining({ sourceKey: key, status: "disabled", disabledBy: "user" }),
      );
      expect(restarted.staticLanguages().languages.map((language) => language.id)).not.toContain(
        "toy",
      );
      expect(await saved()).toMatchObject({ sources: [], disabled: [key] });
      expect(resolve).toHaveBeenCalled();
      restarted.finishSession();
    },
  );

  it("migrates a retained disable while developer mode is off before Restore", async () => {
    const { controller, aliasKey, key } = await fixture();
    await controller.setEnabled(aliasKey, false);
    await controller.setDeveloperMode(false);
    const assertNoToy = observe(controller);
    expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
    expect(await saved()).toMatchObject({ developerMode: false, sources: [], disabled: [key] });
    expect(await controller.setDeveloperMode(true)).toMatchObject({ ok: true });
    expect(controller.state().plugins).toContainEqual(
      expect.objectContaining({ sourceKey: key, disabledBy: "user" }),
    );
    assertNoToy();
  });

  it.each([
    { condition: "missing-folder", disabled: false },
    { condition: "missing-folder", disabled: true },
    { condition: "missing-folder-read-only", disabled: true },
    { condition: "save-failure", disabled: true },
  ] as const)(
    "exposes recovery after $condition (disabled: $disabled) and retries migration",
    async ({ condition, disabled }) => {
      const { controller, options, folder, aliasKey, key, resolve } = await fixture(true);
      if (disabled) await controller.setEnabled(aliasKey, false);
      controller.finishSession();
      let repair = async () => {};
      if (condition !== "save-failure") {
        await rename(folder, `${folder}-away`);
        repair = async () => {
          await rename(`${folder}-away`, folder);
        };
        if (condition === "missing-folder-read-only")
          resolve.mockImplementationOnce(async () => {
            const repairWrites = await blockStateWrites();
            const repairFolder = repair;
            repair = async () => {
              await repairWrites();
              await repairFolder();
            };
            throw new Error("Folder is unavailable and settings are read-only.");
          });
      } else
        resolve.mockImplementationOnce(async (directory) => {
          repair = await blockStateWrites();
          return realpath(directory);
        });
      const restarted = await start(fakeDialogs(), {
        ...options,
        commandLine: { ...options.commandLine, safeMode: false },
      });
      const states = [restarted.state()];
      restarted.onEvent((event) => {
        if (event.type === "state") states.push(event.state);
      });
      expect(restarted.state()).toMatchObject({
        safeMode: true,
        sessionRecovery: true,
        stateProblem: {
          code: condition === "save-failure" ? "PLUGIN_E_STATE_SAVE" : "PLUGIN_E_MANIFEST",
        },
      });
      expect(restarted.state().safeModeLock).toBeUndefined();
      expect(restarted.state().stateProblem?.message).toContain("--plugin-dev-dir");
      expect(restarted.state().plugins).toContainEqual(
        expect.objectContaining({
          sourceKey: aliasKey,
          disabledBy: disabled ? "user" : "safe-mode",
        }),
      );
      expect(await restarted.clearSafeModeLock()).toMatchObject({ ok: false });
      expect(restarted.state()).toMatchObject({ safeMode: true, sessionRecovery: true });
      await repair();
      expect((await saved()).disabled).toEqual(disabled ? [aliasKey] : []);
      expect(await restarted.clearSafeModeLock()).toMatchObject({
        ok: true,
        state: { safeMode: false },
      });
      expect((await saved()).disabled).toEqual(disabled ? [key] : []);
      expect(restarted.state().sessionRecovery).toBeUndefined();
      expect(restarted.state().stateProblem).toBeUndefined();
      expect(restarted.state().plugins).toContainEqual(
        expect.objectContaining({ sourceKey: key, status: disabled ? "disabled" : "enabled" }),
      );
      for (const state of states) {
        if (state.safeMode) expect(state.sessionRecovery).toBe(true);
        if (state.safeMode || disabled)
          expect(
            state.staticLanguageOwners.every((owner) => owner.sourceKey.startsWith("builtin:")),
          ).toBe(true);
      }
      expect(restarted.staticLanguages().languages.some((language) => language.id === "toy")).toBe(
        !disabled,
      );
    },
  );

  it("keeps the corrupt-state backup notice alongside a failed session-folder restore", async () => {
    const { controller, options, folder, alias } = await fixture(true);
    controller.finishSession();
    await writeFile(path.join(userData, "plugins/state.json"), "{broken");
    const restarted = await start(fakeDialogs(), {
      ...options,
      commandLine: { ...options.commandLine, safeMode: false },
    });
    const original = restarted.state().stateProblem!;
    expect(original.code).toBe("PLUGIN_E_STATE_CORRUPT");
    expect(original.message).toContain("state.json.corrupt-");
    const states = [restarted.state()];
    restarted.onEvent((event) => {
      if (event.type === "state") states.push(event.state);
    });
    await rename(folder, `${folder}-away`);
    expect(await restarted.clearSafeModeLock()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_MANIFEST",
    });
    for (const state of [restarted.state(), states.at(-1)!]) {
      expect(state.stateProblem?.code).toBe("PLUGIN_E_STATE_CORRUPT");
      expect(state.stateProblem?.message).toContain(original.message);
      expect(state.stateProblem?.message).toContain(`${alias} cannot be resolved`);
    }
  });

  it.each(["disable", "developer-off", "restore"] as const)(
    "serializes concurrent %s during descriptor replacement",
    async (action) => {
      const { controller, aliasKey, key } = await fixture();
      if (action === "restore") await controller.setEnabled(aliasKey, false);
      const assertNoToy = observe(controller);
      const entered = barrier();
      const release = barrier();
      const add = PluginManager.prototype.addSource;
      vi.spyOn(PluginManager.prototype, "addSource").mockImplementationOnce(async function (
        this: PluginManager,
        source,
      ) {
        entered.resolve();
        await release.promise;
        return add.call(this, source);
      });
      const restoring = controller.clearSafeModeLock();
      await entered.promise;
      const concurrent =
        action === "disable"
          ? controller.setEnabled(aliasKey, false)
          : action === "developer-off"
            ? controller.setDeveloperMode(false)
            : controller.clearSafeModeLock();
      // Give an unprotected mutation time to run while restoration is paused.
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      const results = await Promise.all([restoring, concurrent]);
      for (const result of results) expect(result).toMatchObject({ ok: true });
      expect(controller.state().safeMode).toBe(false);
      if (action === "developer-off") {
        expect(controller.state().developer.enabled).toBe(false);
        expect(controller.state().plugins.every((plugin) => plugin.source === "builtin")).toBe(
          true,
        );
      } else expect((await saved()).disabled).toEqual([key]);
      assertNoToy();
    },
  );

  it("waits for a disable already in progress before starting restoration", async () => {
    const { controller, aliasKey, key } = await fixture();
    const assertNoToy = observe(controller);
    const entered = barrier();
    const release = barrier();
    const setEnabled = PluginManager.prototype.setEnabled;
    vi.spyOn(PluginManager.prototype, "setEnabled").mockImplementationOnce(async function (
      this: PluginManager,
      sourceKey,
      enabled,
    ) {
      entered.resolve();
      await release.promise;
      return setEnabled.call(this, sourceKey, enabled);
    });
    const disabling = controller.setEnabled(aliasKey, false);
    await entered.promise;
    const restoring = controller.clearSafeModeLock();
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    for (const result of await Promise.all([disabling, restoring]))
      expect(result).toMatchObject({ ok: true });
    expect((await saved()).disabled).toEqual([key]);
    assertNoToy();
  });

  it("serializes developer mode being enabled during directory resolution", async () => {
    const { controller, aliasKey, key, resolve, alias } = await fixture();
    await controller.setEnabled(aliasKey, false);
    await controller.setDeveloperMode(false);
    const assertNoToy = observe(controller);
    const entered = barrier();
    const release = barrier();
    resolve.mockImplementationOnce(async (directory) => {
      entered.resolve();
      await release.promise;
      return realpath(directory);
    });
    const restoring = controller.clearSafeModeLock();
    await entered.promise;
    const enabling = controller.setDeveloperMode(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    for (const result of await Promise.all([restoring, enabling]))
      expect(result).toMatchObject({ ok: true });
    expect(resolve).toHaveBeenCalledWith(alias);
    expect(
      controller.state().plugins.filter((plugin) => plugin.source === "development"),
    ).toMatchObject([{ sourceKey: key, disabledBy: "user" }]);
    expect((await saved()).disabled).toEqual([key]);
    assertNoToy();
  });
});

describe("Python selection", () => {
  const probe = vi.fn(async (command: { executable: string }): Promise<PythonProbe> =>
    command.executable === "python"
      ? {
          status: "error",
          problem: "too-old",
          version: "3.8.0",
          detail: "Python 3.8.0 is older than 3.10.",
        }
      : usable,
  );

  it("lists probed candidates, saves a usable choice and refuses an unusable one", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs, { probe });
    expect(await controller.pythonCandidates()).toEqual([
      { id: "python3", label: "python3", selected: false, probe: usable },
      {
        id: "python",
        label: "python",
        selected: false,
        probe: expect.objectContaining({ status: "error" }),
      },
    ]);
    expect(await controller.setPython("python")).toMatchObject({
      ok: false,
      code: "PLUGIN_E_PYTHON_UNUSABLE",
    });
    expect(await controller.setPython("py")).toMatchObject({
      ok: false,
      code: "PLUGIN_E_PYTHON_UNUSABLE",
    });
    expect(await controller.setPython("python3")).toMatchObject({
      ok: true,
      state: { python: { current: { label: "python3", origin: "settings" } } },
    });
    expect(hooks.python()).toEqual({ executable: "python3", args: [] });
    expect((await saved()).python).toEqual({ executable: "python3", args: [] });
    expect((await controller.pythonCandidates())[0]!.selected).toBe(true);
    const restarted = await start(dialogs, { probe });
    expect(hooks.python()).toEqual({ executable: "python3", args: [] });
    expect(restarted.state().python.current).toEqual({ label: "python3", origin: "settings" });
  });

  it("probes a picked interpreter and offers it as the saved choice", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs, { probe });
    expect(await controller.setPython("other")).toMatchObject({ ok: true, outcome: "cancelled" });
    dialogs.choosePython.mockResolvedValueOnce("/opt/python/bin/python3.12");
    expect(await controller.setPython("other")).toMatchObject({ ok: true });
    expect(probe).toHaveBeenLastCalledWith({ executable: "/opt/python/bin/python3.12", args: [] });
    expect((await controller.pythonCandidates()).at(-1)).toMatchObject({
      id: "saved",
      label: "/opt/python/bin/python3.12",
      selected: true,
    });
  });

  it("lets --plugin-python override the saved choice for this session only", async () => {
    const controller = await enabled(fakeDialogs(), {
      probe,
      commandLine: { developmentDirectories: [], python: "/cli/python", safeMode: false },
    });
    await controller.pythonCandidates();
    await controller.setPython("python3");
    expect(hooks.python()).toEqual({ executable: "/cli/python", args: [] });
    expect(controller.state().python.current).toEqual({
      label: "/cli/python",
      origin: "command-line",
    });
    expect((await saved()).python).toEqual({ executable: "python3", args: [] });
  });
});

describe("PluginController with a fake manager", () => {
  const helpEntry = { code: "ACME1", title: { en: "t" }, cause: { en: "c" }, steps: { en: ["s"] } };
  const builtin: PluginsSnapshot["plugins"][number] = {
    sourceKey: "builtin:kobrixa.basic-plus",
    id: "kobrixa.basic-plus",
    source: "builtin",
    required: true,
    canToggle: false,
    runtime: "builtin",
    displayName: { en: "Basic Plus", "zh-TW": "Basic Plus" },
    status: "enabled",
    running: false,
    problems: [],
    commands: [],
  };
  const key = "dev:0123456789abcdef";
  const snapshot: PluginsSnapshot = {
    revision: 4,
    diagnosticHelpRevision: 2,
    staticLanguagesRevision: 0,
    staticLanguageOwners: [],
    safeMode: false,
    developmentMode: true,
    plugins: [
      {
        sourceKey: key,
        id: "acme.hello",
        source: "development",
        required: false,
        canToggle: true,
        runtime: "python",
        status: "enabled",
        running: true,
        problems: [],
        commands: [{ id: "acme.hello.greet", title: "Greet" }],
      },
    ],
  };
  const fixtureText = (name: "tokenizer" | "configuration") =>
    readFileSync(
      new URL(
        `../../../../../packages/plugin-protocol/test-fixtures/static-languages/minimal/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    );
  const tokenizerText = fixtureText("tokenizer");
  const configurationText = fixtureText("configuration");
  const language = (id: string, pluginId: string, sourceKey: string): ValidatedStaticLanguage => ({
    id,
    pluginId,
    sourceKey,
    generation: 1,
    extensions: [id],
    aliases: [],
    resourceDigest: "mock-resource-digest",
    tokenizer: JSON.parse(tokenizerText),
    configuration: JSON.parse(configurationText),
    resourceBytes: {
      tokenizer: Buffer.byteLength(tokenizerText, "utf8"),
      configuration: Buffer.byteLength(configurationText, "utf8"),
    },
    expandedRules: 1,
  });
  const toy = language("toy", "acme.toy", key);
  const bp = language("bp", builtin.id, builtin.sourceKey);
  const catalog = (
    revision = 1,
    languages: ValidatedStaticLanguage[] = [bp, toy],
  ): StaticLanguagesCatalog => ({
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages,
    extensionRoutes: Object.fromEntries(
      languages.flatMap((item) => item.extensions.map((extension) => [extension, item.id])),
    ),
    conflicts: [],
  });
  const owners = (value: StaticLanguagesCatalog): PluginsSnapshot["staticLanguageOwners"] =>
    value.languages.map(({ id, pluginId, sourceKey, generation, extensions }) => ({
      languageId: id,
      pluginId,
      sourceKey,
      generation,
      extensions: [...extensions],
    }));
  const staticSnapshot = (value: StaticLanguagesCatalog): PluginsSnapshot => ({
    ...snapshot,
    staticLanguagesRevision: value.revision,
    staticLanguageOwners: owners(value),
    plugins: [
      builtin,
      {
        sourceKey: key,
        id: "acme.toy",
        source: "development",
        required: false,
        canToggle: true,
        runtime: "static",
        status: "enabled",
        running: false,
        problems: [],
        commands: [],
      },
    ],
  });
  const report = (revision = 1): ReportLanguageRegistrationFailureInput => ({
    sourceKey: key,
    generation: 1,
    languageId: "toy",
    revision,
    reason: "monaco",
    detail: "The language configuration could not be installed.",
  });
  function setup(
    options: {
      document?: Partial<PluginStateDocument>;
      snapshot?: PluginsSnapshot;
      catalog?: StaticLanguagesCatalog;
      failUpdates?: boolean;
    } = {},
  ) {
    let listener: (event: PluginManagerEvent) => void = () => {};
    let currentSnapshot = options.snapshot ?? snapshot;
    let currentCatalog =
      options.catalog ?? emptyStaticLanguagesCatalog(currentSnapshot.staticLanguagesRevision);
    const publishCatalog = (
      value: StaticLanguagesCatalog,
      plugins: PluginsSnapshot["plugins"] = currentSnapshot.plugins,
    ) => {
      currentCatalog = value;
      currentSnapshot = {
        ...currentSnapshot,
        plugins,
        revision: currentSnapshot.revision + 1,
        staticLanguagesRevision: value.revision,
        staticLanguageOwners: owners(value),
      };
      listener({ type: "state", state: currentSnapshot });
    };
    const manager = {
      get staticLanguagesRevision() {
        return currentCatalog.revision;
      },
      staticLanguages: vi.fn(() => structuredClone(currentCatalog)),
      reportLanguageRegistrationFailure: vi.fn<
        PluginManagerPort["reportLanguageRegistrationFailure"]
      >(() => ({ accepted: false, revision: currentCatalog.revision })),
      setEnabled: vi.fn<PluginManagerPort["setEnabled"]>(async () => ({
        ok: true,
        state: currentSnapshot,
      })),
      reloadSource: vi.fn<PluginManagerPort["reloadSource"]>(async () => ({
        ok: true,
        state: currentSnapshot,
      })),
      active: false,
      thirdPartyActive: false,
      state: () => currentSnapshot,
      resolveLanguageService: vi.fn((language: string) => ({
        ok: false as const,
        reason: "missing" as const,
        language,
        conflicts: [],
      })),
      diagnosticHelp: vi.fn(() => ({
        revision: currentSnapshot.diagnosticHelpRevision,
        plugins: currentSnapshot.plugins.some(
          (plugin) => plugin.id === "acme.hello" && plugin.status === "enabled",
        )
          ? [{ source: "acme.hello", sourceKey: key, entries: [helpEntry] }]
          : [],
      })),
      addSource: vi.fn(async () => ({ ok: true })),
      removeSource: vi.fn(async (sourceKey: string) => {
        currentSnapshot = {
          ...currentSnapshot,
          plugins: currentSnapshot.plugins.filter((plugin) => plugin.sourceKey !== sourceKey),
        };
        return { ok: true };
      }),
      leaveSafeMode: vi.fn(async () => {
        currentSnapshot = { ...currentSnapshot, safeMode: false };
        return { ok: true };
      }),
      executeCommand: vi.fn(
        (_command: string, signal?: AbortSignal) =>
          new Promise((resolve) =>
            signal?.addEventListener("abort", () =>
              resolve({ ok: false, code: "PLUGIN_E_CANCELLED", message: "cancelled" }),
            ),
          ),
      ),
      onEvent: (next: (event: PluginManagerEvent) => void) => {
        listener = next;
        return () => {};
      },
    };
    const marker = {
      update: vi.fn(),
      finish: vi.fn(),
      markThirdPartyUiContributions: vi.fn(),
      markThirdPartyStaticContributions: vi.fn(),
    };
    let document: PluginStateDocument = {
      schemaVersion: 2,
      developerMode: true,
      sources: [],
      disabled: [],
      legacyDisabledIds: [],
      ...options.document,
    };
    const settings = {
      settings: () => document,
      update: vi.fn(async (change: (current: PluginStateDocument) => PluginStateDocument) => {
        if (options.failUpdates) throw new Error("Settings are read-only.");
        document = change(document);
      }),
    };
    const dialogs = fakeDialogs();
    const controller = new PluginController({
      manager: manager as unknown as PluginManagerPort,
      settings,
      dialogs,
      logs: new PluginLogs(),
      notices: new PluginNotices(),
      marker,
      probe: async () => usable,
      realpath: async (directory) => directory,
      locale: "en",
      platform: "linux",
      session: { directories: [], safeMode: false },
    });
    return {
      controller,
      manager,
      marker,
      publishCatalog,
      settings,
      dialogs,
      emit: (event: PluginManagerEvent) => {
        if (event.type === "state") currentSnapshot = event.state;
        listener(event);
      },
    };
  }

  it("forwards frontend-only language service selection", () => {
    const { controller, manager } = setup();
    expect(controller.resolveLanguageService("case")).toEqual({
      ok: false,
      reason: "missing",
      language: "case",
      conflicts: [],
    });
    expect(manager.resolveLanguageService).toHaveBeenCalledWith("case");
  });

  it("keys the help catalog by source and includes enabled plugins' names", () => {
    const { controller } = setup({
      snapshot: { ...snapshot, plugins: [...snapshot.plugins, builtin] },
    });
    expect(controller.diagnosticHelp()).toEqual({
      revision: 2,
      plugins: {
        "acme.hello": { entries: [helpEntry] },
        "kobrixa.basic-plus": {
          displayName: { en: "Basic Plus", "zh-TW": "Basic Plus" },
          entries: [],
        },
      },
    });
    expect(controller.diagnosticHelpEntry("acme.hello", "ACME1")).toEqual(helpEntry);
    expect(controller.diagnosticHelpEntry("acme.other", "ACME1")).toBeUndefined();
    expect(controller.diagnosticHelpEntry("kobrixa.basic-plus", "BP1015")).toBeUndefined();
  });

  it("caches the source-keyed catalog and entry lookups until the help revision changes", () => {
    const { controller, manager, emit } = setup();
    const first = controller.diagnosticHelp();
    expect(controller.diagnosticHelp()).toBe(first);
    expect(manager.diagnosticHelp).toHaveBeenCalledOnce();
    expect(controller.diagnosticHelpEntry("acme.hello", "ACME1", "missing")).toEqual(helpEntry);
    expect(controller.diagnosticHelpEntry("acme.other", "ACME1")).toBeUndefined();
    emit({ type: "state", state: { ...snapshot, revision: snapshot.revision + 1 } });
    expect(controller.diagnosticHelp()).toBe(first);
    expect(manager.diagnosticHelp).toHaveBeenCalledOnce();
    emit({ type: "state", state: { ...snapshot, diagnosticHelpRevision: 3, plugins: [builtin] } });
    expect(controller.diagnosticHelp()).toEqual({
      revision: 3,
      plugins: {
        "kobrixa.basic-plus": { displayName: builtin.displayName, entries: [] },
      },
    });
    expect(controller.diagnosticHelpEntry("acme.hello", "ACME1")).toBeUndefined();
    expect(manager.diagnosticHelp).toHaveBeenCalledTimes(2);
  });

  it("omits disabled plugins' names even when they have no help", () => {
    const { controller } = setup({
      snapshot: {
        ...snapshot,
        plugins: [{ ...builtin, status: "disabled" }],
      },
    });
    expect(controller.diagnosticHelp()).toEqual({ revision: 2, plugins: {} });
  });

  it("adds no plugin when saving a linked folder fails", async () => {
    const { controller, manager, settings, dialogs } = setup({
      snapshot: { ...snapshot, plugins: [] },
      failUpdates: true,
    });
    dialogs.chooseFolder.mockResolvedValueOnce(await pluginFolder("hello"));
    expect(await controller.linkFolder()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_STATE_SAVE",
      message: "Settings are read-only.",
    });
    expect(settings.update).toHaveBeenCalledOnce();
    expect(settings.settings().sources).toEqual([]);
    expect(manager.addSource).not.toHaveBeenCalled();
    expect(controller.state().plugins).toEqual([]);
  });

  it("keeps the safe-mode lock when saving its removal fails", async () => {
    const safeModeLock = { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" as const };
    const { controller, manager, settings } = setup({
      document: { safeModeLock },
      snapshot: { ...snapshot, safeMode: true },
      failUpdates: true,
    });
    expect(await controller.clearSafeModeLock()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_STATE_SAVE",
      message: "Settings are read-only.",
    });
    expect(settings.update).toHaveBeenCalledOnce();
    expect(settings.settings().safeModeLock).toEqual(safeModeLock);
    expect(controller.state()).toMatchObject({ safeMode: true, safeModeLock });
    expect(manager.leaveSafeMode).not.toHaveBeenCalled();
  });

  it("unlinks for this session with persisted false when saving fails", async () => {
    const directory = await pluginFolder("hello");
    const sourceKey = developmentSourceKey(directory);
    const { controller, manager, settings } = setup({
      document: { sources: [{ directory }] },
      snapshot: { ...snapshot, plugins: [{ ...snapshot.plugins[0]!, sourceKey }] },
      failUpdates: true,
    });
    expect(await controller.unlink(sourceKey)).toMatchObject({
      ok: true,
      persisted: false,
      state: { plugins: [] },
    });
    expect(settings.update).toHaveBeenCalledOnce();
    expect(manager.removeSource).toHaveBeenCalledWith(sourceKey);
    expect(settings.settings().sources).toEqual([{ directory }]);
    expect(controller.state().plugins).toEqual([]);
  });

  it("tracks in-flight commands per source and cancels only that source", async () => {
    const { controller } = setup();
    const events: PluginsViewEvent[] = [];
    controller.onEvent((event) => events.push(event));
    const running = controller.execute("acme.hello.greet");
    expect(controller.state().inflight).toEqual([key]);
    controller.cancel("dev:aaaaaaaaaaaaaaaa");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state().inflight).toEqual([key]);
    controller.cancel(key);
    expect(await running).toMatchObject({ ok: false, code: "PLUGIN_E_CANCELLED" });
    expect(controller.state().inflight).toEqual([]);
    expect(
      events.flatMap((event) => (event.type === "state" ? [event.state.revision] : [])),
    ).toEqual([5, 6]);
  });

  it("records third-party processes and renderer hangs in the session marker", () => {
    const { controller, manager, marker, emit } = setup();
    manager.active = true;
    manager.thirdPartyActive = true;
    emit({ type: "state", state: snapshot });
    expect(marker.update).toHaveBeenLastCalledWith({ thirdPartyRunning: true });
    controller.markRendererUnresponsive();
    expect(marker.update).toHaveBeenLastCalledWith({ rendererUnresponsive: true });
    controller.finishSession();
    expect(marker.finish).toHaveBeenCalledOnce();
  });

  it("stores notices with ids and forwards them", () => {
    const { controller, emit } = setup();
    const events: PluginsViewEvent[] = [];
    controller.onEvent((event) => events.push(event));
    const notice = {
      pluginId: "acme.hello",
      sourceKey: key,
      severity: "warning" as const,
      message: "careful",
      at: 1,
    };
    emit({ type: "notice", notice });
    emit({ type: "notice", notice: { ...notice, message: "again" } });
    expect(events).toEqual([
      { type: "notice", notice: { ...notice, id: 1 } },
      { type: "notice", notice: { ...notice, message: "again", id: 2 } },
    ]);
    expect(controller.notices().map((item) => item.id)).toEqual([2, 1]);
  });

  it("marks running Python plugins for reload after the interpreter changes", async () => {
    const { controller, emit } = setup();
    await controller.pythonCandidates();
    expect(await controller.setPython("python3")).toMatchObject({
      ok: true,
      state: { python: { pendingReload: [key] } },
    });
    emit({
      type: "state",
      state: { ...snapshot, plugins: [{ ...snapshot.plugins[0]!, running: false }] },
    });
    expect(controller.state().python.pendingReload).toEqual([]);
  });
  it.each(["fetch", "state", "event"] as const)(
    "persists risk before the first third-party %s delivery without a process",
    (entry) => {
      const value = catalog();
      const { controller, manager, marker, publishCatalog } = setup({
        catalog: value,
        snapshot: staticSnapshot(value),
      });
      const order: string[] = [];
      marker.markThirdPartyStaticContributions.mockImplementation(() => order.push("persist"));
      controller.onEvent((event) => {
        if (event.type === "state") {
          order.push("deliver");
          expect(event.state.staticLanguageOwners).toEqual(owners(value));
        }
      });
      if (entry === "fetch") {
        expect(controller.staticLanguages()).toEqual(value);
        order.push("deliver");
      } else if (entry === "state") {
        expect(controller.state().staticLanguageOwners).toEqual(owners(value));
        order.push("deliver");
      } else publishCatalog(value);
      expect(order).toEqual(["persist", "deliver"]);
      expect(manager.active).toBe(false);
      controller.staticLanguages();
      controller.state();
      expect(marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
    },
  );

  it("refuses post-startup static catalog delivery when marker persistence fails", async () => {
    const initial = catalog(1, [bp]);
    const { controller, manager, marker, publishCatalog } = setup({
      catalog: initial,
      snapshot: staticSnapshot(initial),
    });
    expect(controller.staticLanguages().languages).toEqual([bp]);
    expect(marker.markThirdPartyStaticContributions).not.toHaveBeenCalled();
    marker.markThirdPartyStaticContributions.mockImplementation(() => {
      throw new PluginError("PLUGIN_E_STATE_SAVE", "Marker storage is unavailable.");
    });
    const events: PluginsViewEvent[] = [];
    controller.onEvent((event) => events.push(event));
    manager.setEnabled.mockImplementation(async () => {
      publishCatalog(catalog(2));
      return { ok: true, state: manager.state() };
    });
    expect(await controller.setEnabled(key, true)).toMatchObject({
      ok: true,
      state: { stateProblem: { code: "PLUGIN_E_STATE_SAVE" } },
    });
    expect(controller.staticLanguages()).toMatchObject({
      revision: 2,
      languages: [bp],
      extensionRoutes: { bp: "bp" },
    });
    const state = controller.state();
    expect(state.staticLanguageOwners).toEqual(owners(catalog(2, [bp])));
    expect(state.plugins.find((item) => item.id === "acme.toy")?.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PLUGIN_E_STATE_SAVE" })]),
    );
    expect(() => controller.reportLanguageRegistrationFailure(report(2))).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
    for (const event of events)
      if (event.type === "state")
        expect(event.state.staticLanguageOwners.every((owner) => owner.sourceKey !== key)).toBe(
          true,
        );
    // A delivery failure is latched for this session: the same revision never changes
    // from a builtin-only DTO to a third-party DTO on a later poll.
    marker.markThirdPartyStaticContributions.mockImplementation(() => {});
    publishCatalog(catalog(3));
    expect(controller.staticLanguages().languages).toEqual([bp]);
    expect(marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
    expect(manager.resolveLanguageService).not.toHaveBeenCalled();
  });

  it("protects first-fetch failure and later reload delivery with the same gate", async () => {
    const value = catalog();
    const failed = setup({ catalog: value, snapshot: staticSnapshot(value) });
    failed.marker.markThirdPartyStaticContributions.mockImplementation(() => {
      throw new Error("read-only storage");
    });
    expect(failed.controller.staticLanguages().languages).toEqual([bp]);
    expect(failed.controller.state().stateProblem?.code).toBe("PLUGIN_E_STATE_SAVE");

    const initial = catalog(1, [bp]);
    const next = setup({ catalog: initial, snapshot: staticSnapshot(initial) });
    next.manager.reloadSource.mockImplementation(async () => {
      next.publishCatalog(catalog(2));
      return { ok: true, state: next.manager.state() };
    });
    expect(await next.controller.reload(key)).toMatchObject({ ok: true });
    expect(next.marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
    expect(next.controller.staticLanguages().languages).toEqual([bp, toy]);
  });

  it("retains builtin routes, ambiguity and static-only status without PID checks", () => {
    const value = catalog();
    value.languages[0] = { ...bp, extensions: ["bp", "shared"] };
    value.languages[1] = { ...toy, extensions: ["toy", "shared"] };
    value.extensionRoutes.shared = null;
    value.conflicts = [
      {
        kind: "extension",
        key: "shared",
        sources: owners(value).map(({ pluginId, sourceKey, languageId }) => ({
          pluginId,
          sourceKey,
          languageId,
        })),
      },
    ];
    const { controller, marker } = setup({
      catalog: value,
      snapshot: staticSnapshot(value),
    });
    expect(controller.staticLanguages()).toEqual(value);
    expect(controller.state().plugins.find((item) => item.id === "acme.toy")).toMatchObject({
      runtime: "static",
      status: "enabled",
      running: false,
    });
    expect(marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
  });

  it("does not expose third-party owners in safe mode even from an overpermissive mock", () => {
    const value = catalog();
    const { controller, manager, marker } = setup({
      catalog: value,
      snapshot: { ...staticSnapshot(value), safeMode: true },
    });
    expect(controller.staticLanguages().languages).toEqual([bp]);
    expect(controller.state().staticLanguageOwners).toEqual(owners(catalog(1, [bp])));
    expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
    expect(marker.markThirdPartyStaticContributions).not.toHaveBeenCalled();
  });

  it("retains hang detection after an exposed static source is removed", () => {
    const value = catalog();
    const { controller, marker, emit, publishCatalog } = setup({
      catalog: value,
      snapshot: staticSnapshot(value),
    });
    controller.staticLanguages();
    publishCatalog(catalog(2, [bp]));
    emit({ type: "state", state: { ...staticSnapshot(catalog(2, [bp])), plugins: [builtin] } });
    controller.markRendererUnresponsive();
    expect(marker.update).toHaveBeenLastCalledWith({ rendererUnresponsive: true });
  });

  it("rejects forged current ownership and ignores stale or duplicate registration reports", () => {
    const value = catalog();
    const { controller, manager, publishCatalog } = setup({
      catalog: value,
      snapshot: staticSnapshot(value),
    });
    for (const forged of [
      { ...report(), sourceKey: "dev:ffffffffffffffff" },
      { ...report(), languageId: "bp" },
      { ...report(), generation: 2 },
    ])
      expect(() => controller.reportLanguageRegistrationFailure(forged)).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
    expect(controller.reportLanguageRegistrationFailure(report(2))).toEqual({
      accepted: false,
      revision: 1,
    });
    manager.reportLanguageRegistrationFailure.mockImplementation(() => {
      publishCatalog(catalog(2, [bp]));
      return { accepted: true, revision: 2 };
    });
    expect(controller.reportLanguageRegistrationFailure(report(0))).toEqual({
      accepted: true,
      revision: 2,
    });
    expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(report(0));
    expect(controller.reportLanguageRegistrationFailure(report())).toEqual({
      accepted: false,
      revision: 2,
    });
    expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledOnce();
    expect(controller.staticLanguages().languages).toEqual([bp]);
  });

  it.each(["node", "python"] as const)(
    "accepts one registration failure for a current static owner after its %s process crashes",
    (runtime) => {
      const value = catalog();
      const initial = staticSnapshot(value);
      initial.plugins[1] = { ...initial.plugins[1]!, runtime, running: true };
      const { controller, manager, emit, publishCatalog } = setup({
        catalog: value,
        snapshot: initial,
      });
      manager.active = true;
      expect(controller.staticLanguages()).toEqual(value);
      const crashProblem: PluginsSnapshot["plugins"][number]["problems"][number] = {
        code: "PLUGIN_E_CRASHED",
        message: "acme.toy: plugin process exited unexpectedly.",
      };
      manager.active = false;
      emit({
        type: "state",
        state: {
          ...initial,
          revision: initial.revision + 1,
          plugins: initial.plugins.map((plugin) =>
            plugin.sourceKey === key
              ? { ...plugin, status: "failed", running: false, problems: [crashProblem] }
              : plugin,
          ),
        },
      });
      expect(controller.state().plugins.find((plugin) => plugin.sourceKey === key)).toMatchObject({
        runtime,
        status: "failed",
        running: false,
      });
      expect(controller.state().staticLanguageOwners).toEqual(owners(value));
      expect(controller.staticLanguages()).toEqual(value);

      const events: PluginsViewEvent[] = [];
      controller.onEvent((event) => events.push(event));
      const registrationProblem: PluginsSnapshot["plugins"][number]["problems"][number] = {
        code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
        message: `acme.toy / toy: renderer registration failed (monaco): ${report().detail}`,
        detail: { languageId: "toy" },
      };
      // Simulate a single host transaction: quarantine this contribution, append
      // its structured problem, advance the revision and publish complete owners.
      manager.reportLanguageRegistrationFailure.mockImplementation(() => {
        publishCatalog(
          catalog(2, [bp]),
          manager
            .state()
            .plugins.map((plugin) =>
              plugin.sourceKey === key
                ? { ...plugin, problems: [...plugin.problems, registrationProblem] }
                : plugin,
            ),
        );
        return { accepted: true, revision: 2 };
      });
      expect(controller.reportLanguageRegistrationFailure(report())).toEqual({
        accepted: true,
        revision: 2,
      });
      expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(report());
      expect(controller.staticLanguages()).toEqual(catalog(2, [bp]));
      expect(controller.state().staticLanguagesRevision).toBe(2);
      expect(controller.state().staticLanguageOwners).toEqual(owners(catalog(2, [bp])));
      expect(controller.state().plugins.find((plugin) => plugin.sourceKey === key)).toMatchObject({
        status: "failed",
        running: false,
        problems: [crashProblem, registrationProblem],
      });
      expect(events).toEqual([{ type: "state", state: controller.state() }]);
      // Exact duplicates and older revisions are ignored. Rewriting the revision
      // cannot authorize an owner that the host has already quarantined.
      for (const stale of [report(), report(0)])
        expect(controller.reportLanguageRegistrationFailure(stale)).toEqual({
          accepted: false,
          revision: 2,
        });
      expect(() => controller.reportLanguageRegistrationFailure(report(2))).toThrow("owner");
      publishCatalog(catalog(3, [bp]));
      expect(controller.staticLanguages()).toEqual(catalog(3, [bp]));
      expect(() => controller.reportLanguageRegistrationFailure(report(3))).toThrow("owner");
      expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledOnce();
      expect(manager.setEnabled).not.toHaveBeenCalled();
      expect(manager.reloadSource).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "invalid"] as const)(
    "rejects reports from a %s plugin even if a mock retains its catalog and owner",
    (status) => {
      const value = catalog();
      const inactive = staticSnapshot(value);
      inactive.plugins[1] = { ...inactive.plugins[1]!, status };
      const { controller, manager } = setup({ catalog: value, snapshot: inactive });
      expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
      expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["catalog", "owner", "plugin"] as const)(
    "rejects a failed-process report after its %s identity is withdrawn",
    (withdrawn) => {
      const value = catalog();
      const inactive = staticSnapshot(value);
      inactive.plugins[1] = { ...inactive.plugins[1]!, runtime: "node", status: "failed" };
      if (withdrawn === "owner") inactive.staticLanguageOwners = owners(catalog(1, [bp]));
      if (withdrawn === "plugin") inactive.plugins = [builtin];
      const { controller, manager } = setup({
        catalog: withdrawn === "catalog" ? catalog(1, [bp]) : value,
        snapshot: inactive,
      });
      expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
      expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "plugin"] as const)(
    "does not borrow another %s identity from a matching source and language",
    (mismatch) => {
      const value = catalog();
      const inconsistent = staticSnapshot(value);
      if (mismatch === "owner")
        inconsistent.staticLanguageOwners[1] = {
          ...inconsistent.staticLanguageOwners[1]!,
          pluginId: "acme.forged",
        };
      else inconsistent.plugins[1] = { ...inconsistent.plugins[1]!, id: "acme.forged" };
      const { controller, manager } = setup({ catalog: value, snapshot: inconsistent });
      expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
      expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
    },
  );
  function captureStartup(manager: ReturnType<typeof setup>["manager"]) {
    const creates: PluginManagerOptions[] = [];
    const persisted: (PluginPersistedState & { problem?: string })[] = [];
    vi.spyOn(PluginManager, "create").mockImplementation(async (options) => {
      creates.push(options);
      persisted.push(await options.store.load());
      return manager as unknown as PluginManager;
    });
    return { creates, persisted };
  }

  it.each(["cli", "lock", "corrupt", "static-crash", "hang"] as const)(
    "decides %s safe mode before resolving any development folder",
    async (condition) => {
      const directory = path.join(root, "must-not-be-read");
      const sourceKey = developmentSourceKey(directory);
      const document: PluginStateDocument = {
        schemaVersion: 2,
        developerMode: true,
        sources: [{ directory }],
        disabled: [sourceKey],
        legacyDisabledIds: ["acme.old"],
        ...(condition === "lock"
          ? {
              safeModeLock: {
                since: "2026-10-15T00:00:00.000Z",
                reason: "unclean-exit" as const,
              },
            }
          : {}),
      };
      await mkdir(path.join(userData, "plugins"), { recursive: true });
      await writeFile(
        path.join(userData, "plugins/state.json"),
        condition === "corrupt" ? "{broken" : JSON.stringify(document),
      );
      if (condition === "static-crash" || condition === "hang")
        await writeFile(
          path.join(userData, "plugins/session.json"),
          JSON.stringify({
            startedAt: "2026-10-15T00:00:00.000Z",
            thirdPartyRunning: false,
            thirdPartyStaticContributions: true,
            rendererUnresponsive: condition === "hang",
          }),
        );
      const { manager } = setup({ snapshot: { ...snapshot, safeMode: true } });
      const captured = captureStartup(manager);
      const resolve = vi.fn(async () => {
        throw new Error("Safe mode must not touch a development directory.");
      });
      const launcher = vi.fn();
      const controller = await start(fakeDialogs(), {
        commandLine: { developmentDirectories: [directory], safeMode: condition === "cli" },
        realpath: resolve,
        launcher: () => launcher,
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(launcher).not.toHaveBeenCalled();
      expect(captured.creates).toHaveLength(1);
      expect(captured.creates[0]!.safeMode).toBe(true);
      // The runtime receives inert source descriptors for the recovery UI and owns
      // proving that safeMode prevents manifest and resource reads of those descriptors.
      expect(captured.creates[0]!.sources).toEqual([{ kind: "development", directory }]);
      if (condition === "corrupt") expect(captured.persisted[0]!.problem).toBeDefined();
      else {
        expect([...captured.persisted[0]!.disabled]).toEqual([sourceKey]);
        expect([...captured.persisted[0]!.legacyDisabledIds]).toEqual(["acme.old"]);
      }
      if (condition === "static-crash" || condition === "hang") {
        const reason = condition === "hang" ? "renderer-unresponsive" : "unclean-exit";
        expect(controller.state().safeModeLock?.reason).toBe(reason);
        expect((await saved()).safeModeLock.reason).toBe(reason);
      }
    },
  );

  it("retains static crash recovery after the last development source was removed", async () => {
    await mkdir(path.join(userData, "plugins"), { recursive: true });
    await writeFile(
      path.join(userData, "plugins/session.json"),
      JSON.stringify({
        startedAt: "2026-10-15T00:00:00.000Z",
        thirdPartyRunning: false,
        thirdPartyStaticContributions: true,
        rendererUnresponsive: false,
      }),
    );
    const { manager } = setup({ snapshot: { ...snapshot, safeMode: true, plugins: [] } });
    const captured = captureStartup(manager);
    const controller = await start();
    expect(captured.creates[0]!.safeMode).toBe(true);
    expect(captured.creates[0]!.sources).toEqual([]);
    expect(controller.state().safeModeLock?.reason).toBe("unclean-exit");
    expect((await saved()).safeModeLock.reason).toBe("unclean-exit");
  });

  it("gives a renderer hang priority over an older unclean-exit lock", async () => {
    const directory = path.join(root, "static-source");
    const document: PluginStateDocument = {
      schemaVersion: 2,
      developerMode: true,
      sources: [{ directory }],
      disabled: [],
      legacyDisabledIds: [],
      safeModeLock: { since: "2026-10-14T00:00:00.000Z", reason: "unclean-exit" },
    };
    await mkdir(path.join(userData, "plugins"), { recursive: true });
    await writeFile(path.join(userData, "plugins/state.json"), JSON.stringify(document));
    await writeFile(
      path.join(userData, "plugins/session.json"),
      JSON.stringify({
        startedAt: "2026-10-15T00:00:00.000Z",
        thirdPartyRunning: false,
        thirdPartyStaticContributions: true,
        rendererUnresponsive: true,
      }),
    );
    const { manager } = setup({ snapshot: { ...snapshot, safeMode: true } });
    captureStartup(manager);
    const controller = await start();
    expect(controller.state().safeModeLock?.reason).toBe("renderer-unresponsive");
    expect((await saved()).safeModeLock.reason).toBe("renderer-unresponsive");
  });

  it("preserves individual disables when the user explicitly leaves recovery mode", async () => {
    const directory = path.join(root, "disabled-static-source");
    const sourceKey = developmentSourceKey(directory);
    const document: PluginStateDocument = {
      schemaVersion: 2,
      developerMode: true,
      sources: [{ directory }],
      disabled: [sourceKey],
      legacyDisabledIds: ["acme.old"],
      safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
    };
    await mkdir(path.join(userData, "plugins"), { recursive: true });
    await writeFile(path.join(userData, "plugins/state.json"), JSON.stringify(document));
    const { manager } = setup({ snapshot: { ...snapshot, safeMode: true } });
    captureStartup(manager);
    const controller = await start();
    expect(manager.leaveSafeMode).not.toHaveBeenCalled();
    expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
    expect(manager.leaveSafeMode).toHaveBeenCalledOnce();
    expect(await saved()).toMatchObject({
      disabled: [sourceKey],
      legacyDisabledIds: ["acme.old"],
    });
    expect((await saved()).safeModeLock).toBeUndefined();
  });

  it("still canonicalizes command-line folders outside safe mode after loading disables", async () => {
    const directory = path.join(root, "spelling");
    const canonical = path.join(root, "canonical");
    const sourceKey = developmentSourceKey(canonical);
    await mkdir(path.join(userData, "plugins"), { recursive: true });
    await writeFile(
      path.join(userData, "plugins/state.json"),
      JSON.stringify({
        schemaVersion: 2,
        developerMode: false,
        sources: [],
        disabled: [sourceKey],
        legacyDisabledIds: [],
      }),
    );
    const { manager } = setup();
    const captured = captureStartup(manager);
    const resolve = vi.fn(async () => canonical);
    await start(fakeDialogs(), {
      commandLine: { developmentDirectories: [directory], safeMode: false },
      realpath: resolve,
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(directory);
    expect(captured.creates[0]!.safeMode).toBe(false);
    expect(captured.creates[0]!.sources).toEqual([{ kind: "development", directory: canonical }]);
    expect([...captured.persisted[0]!.disabled]).toEqual([sourceKey]);
  });
});

import { composeDesktopMain, desktopLifecycle, desktopUi } from "./controller.js";
import { createDesktopFoundation } from "../device-broker/lifecycle-coordinator.js";
import type { DesktopMainCompositionInput } from "../device-broker/lifecycle-coordinator.js";
import { createJournal } from "../device-broker/journal.js";
import { createJournalFilesystem } from "../device-broker/journal-filesystem.js";
import { AuthorityContexts } from "../device-broker/authority-context.js";
import { createCoreActionLedger } from "./core-recovery.js";
import { createFakeDeviceProvider } from "../device-broker/fake-provider.js";
import { startPrimary } from "./profile-writer-lock.js";
import { randomUUID, createHash } from "node:crypto";

async function compositionInput() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-composition-")));
  vi.spyOn(worker170, "startPersistenceWorker").mockImplementation((args) =>
    realWorker170({ ...args, workerEntry: testWorkerEntry170 }),
  );
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const now = () => performance.now();
  const scope = { hostEpoch: profile.hostEpoch, workbenchInstance: randomUUID() };
  const foundationOptions = {
    profile,
    now,
    authority: new AuthorityContexts(profile.hostEpoch),
    journal: createJournal(createJournalFilesystem(root), profile),
    coreActions: createCoreActionLedger({
      now,
      current: (candidate) =>
        candidate.hostEpoch === scope.hostEpoch &&
        candidate.workbenchInstance === scope.workbenchInstance,
    }),
    hasPermission: () => false,
    requirements: () => null,
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 10000 as const,
      wifiHandshakeTimeoutMs: 5000 as const,
      usbAutoReconnect: false,
      usbRetryInterval: 2000 as const,
      usbRetryLimit: 3 as const,
    }),
    operationGate: () => ({ ok: true as const, value: null }),
  };
  const factory = vi.fn<typeof createDesktopFoundation>((options) =>
    createDesktopFoundation({
      ...options,
      providerFactory: (catalog) => createFakeDeviceProvider({ catalog, now }).provider,
    }),
  );
  const input: DesktopMainCompositionInput = {
    createFoundation: factory,
    foundationOptions,
    plugins: {
      userData: root,
      builtins: BUILTIN_PLUGIN_SOURCES,
      commandLine: { developmentDirectories: [], safeMode: false },
      locale: "en",
      dialogs: {
        confirmDeveloperMode: async () => false,
        chooseFolder: async () => undefined,
        confirmLink: async () => false,
        confirmUnlink: async () => false,
        choosePython: async () => undefined,
      },
      launcher: () => async () => {
        throw new Error("No provider process");
      },
    },
    principal: (owner) => ({ kind: "plugin", owner, authorityContext: null }),
    scope: () => scope,
    currentScope: (candidate) =>
      candidate.hostEpoch === scope.hostEpoch &&
      candidate.workbenchInstance === scope.workbenchInstance,
    legacyFlush: async () => {},
    report: vi.fn(),
  };
  return { input, factory, cleanup: () => rm(root, { recursive: true, force: true }) };
}
it("composition retires UI intent on real authority changes and detaches on disposal", async () => {
  const f = await compositionInput();
  const authority = f.input.foundationOptions.authority as AuthorityContexts;
  const document = authority.open(17);
  const ref = authority.core(17, "recovery").authorityContext!.ref;
  const report = {
    document,
    sequence: 1,
    state: "local",
    roomId: null,
    connected: true,
    synced: true,
    role: null,
    isHolder: true,
  };
  const composition = await composeDesktopMain(f.input);
  try {
    const revoked = vi.spyOn(desktopUi(composition).intent, "authorityChanged");
    authority.report(17, report);
    expect(revoked).toHaveBeenCalledExactlyOnceWith(ref);
    await composition.dispose();
    revoked.mockClear();
    authority.report(17, {
      ...report,
      sequence: 2,
      state: "room",
      roomId: "room",
      role: "viewer",
      isHolder: false,
    });
    expect(revoked).not.toHaveBeenCalled();
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it("BM-18 creates one foundation and forwards the exact host/runtime pair", async () => {
  const f = await compositionInput();
  const create = vi.spyOn(PluginManager, "create");
  try {
    const composition = await composeDesktopMain(f.input);
    expect(f.factory).toHaveBeenCalledExactlyOnceWith(f.input.foundationOptions);
    expect(create).toHaveBeenCalledOnce();
    const options = create.mock.calls[0]![0];
    expect(options.stage3).toBe(composition.stage3);
    expect(options.stage3Host).toBe(composition.stage3Host);
    expect(composition.stage3.device).toBe(composition.foundation.broker.resources);
    expect(composition.stage3Host.principal).toBe(f.input.principal);
    expect(desktopLifecycle(composition)).toBe(desktopLifecycle(composition));
    expect(
      composition.stage3Host.requirements({
        sourceKey: "retired",
        pluginId: "test.retired",
        generation: 1,
        hostEpoch: f.input.foundationOptions.profile.hostEpoch,
        processEpoch: randomUUID(),
      }),
    ).toBeNull();
    await composition.dispose();
    await composition.dispose();
  } finally {
    create.mockRestore();
    await f.cleanup();
  }
});
it.each(
  (["prepareUpdate", "prepareWindowClose"] as const).flatMap((method) => [
    { method, failSave: false },
    { method, failSave: true },
  ]),
)(
  "$method (failed save=$failSave) waits for actual exit before readmission",
  async ({ method, failSave }) => {
    const { memoryPlugin } =
      await import("../../../../../packages/plugin-runtime/src/test-process.js");
    const f = await compositionInput();
    if (failSave)
      f.input.legacyFlush = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error("legacy save failed"));
    const directory = await pluginFolder("update-consumer");
    f.input.plugins.commandLine.developmentDirectories = [directory];
    const pluginRef: { current?: PluginController } = {};
    let launches = 0,
      exitRequested = false;
    let exit = () => {};
    f.input.foundationOptions.requirements = (owner) =>
      pluginRef.current ? desktopDeviceAccess(pluginRef.current).requirements(owner) : null;
    f.input.plugins.launcher = () => async () => {
      const first = ++launches === 1;
      return memoryPlugin((remote, control) => {
        if (first) exit = () => control.exit();
        remote.handle("initialize", () => ({
          apiVersion: "1.6.0",
          sdk: { name: "test", version: "1" },
        }));
        remote.handle("command/execute", () => null);
        remote.handle("shutdown", () => null);
        remote.onNotification("exit", () => {
          if (first) exitRequested = true;
          else control.exit();
        });
      }).process;
    };
    const composition = await composeDesktopMain(f.input);
    const plugins = composition.plugins;
    pluginRef.current = plugins;
    const shutdown = vi.spyOn(composition.foundation.broker.resources, "beginShutdown");
    try {
      expect(await plugins.execute("acme.update-consumer.greet")).toMatchObject({ ok: true });
      let finished = false;
      const preparing = desktopUi(composition)
        [method]()
        .finally(() => {
          finished = true;
        });
      const checked = failSave
        ? expect(preparing).rejects.toThrow("legacy save failed")
        : preparing;
      expect(await plugins.execute("acme.update-consumer.greet")).toMatchObject({
        ok: false,
        code: "PLUGIN_E_SHUTTING_DOWN",
      });
      await vi.waitFor(() => expect(exitRequested).toBe(true));
      expect(finished).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
      exit();
      await checked;
      expect(desktopLifecycle(composition).reports()[0]).toMatchObject({
        processStopped: true,
        blocker: false,
      });
      await plugins.resume();
      expect(launches).toBe(1);
      expect(await plugins.execute("acme.update-consumer.greet")).toMatchObject({ ok: true });
      expect(launches).toBe(2);
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      f.input.legacyFlush = async () => {};
      exit();
      await composition.dispose();
      await f.cleanup();
    }
  },
);
it("BM-18 secondary never calls the foundation or manager factories", async () => {
  const f = await compositionInput();
  const create = vi.spyOn(PluginManager, "create");
  try {
    const primary = startPrimary(
      {
        requestSingleInstanceLock: () => false,
        hasSingleInstanceLock: () => false,
        whenReady: async () => {},
        quit() {},
        on() {},
      },
      async () => {
        await composeDesktopMain(f.input);
      },
      () => false,
    );
    expect(primary).toBeNull();
    await Promise.resolve();
    expect(f.factory).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    await f.cleanup();
  }
});
it("BM-18 callback failure shuts down the manager and disposes the foundation", async () => {
  const f = await compositionInput();
  const original = PluginManager.create.bind(PluginManager);
  let shutdown: ReturnType<typeof vi.spyOn> | undefined;
  const create = vi.spyOn(PluginManager, "create").mockImplementation(async (options) => {
    const manager = await original(options);
    shutdown = vi.spyOn(manager, "shutdown");
    return manager;
  });
  let dispose: ReturnType<typeof vi.spyOn> | undefined;
  f.factory.mockImplementation(async (options) => {
    const foundation = await createDesktopFoundation(options);
    dispose = vi.spyOn(foundation, "dispose");
    foundation.attachProvider = () => {
      throw new Error("attachment failed");
    };
    return foundation;
  });
  try {
    await expect(composeDesktopMain(f.input)).rejects.toThrow("attachment failed");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    create.mockRestore();
    await f.cleanup();
  }
});
it("BM-18 importing controller does not invoke shared production startup", async () => {
  vi.resetModules();
  const runtime = await import("@kobrixa/plugin-runtime");
  const create = vi.spyOn(runtime.PluginManager, "create");
  try {
    await import("./controller.js");
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
  }
});

it("D150 optional builtin toggles and reloads without developer mode and survives restart", async () => {
  let controller = await start(undefined, { builtins: BUILTIN_PLUGIN_SOURCES });
  const optional = "builtin:kobrixa.device-ev3";
  expect(controller.state().developer.enabled).toBe(false);
  expect(await controller.setEnabled(optional, false)).toMatchObject({ ok: true });
  controller.finishSession();
  controller = await start(undefined, { builtins: BUILTIN_PLUGIN_SOURCES });
  expect(controller.state().plugins.find((row) => row.sourceKey === optional)?.status).toBe(
    "disabled",
  );
  expect(await controller.setEnabled(optional, true)).toMatchObject({ ok: true });
  expect(await controller.reload(optional)).toMatchObject({ ok: true });
  expect(await controller.setEnabled("builtin:kobrixa.basic-plus", false)).toMatchObject({
    ok: false,
  });
  expect(await controller.reload("builtin:kobrixa.basic-plus")).toMatchObject({ ok: false });
  await controller.shutdown();
  controller.finishSession();
});
it("D150 refuses either half of the stage3 pair before creating a manager", async () => {
  const create = vi.spyOn(PluginManager, "create");
  for (const options of [
    { stage3: {} as NonNullable<StartPluginsOptions["stage3"]> },
    { stage3Host: {} as NonNullable<StartPluginsOptions["stage3Host"]> },
  ])
    await expect(start(undefined, options)).rejects.toThrow("together");
  expect(create).not.toHaveBeenCalled();
});

it("D150 actual channel uses admitted generation requirements and launch permissions", async () => {
  const { memoryPlugin } =
    await import("../../../../../packages/plugin-runtime/src/test-process.js");
  const f = await compositionInput();
  const directory = await pluginFolder("consumer");
  const manifest = path.join(directory, "kobrixa-plugin.json");
  const value = JSON.parse(await readFile(manifest, "utf8"));
  value.permissions = ["devices.read"];
  value.requires = { devices: [{ capability: "telemetry.v1", required: false }] };
  await writeFile(manifest, JSON.stringify(value));
  f.input.plugins.commandLine.developmentDirectories = [directory];
  let controller: PluginController | undefined;
  let channelOwner: ImportedResourceOwner | undefined;
  let peer!: ImportedRpcPeer;
  f.input.plugins.launcher = () => async (plugin) => {
    channelOwner = plugin.channelOwner;
    return memoryPlugin((remote, control) => {
      peer = remote;
      remote.handle("initialize", () => ({
        apiVersion: "1.5.0",
        sdk: { name: "test", version: "1" },
      }));
      remote.handle("command/execute", () => null);
      remote.handle("shutdown", () => null);
      remote.onNotification("exit", () => control.exit());
    }).process;
  };
  f.input.foundationOptions.requirements = (owner) =>
    controller ? desktopDeviceAccess(controller).requirements(owner) : null;
  f.input.foundationOptions.hasPermission = (principal, permission) =>
    !!controller &&
    principal.kind === "plugin" &&
    desktopDeviceAccess(controller).hasPermission(principal.owner, permission);
  try {
    const composition = await composeDesktopMain(f.input);
    controller = composition.plugins;
    expect(await controller.execute("acme.consumer.greet")).toMatchObject({ ok: true });
    expect(channelOwner).toBeDefined();
    expect(desktopDeviceAccess(controller).requirements(channelOwner!)).toEqual(
      value.requires.devices,
    );
    expect(desktopDeviceAccess(controller).hasPermission(channelOwner!, "devices.read")).toBe(true);
    expect(desktopDeviceAccess(controller).hasPermission(channelOwner!, "devices.control")).toBe(
      false,
    );
    const negotiated = await peer.request("devices/negotiate", {});
    expect(negotiated.ok).toBe(true);
    await controller.setEnabled(channelOwner!.sourceKey, false);
    expect(desktopDeviceAccess(controller).requirements(channelOwner!)).toBeNull();
    expect(desktopDeviceAccess(controller).hasPermission(channelOwner!, "devices.read")).toBe(
      false,
    );
    await composition.dispose();
  } finally {
    await f.cleanup();
  }
});

import { createWindowRetirementHandler } from "./controller.js";
it.each([false, true])(
  "D150 native retirement destroyed=%s fences the old channel before invalidation and awaits disposition",
  async (destroyed) => {
    const { memoryPlugin } =
      await import("../../../../../packages/plugin-runtime/src/test-process.js");
    const f = await compositionInput();
    const directory = await pluginFolder("window");
    const authority = f.input.foundationOptions.authority as AuthorityContexts;
    const document = authority.open(7);
    authority.report(7, {
      document,
      sequence: 1,
      state: "local",
      roomId: null,
      connected: true,
      synced: true,
      role: null,
      isHolder: true,
    });
    const core = authority.core(7, "recovery");
    const scope = { hostEpoch: core.hostEpoch, workbenchInstance: core.workbenchInstance };
    const ledger = createCoreActionLedger({
      now: f.input.foundationOptions.now,
      current: (value) => value.workbenchInstance === scope.workbenchInstance,
    });
    f.input.foundationOptions.coreActions = ledger;
    f.input.plugins.commandLine.developmentDirectories = [directory];
    f.input.principal = (owner) => authority.plugin(7, owner);
    const controllerRef: { current?: PluginController } = {};
    let owner!: ImportedResourceOwner;
    const commands = vi.fn(() => null),
      shutdown = vi.fn(() => null);
    const launch = vi.fn(async (plugin: LaunchablePlugin) => {
      owner = plugin.channelOwner!;
      return memoryPlugin((remote, control) => {
        remote.handle("initialize", () => ({
          apiVersion: "1.5.0",
          sdk: { name: "test", version: "1" },
        }));
        remote.handle("command/execute", commands);
        remote.handle("shutdown", shutdown);
        remote.onNotification("exit", () => control.exit());
      }).process;
    });
    f.input.plugins.launcher = () => launch;
    f.input.foundationOptions.requirements = (candidate) =>
      controllerRef.current
        ? desktopDeviceAccess(controllerRef.current).requirements(candidate)
        : null;
    const composition = await composeDesktopMain(f.input);
    const controller = composition.plugins;
    controllerRef.current = controller;
    try {
      expect(await controller.execute("acme.window.greet")).toMatchObject({ ok: true });
      const oldOwner = owner;
      const target = { kind: "device-current-stop" as const, sessionId: randomUUID() };
      const action = ledger.mint(scope, target);
      const claimed = ledger.mint(scope, target);
      expect(ledger.claim(claimed, target)).toBe(true);
      let finish!: () => void;
      const disposition = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const resources = composition.foundation.broker.resources;
      const original = resources.retire.bind(resources);
      const retire = vi.spyOn(resources, "retire").mockImplementation((candidate, reason) => {
        expect(candidate).toEqual(oldOwner);
        expect(
          authority.current(f.input.principal(candidate), core.authorityContext!.ref),
        ).not.toBeNull();
        const result = original(candidate, reason);
        return { ...result, settled: disposition.then(() => result.settled) };
      });
      const ledgerRetire = vi.spyOn(ledger, "retire");
      const invalidate = vi.fn(() => {
        expect(ledgerRetire).toHaveBeenCalledExactlyOnceWith(scope);
        expect(retire).toHaveBeenCalledExactlyOnceWith(oldOwner, "renderer-lost");
        authority.invalidate(7);
      });
      const pause = vi.fn(async () => {});
      const handler = createWindowRetirementHandler({
        composition,
        coreActions: ledger,
        scope: () => scope,
        invalidate,
        flush: async () => {},
        pause,
      });
      const pending = handler(destroyed);
      expect(invalidate).toHaveBeenCalledOnce();
      expect(ledger.claim(action, target)).toBe(false);
      expect(ledger.isClaimed(claimed, target)).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledOnce();
      expect(commands).toHaveBeenCalledOnce();
      finish();
      await pending;
      expect(shutdown).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledOnce();
      expect(desktopDeviceAccess(controller).requirements(oldOwner)).toBeNull();
      expect(launch).toHaveBeenCalledOnce();
      expect(commands).toHaveBeenCalledOnce();
      const replacement = authority.open(7);
      expect(replacement).not.toBe(document);
      expect(authority.core(7, "recovery").workbenchInstance).not.toBe(scope.workbenchInstance);
    } finally {
      await composition.dispose();
      await f.cleanup();
    }
  },
);
it.each([false, true])(
  "D160 actual controller hang with development risk=%s preserves disabled optional source",
  async (risk) => {
    const optional = "builtin:kobrixa.device-ev3";
    const directories = risk ? [await pluginFolder("risk")] : [];
    const options = {
      builtins: BUILTIN_PLUGIN_SOURCES,
      commandLine: { developmentDirectories: directories, safeMode: false },
    };
    const crashed = await start(undefined, options);
    expect(await crashed.setEnabled(optional, false)).toMatchObject({ ok: true });
    crashed.markRendererUnresponsive();
    const recovered = await start(undefined, options);
    expect(recovered.state().plugins.find((row) => row.sourceKey === optional)?.status).toBe(
      "disabled",
    );
    expect(recovered.state().safeMode).toBe(true);
    expect(await recovered.setEnabled(optional, true)).toMatchObject({ ok: false });
    await recovered.shutdown();
    recovered.finishSession();
  },
);

it("a prior renderer-unresponsive marker locks recovery even without development sources", async () => {
  await mkdir(path.join(userData, "plugins"), { recursive: true });
  await writeFile(
    path.join(userData, "plugins/session.json"),
    JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      thirdPartyRunning: false,
      thirdPartyStaticContributions: false,
      thirdPartyUiContributions: false,
      rendererUnresponsive: true,
    }),
  );
  const controller = await start();
  expect(controller.state().safeMode).toBe(true);
});
it("a sticky third-party UI marker locks recovery after linked folders have been removed", async () => {
  await mkdir(path.join(userData, "plugins"), { recursive: true });
  await writeFile(
    path.join(userData, "plugins/session.json"),
    JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      thirdPartyRunning: false,
      thirdPartyStaticContributions: false,
      thirdPartyUiContributions: true,
      rendererUnresponsive: false,
    }),
  );
  const controller = await start();
  expect(controller.state().safeMode).toBe(true);
});

// Hoisted partial mock preserves the real factory for the other composition cases.
vi.mock("../device-broker/lifecycle-coordinator.js", async (orig) => {
  const actual = await orig<typeof LifecycleModule>();
  return { ...actual, createDesktopFoundation: vi.fn(actual.createDesktopFoundation) };
});
it("BM-18 D160 uses one injected factory/provider and one UI registry", async () => {
  const f = await compositionInput();
  f.input.foundationOptions.requirements = () => [];
  let providers = 0;
  let attached = 0;
  f.factory.mockImplementation(async (options) => {
    const foundation = await createDesktopFoundation({
      ...options,
      providerFactory: (catalog) => {
        providers++;
        return createFakeDeviceProvider({ catalog, now: options.now }).provider;
      },
    });
    const attach = foundation.attachProvider.bind(foundation);
    foundation.attachProvider = (manager) => {
      attached++;
      attach(manager);
    };
    return foundation;
  });
  try {
    const composition = await composeDesktopMain(f.input);
    expect(f.factory).toHaveBeenCalledExactlyOnceWith(f.input.foundationOptions);
    expect(providers).toBe(1);
    expect(attached).toBe(1);
    const ui = desktopUi(composition);
    expect(desktopUi(composition)).toBe(ui);
    expect(ui.coordinator).toBe(desktopUi(composition).coordinator);
    const [a, b] = createMemoryChannelPair();
    const peer = new RpcPeer(a),
      child = new RpcPeer(b);
    const owner = {
      sourceKey: "dev:test",
      pluginId: "test.ui",
      generation: 1,
      hostEpoch: f.input.foundationOptions.profile.hostEpoch,
      processEpoch: randomUUID(),
    };
    const attach = vi.spyOn(composition.foundation.broker, "attachChannel");
    const handlers = vi.spyOn(peer, "handle");
    const channel = composition.stage3Host.bindChannel({
      peer,
      owner,
      requirements: [],
      principal: () => f.input.principal(owner),
    });
    expect(attach).toHaveBeenCalledOnce();
    const names = handlers.mock.calls.map((call) => call[0]);
    for (const method of [
      "events/ack",
      "events/unsubscribe",
      "ui/instances",
      "ui/state",
      "ui/patch",
      "ui/snapshot",
      "ui/subscribe",
    ])
      expect(names.filter((name) => name === method)).toHaveLength(1);
    channel.dispose();
    channel.dispose();
    peer.close();
    child.close();
    await composition.dispose();
  } finally {
    await f.cleanup();
  }
});
it("common queue overflow withdraws UI intent before notifying the consumer", async () => {
  const f = await compositionInput();
  f.input.foundationOptions.requirements = () => [];
  const composition = await composeDesktopMain(f.input);
  const [a, b] = createMemoryChannelPair();
  const peer = new RpcPeer(a),
    child = new RpcPeer(b);
  const owner = {
    sourceKey: "dev:0000000000000001",
    pluginId: "test.overflow",
    generation: 1,
    hostEpoch: f.input.foundationOptions.profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  const ui = desktopUi(composition);
  const binding = {
    ...owner,
    contributionId: "test.overflow.panel",
    panelInstance: randomUUID(),
    kind: "panel" as const,
    uiResourceGeneration: 1,
  };
  const attach = vi.spyOn(composition.foundation.broker, "attachChannel");
  const channel = composition.stage3Host.bindChannel({
    peer,
    owner,
    requirements: [],
    principal: () => f.input.principal(owner),
  });
  try {
    const attachment = attach.mock.results[0]!.value;
    attachment.negotiated("ui", 1);
    const off = ui.bridge.onEvent((event) => {
      if (event.type === "pulse") ui.intent.pulse(event.binding, event.challenge, null, null);
    });
    ui.intent.bind(binding, {
      owner,
      contextRef: randomUUID(),
      panelInstance: binding.panelInstance,
      uiResourceGeneration: 1,
      workbenchInstance: f.input.scope().workbenchInstance,
    });
    expect(ui.intent.scope(binding)).toBeDefined();
    expect(ui.intent.timerCount()).toBe(2);
    const seen: Array<{ kind: string; scope: string | undefined; timers: number }> = [];
    const notify = peer.notify.bind(peer);
    vi.spyOn(peer, "notify").mockImplementation((method, params) => {
      if (method === "events/deliver")
        seen.push({
          kind: (params as { kind: string }).kind,
          scope: ui.intent.scope(binding),
          timers: ui.intent.timerCount(),
        });
      return notify(method, params);
    });
    const ledger = composition.foundation.broker.events;
    const subscription = ledger.create(owner);
    if (!subscription.ok) throw new Error("subscription failed");
    attachment.activate(subscription.value.subscriptionId);
    for (let i = 0; i < 8; i++)
      ledger.publish(
        owner,
        subscription.value.subscriptionId,
        { kind: "ui.environment", data: { locale: "en", theme: "dark" } },
        "control",
      );
    expect(seen.at(-1)).toEqual({ kind: "events.resyncRequired", scope: undefined, timers: 0 });
    expect(ui.intent.scope(binding)).toBeUndefined();
    off();
  } finally {
    channel.dispose();
    peer.close();
    child.close();
    await composition.dispose();
    await f.cleanup();
  }
});
it.each(["live", "closed", "disposed"] as const)(
  "BM-06 retirement uses the original %s peer even when its owner is not current",
  async (state) => {
    const f = await compositionInput();
    f.input.foundationOptions.requirements = () => [];
    const composition = await composeDesktopMain(f.input);
    const [a, b] = createMemoryChannelPair();
    const peer = new RpcPeer(a),
      child = new RpcPeer(b);
    const owner = {
      sourceKey: "dev:retained",
      pluginId: "test.retained",
      generation: 1,
      hostEpoch: f.input.foundationOptions.profile.hostEpoch,
      processEpoch: randomUUID(),
    };
    const retire = vi.spyOn(composition.stage3.device, "retire");
    const freeze = vi.spyOn(composition.stage3.persistence, "freeze");
    const drain = vi.spyOn(composition.stage3.persistence, "drain");
    const lost = vi.spyOn(composition.stage3.persistence, "ownerLost");
    const binding = composition.stage3Host.bindChannel({
      peer,
      owner,
      requirements: [],
      principal: () => f.input.principal(owner),
    });
    try {
      // This synthetic retained owner has never been in the manager's current registry.
      if (state === "closed") peer.close();
      if (state === "disposed") {
        binding.dispose();
        expect(peer.closed).toBe(false);
      }
      await composition.stage3Host.retireResources({ ...owner }, "disable");
      expect(retire).toHaveBeenCalledExactlyOnceWith(
        owner,
        state === "live" ? "disabled" : "crashed",
      );
      if (state === "live") {
        expect(freeze).toHaveBeenCalledOnce();
        expect(drain).toHaveBeenCalledOnce();
        expect(lost).not.toHaveBeenCalled();
      } else {
        expect(lost).toHaveBeenCalledExactlyOnceWith(owner);
        expect(freeze).not.toHaveBeenCalled();
        expect(drain).not.toHaveBeenCalled();
      }
    } finally {
      binding.dispose();
      peer.close();
      child.close();
      retire.mockRestore();
      freeze.mockRestore();
      drain.mockRestore();
      lost.mockRestore();
      await composition.dispose();
      await f.cleanup();
    }
  },
);
it("D160 rejects a channel owner mismatch before installing routes", async () => {
  const f = await compositionInput();
  const composition = await composeDesktopMain(f.input);
  const [a, b] = createMemoryChannelPair();
  const peer = new RpcPeer(a),
    child = new RpcPeer(b);
  const owner = {
    sourceKey: "dev:test",
    pluginId: "test.ui",
    generation: 1,
    hostEpoch: f.input.foundationOptions.profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  const attach = vi.spyOn(composition.foundation.broker, "attachChannel");
  const handle = vi.spyOn(peer, "handle");
  try {
    expect(() =>
      composition.stage3Host.bindChannel({
        peer,
        owner,
        requirements: [],
        principal: () => f.input.principal({ ...owner, processEpoch: randomUUID() }),
      }),
    ).toThrow("Channel owner mismatch.");
    expect(attach).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  } finally {
    attach.mockRestore();
    handle.mockRestore();
    peer.close();
    child.close();
    await composition.dispose();
    await f.cleanup();
  }
});
it("D160 requirements are a frozen copy and preserve unknown-owner null", async () => {
  const f = await compositionInput();
  const declarations = [{ capability: "motion", required: true }];
  f.input.foundationOptions.requirements = (owner) =>
    owner.generation === 1 ? declarations : null;
  const composition = await composeDesktopMain(f.input);
  const owner = {
    sourceKey: "dev:test",
    pluginId: "test.ui",
    generation: 1,
    hostEpoch: f.input.foundationOptions.profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  try {
    const copy = composition.stage3Host.requirements(owner);
    expect(copy).toEqual([{ capability: "motion", required: true }]);
    expect(copy).not.toBe(declarations);
    expect(copy![0]).not.toBe(declarations[0]);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy![0])).toBe(true);
    declarations[0]!.required = false;
    declarations.push({ capability: "files", required: false });
    expect(copy).toEqual([{ capability: "motion", required: true }]);
    expect(composition.stage3Host.requirements({ ...owner, generation: 2 })).toBeNull();
    declarations.length = 0;
    expect(composition.stage3Host.requirements(owner)).toEqual([]);
    expect(Object.isFrozen(composition.stage3Host.requirements(owner))).toBe(true);
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it("BM-18 D160 import has no provider, process or profile side effects", async () => {
  vi.resetModules();
  const runtime = await import("@kobrixa/plugin-runtime");
  const module = await import("../device-broker/lifecycle-coordinator.js");
  const create = vi.spyOn(runtime.PluginManager, "create");
  const factory = vi.mocked(module.createDesktopFoundation);
  factory.mockClear();
  try {
    await import("./controller.js");
    expect(create).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    factory.mockClear();
  }
});

import type {
  Stage3RuntimePorts,
  Stage3HostAttachment,
  UiRuntimeAttachment,
  UserPersistenceActionPort,
} from "@kobrixa/plugin-runtime";
import * as persistenceFactory from "./persistence/host-port.js";
import type { PersistenceHost, PersistenceRequestMap } from "./persistence/host-port.js";
import * as worker170 from "./persistence/worker.js";
import * as filesystem170 from "./persistence/filesystem.js";
import { resourceFreePersistence150 } from "@kobrixa/plugin-runtime";
import { RPC_ERRORS } from "@kobrixa/plugin-protocol";
import {
  composePersistence170,
  bindPersistenceRoutes170,
  persistenceRoutes170,
  createPersistenceClaims170,
  createNativePersistenceActions170,
  createPersistenceSources170,
} from "./controller.js";

type PersistenceInput170 = Parameters<typeof persistenceFactory.createPersistenceHost>[0];

function unusedPort170<T extends object>(name: string): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, key) {
      throw new Error(`Unexpected ${name}.${String(key)}`);
    },
  });
}

function fakeStage3Host(): Stage3HostAttachment {
  return {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    principal() {
      throw new Error("No principal in resource-free forwarding test");
    },
    hasPermission: () => false,
    requirements: () => [],
    bindChannel() {
      throw new Error("No channel in resource-free forwarding test");
    },
    retireResources: async () => {},
  };
}

function compositionInput170() {
  const profile = {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    assertHeld: vi.fn(),
  };
  const input: PersistenceInput170 = {
    profile,
    composition: {
      backend: unusedPort170("backend"),
      sources: unusedPort170("sources"),
      events: unusedPort170("events"),
      dispatchDrain: vi.fn(),
      imports: unusedPort170("imports"),
    },
    reservations: unusedPort170("reservations"),
    actions: unusedPort170("actions"),
    actionAdapter: unusedPort170("actionAdapter"),
    coreActions: unusedPort170("coreActions"),
    now: () => 100,
    hasPermission: () => false,
  };
  const ports: Pick<Stage3RuntimePorts, "device" | "ui"> = {
    device: unusedPort170("device"),
    ui: unusedPort170("ui"),
  };
  return { input, ports, profile };
}

it("R170/D170 passes the same profile/reservation ports and actual participant by identity", async () => {
  const { input, ports, profile } = compositionInput170();
  const participant = unusedPort170<Stage3RuntimePorts["persistence"]>("participant");
  const host: persistenceFactory.PersistenceHost = {
    participant,
    settings: unusedPort170("settings"),
    recovery: unusedPort170("recovery"),
    request: () => Promise.reject(new Error("No request admitted by this test")),
    dispose: vi.fn(async () => {}),
  };
  const createHost = vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue(host);
  const attached = await composePersistence170(input, ports);
  expect(createHost).toHaveBeenCalledExactlyOnceWith(input);
  expect(profile.assertHeld).toHaveBeenCalledTimes(2);
  expect(attached.host).toBe(host);
  expect(attached.stage3.persistence).toBe(participant);
  expect(attached.stage3.device).toBe(ports.device);
  expect(attached.stage3.ui).toBe(ports.ui);
  // No replacement reservation wrapper and no new onEnded subscription.
  expect(createHost.mock.calls[0]![0].reservations).toBe(input.reservations);
});

it("F20 rejects a secondary/unheld profile before creating a persistence host", async () => {
  const { input, ports, profile } = compositionInput170();
  profile.assertHeld.mockImplementation(() => {
    throw new Error("Profile not held");
  });
  const createHost = vi.spyOn(persistenceFactory, "createPersistenceHost");
  await expect(composePersistence170(input, ports)).rejects.toThrow("Profile not held");
  expect(createHost).not.toHaveBeenCalled();
});

it("failed recovery construction never falls back to an empty participant", async () => {
  const { input, ports } = compositionInput170();
  vi.spyOn(persistenceFactory, "createPersistenceHost").mockRejectedValue(
    new Error("Recovery blocked"),
  );
  await expect(composePersistence170(input, ports)).rejects.toThrow("Recovery blocked");
});

it("a profile revoked during construction disposes the new host and rejects admission", async () => {
  const { input, ports, profile } = compositionInput170();
  profile.assertHeld
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error("Profile lost");
    });
  const dispose = vi.fn(async () => {});
  vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue({
    participant: unusedPort170("participant"),
    settings: unusedPort170("settings"),
    recovery: unusedPort170("recovery"),
    request: () => Promise.reject(new Error("Not admitted")),
    dispose,
  });
  await expect(composePersistence170(input, ports)).rejects.toThrow("Profile lost");
  expect(dispose).toHaveBeenCalledOnce();
});

it("startPlugins forwards the actual stage3 bundle without copying its participant", async () => {
  const { input, ports } = compositionInput170();
  const participant = unusedPort170<Stage3RuntimePorts["persistence"]>("participant");
  vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue({
    participant,
    settings: unusedPort170("settings"),
    recovery: unusedPort170("recovery"),
    request: () => Promise.reject(new Error("Not admitted")),
    dispose: async () => {},
  });
  const attached = await composePersistence170(input, ports);
  const manager = await PluginManager.create({
    sources: [],
    store: {
      load: async () => ({ disabled: new Set<string>(), legacyDisabledIds: new Set<string>() }),
      save: async () => {},
    },
    safeMode: true,
    launcher: async () => {
      throw new Error("Resource-free forwarding test");
    },
    locale: "en",
  });
  const createManager = vi.spyOn(PluginManager, "create").mockResolvedValue(manager);
  const stage3Host = fakeStage3Host();
  const runtime = unusedPort170<UiRuntimeAttachment>("runtime");
  vi.spyOn(manager, "stage3Runtime").mockReturnValue(runtime);
  const onStage3Runtime = vi.fn();
  await start(fakeDialogs(), {
    commandLine: { developmentDirectories: [], safeMode: true },
    stage3: attached.stage3,
    stage3Host,
    onStage3Runtime,
  });
  expect(createManager.mock.calls.at(-1)![0].stage3).toBe(attached.stage3);
  expect(createManager.mock.calls.at(-1)![0].stage3Host).toBe(stage3Host);
  expect(onStage3Runtime).toHaveBeenCalledOnce();
  expect(onStage3Runtime.mock.calls[0]![0]).toBe(runtime);
  expect(onStage3Runtime.mock.calls[0]![1]).toBe(manager);
});
it("rejects either half of the D150 stage3 pair before constructing a manager", async () => {
  const { ports } = compositionInput170();
  const stage3: Stage3RuntimePorts = { ...ports, persistence: unusedPort170("participant") };
  const create = vi.spyOn(PluginManager, "create");
  await expect(
    start(fakeDialogs(), {
      commandLine: { developmentDirectories: [], safeMode: true },
      stage3,
    }),
  ).rejects.toThrow("stage3 and stage3Host must be supplied together");
  await expect(
    start(fakeDialogs(), {
      commandLine: { developmentDirectories: [], safeMode: true },
      stage3Host: fakeStage3Host(),
    }),
  ).rejects.toThrow("stage3 and stage3Host must be supplied together");
  expect(create).not.toHaveBeenCalled();
});

const h170 = "00000000-0000-4000-8000-000000000001";
const revision170 = "r_" + "1".repeat(32);
const samples170 = {
  "settings/read": { schemaVersion: 1 },
  "settings/update": {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "a.b", value: 1 }],
  },
  "settings/reset": { schemaVersion: 1, expectedRevision: null, keys: ["a.b"] },
  "settings/watch": { schemaVersion: 1 },
  "settings/readMigration": {},
  "settings/migrate": {
    fromSchemaVersion: 1,
    schemaVersion: 2,
    expectedRevision: revision170,
    values: [],
  },
  "storage/beginWrite": {
    label: "Test",
    kind: "test",
    schemaVersion: 1,
    mediaType: "application/json",
    byteLength: 2,
    sha256: "a".repeat(64),
    target: { mode: "create" },
  },
  "storage/writeChunk": { write: h170, offset: 0, data: "e30=" },
  "storage/sealWrite": { write: h170 },
  "storage/commitWrite": { write: h170 },
  "storage/writeStatus": { write: h170 },
  "storage/abortWrite": { write: h170 },
  "storage/stat": { id: h170 },
  "storage/list": { limit: 1 },
  "storage/openRead": { id: h170, expectedRevision: revision170, schemaVersion: 1 },
  "storage/readChunk": { read: h170, offset: 0, maxBytes: 1 },
  "storage/closeRead": { read: h170 },
  "storage/delete": { id: h170, expectedRevision: revision170 },
  "storage/flush": {},
  "storage/quota": {},
  "storage/registerCheckpoint": { id: h170, expectedRevision: revision170 },
  "storage/abandonCheckpoint": { checkpoint: h170 },
  "storage/exportBegin": {
    actionRef: h170,
    suggestedName: "test.json",
    mediaType: "application/json",
    byteLength: 2,
    sha256: "a".repeat(64),
  },
  "storage/exportChunk": { export: h170, offset: 0, data: "e30=" },
  "storage/exportCommit": { export: h170 },
  "storage/exportStatus": { export: h170 },
  "storage/exportCancel": { export: h170 },
  "ui/copyText": { actionRef: h170, text: "test" },
} satisfies { [M in (typeof persistenceRoutes170)[number]]: PersistenceRequestMap[M]["params"] };
function routes170() {
  const [a, b] = createMemoryChannelPair();
  const peer = new RpcPeer(a),
    client = new RpcPeer(b);
  const owner = {
    sourceKey: "builtin:test.storage",
    pluginId: "test.storage",
    generation: 1,
    hostEpoch: h170,
    processEpoch: h170,
  };
  let api = "1.7.0",
    current = true;
  let principalOwner = owner;
  const principal = vi.fn(() => ({
    kind: "plugin" as const,
    owner: principalOwner,
    authorityContext: null,
  }));
  const calls: Array<{ method: string; params: unknown; signal: AbortSignal }> = [];
  const host: PersistenceHost = {
    settings: unusedPort170("settings"),
    recovery: unusedPort170("recovery"),
    participant: unusedPort170("participant"),
    request: async (_principal, method, params, signal) => {
      calls.push({ method, params, signal });
      return { ok: false, error: { code: "PLUGIN_E_DISABLED", message: "Fixture domain gate" } };
    },
    dispose: async () => {},
  };
  const attachment = {
    owner,
    negotiated: vi.fn(),
    activate: vi.fn(),
    abandon: vi.fn(),
    dispose: vi.fn(),
  };
  const dispose = bindPersistenceRoutes170({
    context: { peer, owner, principal, requirements: [] },
    host,
    attachment,
    apiVersion: () => api,
    admitted: () => current,
  });
  return {
    peer,
    client,
    raw: b,
    host,
    calls,
    principal,
    attachment,
    dispose,
    api: (value: string) => {
      api = value;
    },
    stale: () => {
      current = false;
    },
    forge: () => {
      principalOwner = { ...owner, generation: 2 };
    },
    close: () => {
      dispose();
      peer.close();
      client.close();
    },
  };
}
it.each(persistenceRoutes170)(
  "routes %s through RpcPeer with a fresh principal",
  async (method) => {
    const f = routes170();
    try {
      await expect(f.client.request(method, samples170[method])).resolves.toMatchObject({
        ok: false,
      });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ method, params: samples170[method] });
      expect(f.calls[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(f.principal).toHaveBeenCalledOnce();
      f.api("1.6.0");
      await expect(f.client.request(method, samples170[method])).rejects.toMatchObject({
        code: RPC_ERRORS.methodNotFound,
      });
      expect(f.calls).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
it.each(["stale", "forge"] as const)(
  "rejects %s owner without calling the domain host",
  async (change) => {
    const f = routes170();
    f[change]();
    try {
      await expect(f.client.request("settings/read", { schemaVersion: 1 })).rejects.toMatchObject({
        code: RPC_ERRORS.permissionDenied,
      });
      expect(f.calls).toHaveLength(0);
    } finally {
      f.close();
    }
  },
);
it("rejects malformed wire params and reverse drain with numeric errors", async () => {
  const f = routes170();
  try {
    await expect(
      f.client.request("storage/drain", {
        token: h170,
        reason: "disable",
        remainingMs: 10,
        checkpoints: [],
        writes: [],
      }),
    ).rejects.toMatchObject({ code: RPC_ERRORS.methodNotFound });
    // Raw wire bypasses caller-side validation, proving the host rejects it too.
    const response = new Promise<string>((resolve) => f.raw.onMessage(resolve));
    f.raw.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "settings/read",
        params: { schemaVersion: "bad", owner: {} },
      }),
    );
    expect(JSON.parse(await response).error.code).toBe(RPC_ERRORS.invalidParams);
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

it.each([false, true])("settings/watch uses afterReply; cancelled=%s", async (cancelled) => {
  const f = routes170();
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const watch = {
    ok: true as const,
    value: {
      subscriptionId: h170,
      sequence: 0 as const,
      snapshot: { schemaVersion: 1, revision: null, values: [] },
    },
  };
  vi.spyOn(f.host, "request").mockImplementation(async () => {
    entered();
    await gate;
    return watch;
  });
  const abort = new AbortController();
  try {
    const pending = f.client.request(
      "settings/watch",
      { schemaVersion: 1 },
      { signal: abort.signal },
    );
    const observed = cancelled
      ? expect(pending).rejects.toBeDefined()
      : expect(pending).resolves.toEqual(watch);
    await started;
    expect(f.attachment.activate).not.toHaveBeenCalled();
    if (cancelled) abort.abort();
    finish();
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.attachment.activate).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    expect(f.attachment.abandon).toHaveBeenCalledTimes(cancelled ? 1 : 0);
  } finally {
    f.close();
  }
});

it("P170 constructs one worker and host before admission, keeps the original listener, and disposes once", async () => {
  const f = await compositionInput();
  const profile = f.input.foundationOptions.profile;
  const backend: PersistenceBackend170 = {
    engine: unusedPort170("engine"),
    reads: unusedPort170("reads"),
    evidence: unusedPort170("evidence"),
    imports: unusedPort170("imports"),
    output: unusedPort170("output"),
    destinations: unusedPort170("destinations"),
    sources: unusedPort170("sources"),
    dispose: vi.fn(async () => {
      profile.assertHeld();
    }),
  };
  const root = Object.freeze({}) as StoreRoot170;
  const open = vi.spyOn(filesystem170, "openStoreRoot").mockResolvedValue(root);
  const worker = vi
    .spyOn(worker170, "startPersistenceWorker")
    .mockResolvedValue({ backend, recovery: "ready" });
  const participant = resourceFreePersistence150();
  const host: PersistenceHost = {
    participant,
    settings: unusedPort170("settings"),
    recovery: {
      snapshot: () => ({ revision: 0, items: [] }),
      subscribe: () => () => {},
      export: async () => {
        throw new Error("No export in composition fixture");
      },
    },
    request: async () => ({
      ok: false,
      error: { code: "PLUGIN_E_DISABLED", message: "No source" },
    }),
    dispose: vi.fn(async () => {
      profile.assertHeld();
      await backend.dispose();
    }),
  };
  const createHost = vi
    .spyOn(persistenceFactory, "createPersistenceHost")
    .mockImplementation(async (input) => {
      expect(input.profile).toBe(profile);
      expect(input.composition.backend).toBe(backend);
      await expect(
        input.composition.dispatchDrain(
          {
            sourceKey: "builtin:test.storage",
            pluginId: "test.storage",
            generation: 1,
            hostEpoch: profile.hostEpoch,
            processEpoch: h170,
          },
          { token: h170, reason: "disable", remainingMs: 10, checkpoints: [], writes: [] },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Runtime attachment not ready");
      return host;
    });
  let listenerCount = 0;
  const original = f.factory.getMockImplementation()!;
  f.factory.mockImplementation(async (options) => {
    const foundation = await original(options);
    const onEnded = foundation.broker.reservations.onEnded.bind(foundation.broker.reservations);
    vi.spyOn(foundation.broker.reservations, "onEnded").mockImplementation((listener) => {
      listenerCount++;
      return onEnded(listener);
    });
    return foundation;
  });
  try {
    const composition = await composeDesktopMain(f.input);
    expect(worker).toHaveBeenCalledExactlyOnceWith({
      profile,
      root,
      workerEntry: expect.any(String),
      now: f.input.foundationOptions.now,
    });
    expect(createHost).toHaveBeenCalledOnce();
    expect(listenerCount).toBe(1);
    expect(composition.stage3.persistence).toBe(participant);
    expect(composition.stage3.device).toBe(composition.foundation.broker.resources);
    expect(createHost.mock.calls[0]![0].reservations).toBe(
      composition.foundation.broker.reservations,
    );
    expect(composition.plugins.persistence170?.settings).toBe(host.settings);
    await composition.dispose();
    await composition.dispose();
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(backend.dispose).toHaveBeenCalledOnce();
  } finally {
    createHost.mockRestore();
    worker.mockRestore();
    open.mockRestore();
    await f.cleanup();
  }
});
it("importing controller starts no worker or native dialog", async () => {
  const worker = vi.spyOn(worker170, "startPersistenceWorker");
  const open = vi.spyOn(filesystem170, "openStoreRoot");
  try {
    await import("./controller.js");
    expect(worker).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally {
    worker.mockRestore();
    open.mockRestore();
  }
});

it("only already-claimed core or feature actions become one native correlation", () => {
  let clock = 0,
    live = true;
  const scope = { hostEpoch: h170, workbenchInstance: h170 };
  const owner = {
    sourceKey: "builtin:test.storage",
    pluginId: "test.storage",
    generation: 1,
    hostEpoch: h170,
    processEpoch: h170,
  };
  const core = createCoreActionLedger({ now: () => clock, current: () => live });
  let used = false;
  const feature: UserPersistenceActionPort = {
    claim: () => {
      if (used)
        return { ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "Consumed" } };
      used = true;
      return { ok: true, value: { action: "00000000-0000-4000-8000-000000000005" } };
    },
  };
  const claims = createPersistenceClaims170({
    feature,
    core,
    scope: () => scope,
    currentScope: () => live,
    currentOwner: () => live,
    now: () => clock,
  });
  const target = { kind: "persistence-export" as const, recovery: h170 };
  const action = core.mint(scope, target);
  expect(claims.lookup(action.actionToken)).toBeNull();
  expect(claims.core.claim(action, target)).toBe(true);
  const correlation = claims.lookup(action.actionToken);
  expect(correlation).toMatchObject({ scope, purpose: "storage.export" });
  expect(claims.lookup(action.actionToken)).toBeNull();
  expect(claims.core.claim(action, target)).toBe(false);
  expect(claims.feature.claim({ owner, actionRef: h170 }, "ui.clipboard")).toMatchObject({
    ok: true,
  });
  live = false;
  expect(claims.lookup("00000000-0000-4000-8000-000000000005")).toBeNull();
  live = true;
  const second = core.mint(scope, target);
  expect(claims.core.claim(second, target)).toBe(true);
  clock = 120000;
  expect(claims.lookup(second.actionToken)).toBeNull();
  core.complete(action);
  core.complete(second);
});

it.each(["cancel", "late", "retired", "aborted"] as const)(
  "native destination %s writes nothing",
  async (kind) => {
    let clock = 0,
      live = true;
    const control = new AbortController();
    const scope = { hostEpoch: h170, workbenchInstance: h170 };
    const register = vi.fn(async () => {
      throw new Error("Must not register");
    });
    const release = vi.fn(async () => {});
    const adapter = createNativePersistenceActions170({
      claims: () => ({ scope, deadline: 10, purpose: "storage.export", current: () => live }),
      backend: { destinations: { register, release } },
      now: () => clock,
      currentScope: () => live,
      copy: vi.fn(),
      choose: async () => {
        if (kind === "late") clock = 10;
        if (kind === "retired") live = false;
        if (kind === "aborted") control.abort();
        return kind === "cancel" ? null : "/private/destination";
      },
    });
    expect(await adapter.chooseDestination(h170, "file.json", control.signal)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  },
);
it("late registry return releases its opaque destination without returning a native path", async () => {
  const scope = { hostEpoch: h170, workbenchInstance: h170 };
  let clock = 0;
  const destination = Object.freeze({}) as ExportDestination170;
  const release = vi.fn(async () => {});
  const register = vi.fn(async () => {
    clock = 10;
    return destination;
  });
  const adapter = createNativePersistenceActions170({
    claims: () => ({ scope, deadline: 10, purpose: "storage.export", current: () => true }),
    backend: { destinations: { register, release } },
    now: () => clock,
    currentScope: () => true,
    copy: vi.fn(),
    choose: async () => "/private/destination",
  });
  expect(
    await adapter.chooseDestination(h170, "file.json", new AbortController().signal),
  ).toBeNull();
  expect(release).toHaveBeenCalledExactlyOnceWith(destination);
});
it("data-only source namespace never activates runtime and revoked catalog data cannot be read", async () => {
  const currentRuntime = vi.fn(() => false),
    beforeDelivery = vi.fn();
  const sources = createPersistenceSources170({
    currentScope: () => true,
    currentRuntime,
    beforeDelivery,
  });
  const raw = JSON.stringify({
    schemaVersion: 1,
    title: { en: "Settings" },
    fields: [{ key: "enabled", label: { en: "Enabled" }, type: "boolean", default: false }],
  });
  sources.admit({
    owner: {
      sourceKey: "builtin:test.settings",
      pluginId: "test.settings",
      uiResourceGeneration: 1,
    },
    eligible: true,
    document: { value: JSON.parse(raw), bytes: Buffer.byteLength(raw), digest: "a".repeat(64) },
  });
  const owner = sources.port.coreOwner({
    sourceKey: "builtin:test.settings",
    scope: { hostEpoch: h170, workbenchInstance: h170 },
  });
  expect(owner).not.toBeNull();
  expect(currentRuntime).not.toHaveBeenCalled();
  sources.revoke("builtin:test.settings");
  expect(
    sources.port.coreOwner({
      sourceKey: "builtin:test.settings",
      scope: { hostEpoch: h170, workbenchInstance: h170 },
    }),
  ).toBeNull();
  expect(
    await sources.port.settings({
      sourceKey: "builtin:test.settings",
      resourceDigest: "a".repeat(64),
    }),
  ).toBeNull();
  expect(beforeDelivery).not.toHaveBeenCalled();
});

import { build as buildWorker170 } from "vite";
import { fileURLToPath } from "node:url";
const realWorker170 = worker170.startPersistenceWorker;
let testWorkerDirectory170: string, testWorkerEntry170: string;
beforeAll(async () => {
  testWorkerDirectory170 = await realpath(await mkdtemp(path.join(tmpdir(), "d170-worker-")));
  const entry = path.join(testWorkerDirectory170, "entry.ts");
  const worker = fileURLToPath(new URL("./persistence/worker.ts", import.meta.url));
  const fixtures = fileURLToPath(new URL("./persistence/import-fixtures.ts", import.meta.url));
  await writeFile(
    entry,
    `import {runPersistenceWorker} from ${JSON.stringify(worker)};
    import {syntheticPreferencesImportDescriptor} from ${JSON.stringify(fixtures)};
    runPersistenceWorker({mappers:new Map([[syntheticPreferencesImportDescriptor.id,syntheticPreferencesImportDescriptor]])});`,
  );
  await buildWorker170({
    configFile: false,
    logLevel: "error",
    build: {
      target: "node24",
      outDir: path.join(testWorkerDirectory170, "bundle"),
      emptyOutDir: true,
      lib: { entry, formats: ["cjs"], fileName: () => "worker.cjs" },
      rollupOptions: { external: [/^node:/] },
      minify: false,
    },
  });
  testWorkerEntry170 = path.join(testWorkerDirectory170, "bundle", "worker.cjs");
}, 60000);
afterAll(async () => {
  await rm(testWorkerDirectory170, { recursive: true, force: true });
});

import { desktopFoundationTestHandles } from "./controller.js";
import { syntheticPreferencesImportDescriptor } from "./persistence/import-fixtures.js";
const settingsRaw170 = JSON.stringify({
  schemaVersion: 1,
  title: { en: "Test settings" },
  fields: [
    {
      key: "device.choice",
      label: { en: "Choice" },
      type: "enum",
      default: 1,
      options: [
        { value: 1, label: { en: "Number" } },
        { value: "1", label: { en: "String" } },
      ],
    },
  ],
});
function staticSource170(
  id = "test.settings",
  raw: string | undefined = settingsRaw170,
): Extract<PluginSource, { kind: "builtin" }> {
  return {
    kind: "builtin",
    policy: "optional",
    resources: raw ? { "settings.json": raw } : {},
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: "^1.7.0",
      runtime: { kind: "builtin" },
      displayName: { en: id },
      contributes: raw ? { settings: { version: 1, path: "settings.json" } } : {},
    },
  };
}
it("composeDesktopMain uses the real worker/host for data-only settings, preserving receipts and no activation", async () => {
  const f = await compositionInput();
  const managerFactory170 = vi.spyOn(PluginManager, "create");
  const hostFactory170 = vi.spyOn(persistenceFactory, "createPersistenceHost");
  f.input.plugins.builtins = [staticSource170()];
  const launcher = vi.fn<PluginLauncher>(async () => {
    throw new Error("Data-only source must not activate");
  });
  f.input.plugins.launcher = () => launcher;
  let control: worker170.PersistenceFaultControl | undefined;
  const composition = await composeDesktopMain(f.input, {
    worker: {
      entry: testWorkerEntry170,
      control: (value) => {
        control = value;
      },
    },
  });
  const handles = desktopFoundationTestHandles(composition);
  try {
    expect(handles.profile).toBe(f.input.foundationOptions.profile);
    expect(handles.persistenceProfile).toBe(handles.profile);
    expect(handles.host.settings).toBe(composition.plugins.persistence170!.settings);
    const manager170 = await managerFactory170.mock.results[0]!.value;
    const workerResult170 = await vi.mocked(worker170.startPersistenceWorker).mock.results[0]!
      .value;
    expect(handles.runtime).toBe(manager170.stage3Runtime());
    expect(handles.backend).toBe(workerResult170.backend);
    expect(handles.host).toBe(await hostFactory170.mock.results[0]!.value);
    expect(handles.recovery).toBe(workerResult170.recovery);
    expect(handles.recovery).toBe("ready");
    expect(control).toBeDefined();
    expect(handles.channels()).toEqual([]);
    const resourceDigest = createHash("sha256").update(settingsRaw170).digest("hex");
    let opened = await handles.host.settings.open({
      sourceKey: "builtin:test.settings",
      resourceDigest,
      scope: f.input.scope(),
    });
    expect(opened.snapshot.values).toEqual([{ key: "device.choice", value: 1 }]);
    const stale = opened.binding;
    await composition.plugins.setEnabled("builtin:test.settings", false);
    await composition.plugins.setEnabled("builtin:test.settings", true);
    opened = await vi.waitFor(() =>
      handles.host.settings.open({
        sourceKey: "builtin:test.settings",
        resourceDigest,
        scope: f.input.scope(),
      }),
    );
    const reserve = vi.spyOn(handles.backend.engine, "reserve");
    const reads = vi.spyOn(handles.backend.reads, "settings");
    await expect(handles.host.settings.read(stale)).rejects.toThrow("Stale");
    await expect(
      handles.host.settings.update(stale, {
        schemaVersion: 1,
        expectedRevision: null,
        changes: [{ key: "device.choice", value: "1" }],
      }),
    ).rejects.toThrow("Stale");
    expect(() => handles.host.settings.watch(stale, vi.fn())).toThrow("Stale");
    expect(opened.binding.owner.uiResourceGeneration).toBeGreaterThan(
      stale.owner.uiResourceGeneration,
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(await handles.host.settings.read(opened.binding)).toMatchObject({ ok: true });
    const changed = vi.fn();
    const off = handles.host.settings.watch(opened.binding, changed);
    const saved = await handles.host.settings.update(opened.binding, {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "device.choice", value: "1" }],
    });
    expect(saved).toMatchObject({
      ok: true,
      value: {
        snapshot: { values: [{ key: "device.choice", value: "1" }] },
        receipt: { revision: expect.stringMatching(/^r_/), commitId: expect.any(String) },
      },
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(reserve.mock.calls[0]![0].owner.generation).toBe(
      composition.plugins.persistenceCatalogSources()[0]!.owner.generation,
    );
    off();
    await composition.plugins.setEnabled("builtin:test.settings", false);
    await expect(handles.host.settings.read(opened.binding)).rejects.toThrow("Stale");
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it("composeDesktopMain restores the actual durable legacy barrier before exposing writers or requests", async () => {
  const f = await compositionInput();
  f.input.plugins.builtins = [staticSource170("test.preferences", undefined)];
  // Explicitly omit settings; source namespace admission does not need a schema.
  f.input.plugins.builtins = [
    {
      ...staticSource170("test.preferences"),
      resources: {},
      manifest: {
        id: "test.preferences",
        version: "1.0.0",
        apiVersion: "^1.7.0",
        displayName: { en: "Preferences" },
        runtime: { kind: "builtin" },
      },
    },
  ];
  const order: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const worker = vi.mocked(worker170.startPersistenceWorker);
  worker.mockImplementation(async (args) => {
    const started = await realWorker170({ ...args, workerEntry: testWorkerEntry170 });
    const keys = started.backend.evidence.auxiliaryKeys;
    vi.spyOn(started.backend.evidence, "auxiliaryKeys").mockImplementation(async (...args) => {
      order.push("restore");
      await gate;
      return keys(...args);
    });
    return started;
  });
  const writer = {
    sourceKey: "builtin:test.preferences",
    freezeAdmission: vi.fn(() => order.push("freeze")),
    settled: vi.fn(async () => {}),
  };
  let exposed = false;
  const pending = composeDesktopMain(f.input, {
    legacy: { descriptors: [syntheticPreferencesImportDescriptor], writers: [writer] },
  }).then((value) => {
    exposed = true;
    return value;
  });
  await vi.waitFor(() => expect(order).toContain("restore"));
  expect(order).toEqual(["freeze", "restore"]);
  expect(exposed).toBe(false);
  finish();
  const composition = await pending;
  try {
    const imports = composition.plugins.persistence170!.imports;
    expect(
      await imports.run(syntheticPreferencesImportDescriptor, new AbortController().signal),
    ).toMatchObject({ state: "pending" });
    const challenge = await imports.issuePreferences({
      descriptorId: syntheticPreferencesImportDescriptor.id,
      scope: f.input.scope(),
    });
    expect(challenge.keys).toEqual(["test.preference"]);
    expect(
      await imports.acceptPreferencesEvidence({
        nonce: challenge.nonce,
        scope: challenge.scope,
        entries: [{ key: "test.preference", raw: "001" }],
      }),
    ).toEqual({ state: "accepted" });
    expect(
      await imports.run(syntheticPreferencesImportDescriptor, new AbortController().signal),
    ).toMatchObject({ state: "complete", completedItems: 1, totalItems: 1 });
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it.each(["missing-source", "missing-mapper", "duplicate", "writer"] as const)(
  "composeDesktopMain rejects invalid legacy registration %s with backend cleanup",
  async (kind) => {
    const f = await compositionInput();
    f.input.plugins.builtins = [staticSource170("test.preferences")];
    const descriptor =
      kind === "missing-source"
        ? { ...syntheticPreferencesImportDescriptor, targetSourceKey: "builtin:test.foreign" }
        : kind === "missing-mapper"
          ? { ...syntheticPreferencesImportDescriptor, id: "test.missing" }
          : syntheticPreferencesImportDescriptor;
    const dispose = vi.fn<() => Promise<void>>();
    vi.mocked(worker170.startPersistenceWorker).mockImplementation(async (args) => {
      const started = await realWorker170({ ...args, workerEntry: testWorkerEntry170 });
      const close = started.backend.dispose;
      dispose.mockImplementation(close);
      started.backend.dispose = dispose;
      return started;
    });
    try {
      await expect(
        composeDesktopMain(f.input, {
          legacy: {
            descriptors: kind === "duplicate" ? [descriptor, descriptor] : [descriptor],
            writers:
              kind === "writer"
                ? [
                    {
                      sourceKey: "builtin:foreign",
                      freezeAdmission() {
                        throw new Error("Must validate first");
                      },
                      settled: async () => {},
                    },
                  ]
                : [],
          },
        }),
      ).rejects.toThrow();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  },
);
it("desktopFoundationTestHandles retains the original five-field process across replacement, disposal and exit", async () => {
  const f = await compositionInput();
  const directory = await pluginFolder("observed");
  f.input.foundationOptions.requirements = () => [];
  f.input.plugins.commandLine.developmentDirectories = [directory];
  const { memoryPlugin } =
    await import("../../../../../packages/plugin-runtime/src/test-process.js");
  const launched: PluginProcess170[] = [];
  f.input.plugins.launcher = () => async () => {
    const fixture = memoryPlugin((remote, control) => {
      remote.handle("initialize", () => ({
        apiVersion: "1.7.0",
        sdk: { name: "test", version: "1" },
      }));
      remote.handle("command/execute", () => null);
      remote.handle("shutdown", () => null);
      remote.onNotification("exit", () => control.exit());
    });
    launched.push(fixture.process);
    return fixture.process;
  };
  const composition = await composeDesktopMain(f.input, {});
  const handles = desktopFoundationTestHandles(composition);
  try {
    expect(handles.channels()).toEqual([]);
    const result = await composition.plugins.execute("acme.observed.greet");
    if (!result.ok) throw new Error(JSON.stringify(result));
    const row = handles.channels()[0]!;
    expect(row.process).toBe(launched[0]);
    expect(row.context.owner).toEqual(handles.runtime.owners()[0]);
    expect(() => composition.stage3Host.bindChannel(row.context)).toThrow("association");
    for (const changed of [
      { pluginId: "test.foreign" },
      { sourceKey: "builtin:test.foreign" },
      { generation: 999 },
      { hostEpoch: randomUUID() },
      { processEpoch: randomUUID() },
    ]) {
      expect(() =>
        composition.stage3Host.bindChannel({
          ...row.context,
          owner: { ...row.context.owner, ...changed },
        }),
      ).toThrow("association");
    }
    const exited = vi.fn();
    const off = row.process.onExit(exited);
    expect(await composition.plugins.reload(row.context.owner.sourceKey)).toMatchObject({
      ok: true,
    });
    expect(handles.channels()).toEqual([]);
    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(await composition.plugins.execute("acme.observed.greet")).toMatchObject({ ok: true });
    const replacement = handles.channels()[0]!;
    expect(replacement.process).toBe(launched[1]);
    expect(replacement.context.owner).not.toEqual(row.context.owner);
    expect(row.process).toBe(launched[0]);
    off();
    await composition.dispose();
    expect(handles.channels()).toEqual([]);
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it("desktopFoundationTestHandles unknown and normal lookups allocate nothing", async () => {
  const f = await compositionInput();
  const composition = await composeDesktopMain(f.input);
  const worker = vi.mocked(worker170.startPersistenceWorker);
  const count = worker.mock.calls.length;
  try {
    expect(() => desktopFoundationTestHandles(composition)).toThrow("non-test");
    expect(() => desktopFoundationTestHandles({} as DesktopMainComposition)).toThrow("Unknown");
    expect(worker).toHaveBeenCalledTimes(count);
    expect(worker.mock.calls[0]![0]).not.toHaveProperty("testControl");
    expect(path.isAbsolute(worker.mock.calls[0]![0].workerEntry)).toBe(true);
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it("composeDesktopMain shares concurrent disposal and retains the profile on unknown worker shutdown", async () => {
  const f = await compositionInput();
  let confirmed = false,
    closing!: () => void;
  const held = vi.spyOn(f.input.foundationOptions.profile, "assertHeld");
  const close = vi.fn(async () => {
    held();
    await new Promise<void>((resolve) => {
      closing = resolve;
    });
    if (!confirmed) throw new Error("worker-dispose-unknown");
  });
  const host = {
    participant: resourceFreePersistence150(),
    settings: unusedPort170("settings"),
    recovery: {
      snapshot: () => ({ revision: 0, items: [] }),
      subscribe: () => () => {},
      export: async () => {
        throw new Error("Unused export");
      },
    },
    request: async () => ({
      ok: false as const,
      error: { code: "PLUGIN_E_DISABLED" as const, message: "Fixture" },
    }),
    dispose: close,
  } satisfies PersistenceHost;
  const create = vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue(host);
  // This test controls only the named worker/host factories; it cannot perform storage work.
  const backend = {
    dispose: vi.fn(async () => {}),
  } as unknown as PersistenceBackend170;
  vi.mocked(worker170.startPersistenceWorker).mockResolvedValue({ backend, recovery: "blocked" });
  const composition = await composeDesktopMain(f.input, {});
  const foundationClose = vi.spyOn(composition.foundation, "dispose");
  try {
    const first = composition.dispose(),
      second = composition.dispose();
    expect(first).toBe(second);
    const rejected = expect(first).rejects.toThrow("worker-dispose-unknown");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    closing();
    await rejected;
    expect(foundationClose).not.toHaveBeenCalled();
    held();
    confirmed = true;
    const retried = composition.dispose();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    closing();
    await retried;
    expect(foundationClose).toHaveBeenCalledOnce();
  } finally {
    create.mockRestore();
    await f.cleanup();
  }
});

import type { PluginSource, PluginLauncher } from "@kobrixa/plugin-runtime";
import type { DesktopMainComposition } from "./controller.js";
it("desktopFoundationTestHandles drops a failed binding and retains the original process exit observation", async () => {
  const f = await compositionInput();
  f.input.foundationOptions.requirements = () => [];
  const directory = await pluginFolder("binding-failure");
  f.input.plugins.commandLine.developmentDirectories = [directory];
  const { memoryPlugin } =
    await import("../../../../../packages/plugin-runtime/src/test-process.js");
  const exit = vi.fn();
  let originalProcess: PluginProcess170 | undefined;
  f.input.plugins.launcher = () => async () => {
    originalProcess = memoryPlugin((peer, control) => {
      peer.handle("initialize", () => ({
        apiVersion: "1.7.0",
        sdk: { name: "test", version: "1" },
      }));
      peer.handle("shutdown", () => null);
      peer.onNotification("exit", () => control.exit());
    }).process;
    originalProcess.onExit(exit);
    return originalProcess;
  };
  const composition = await composeDesktopMain(f.input, {});
  const original = composition.stage3Host.bindChannel;
  vi.spyOn(composition.stage3Host, "bindChannel").mockImplementationOnce((context) => {
    const handle = context.peer.handle.bind(context.peer);
    vi.spyOn(context.peer, "handle").mockImplementation((method, handler) => {
      if (method === "settings/read") throw new Error("route attachment failed");
      handle(method, handler);
    });
    return original(context);
  });
  try {
    expect(await composition.plugins.execute("acme.binding-failure.greet")).toMatchObject({
      ok: false,
    });
    expect(desktopFoundationTestHandles(composition).channels()).toEqual([]);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(originalProcess).toBeDefined();
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it.each(["root", "worker", "host", "revoked"] as const)(
  "composeDesktopMain cleans partial %s construction without a fallback",
  async (kind) => {
    const f = await compositionInput();
    const foundation = f.factory.getMockImplementation()!;
    let closeFoundation: ReturnType<typeof vi.spyOn> | undefined;
    f.factory.mockImplementation(async (options) => {
      const value = await foundation(options);
      closeFoundation = vi.spyOn(value, "dispose");
      return value;
    });
    let backendClose: ReturnType<typeof vi.spyOn> | undefined;
    const realHost = persistenceFactory.createPersistenceHost;
    if (kind === "root")
      vi.spyOn(filesystem170, "openStoreRoot").mockRejectedValue(new Error("root failure"));
    if (kind === "worker")
      vi.mocked(worker170.startPersistenceWorker).mockRejectedValue(new Error("worker failure"));
    if (kind === "host" || kind === "revoked") {
      vi.mocked(worker170.startPersistenceWorker).mockImplementation(async (args) => {
        const value = await realWorker170({ ...args, workerEntry: testWorkerEntry170 });
        backendClose = vi.spyOn(value.backend, "dispose");
        if (kind === "host")
          vi.spyOn(value.backend.evidence, "recoveryPage").mockRejectedValue(
            new Error("host failure"),
          );
        return value;
      });
      if (kind === "revoked")
        vi.spyOn(persistenceFactory, "createPersistenceHost").mockImplementation(async (input) => {
          const host = await realHost(input);
          vi.spyOn(f.input.foundationOptions.profile, "assertHeld").mockImplementationOnce(() => {
            throw new Error("Profile lost");
          });
          return host;
        });
    }
    try {
      await expect(composeDesktopMain(f.input)).rejects.toThrow();
      expect(closeFoundation).toHaveBeenCalledOnce();
      if (backendClose) expect(backendClose).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  },
);
it("source retirement forbids core namespace rebinding and a marker failure withholds settings", async () => {
  const beforeDelivery = vi.fn(() => {
    throw new Error("marker failed");
  });
  const sources = createPersistenceSources170({
    currentScope: () => true,
    currentRuntime: () => false,
    beforeDelivery,
  });
  const owner = {
    sourceKey: "builtin:test.settings",
    pluginId: "test.settings",
    uiResourceGeneration: 7,
  };
  const scope = { hostEpoch: h170, workbenchInstance: h170 };
  sources.admit({
    owner,
    eligible: true,
    document: {
      value: JSON.parse(settingsRaw170),
      bytes: Buffer.byteLength(settingsRaw170),
      digest: "a".repeat(64),
    },
  });
  await expect(
    sources.port.settings({ sourceKey: owner.sourceKey, resourceDigest: "a".repeat(64) }),
  ).rejects.toThrow("marker failed");
  const namespace = sources.port.coreOwner({ sourceKey: owner.sourceKey, scope })!;
  expect(sources.port.current(namespace)).toBe(true);
  sources.retireScope(scope);
  expect(sources.port.current(namespace)).toBe(false);
  expect(sources.port.coreOwner({ sourceKey: owner.sourceKey, scope })).toBeNull();
});
it.each(["1.x.0", "1.7", "1.7.0junk", "2.0.0", "1.6.99"])(
  "rejects nonnegotiated persistence version %s before the domain",
  async (version) => {
    const f = routes170();
    f.api(version);
    try {
      await expect(f.client.request("settings/read", { schemaVersion: 1 })).rejects.toMatchObject({
        code: RPC_ERRORS.methodNotFound,
      });
      expect(f.calls).toHaveLength(0);
    } finally {
      f.close();
    }
  },
);
it("a stale watch reply abandons the original reservation and cannot activate a replacement owner", async () => {
  const f = routes170();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  vi.spyOn(f.host, "request").mockImplementation(async () => {
    entered();
    await gate;
    return {
      ok: true,
      value: {
        subscriptionId: h170,
        sequence: 0,
        snapshot: { schemaVersion: 1, revision: null, values: [] },
      },
    };
  });
  try {
    const pending = f.client.request("settings/watch", { schemaVersion: 1 });
    await started;
    f.stale();
    release();
    await pending;
    await vi.waitFor(() => expect(f.attachment.abandon).toHaveBeenCalledExactlyOnceWith(h170));
    expect(f.attachment.activate).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("admitted settings RPC reads and watches through the actual manager/host before any core form opens", async () => {
  const f = await compositionInput();
  const directory = await pluginFolder("settings-rpc");
  const manifestPath = path.join(directory, "kobrixa-plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.apiVersion = "^1.7.0";
  manifest.permissions = ["settings.read", "settings.write"];
  manifest.contributes.settings = { version: 1, path: "settings.json" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(directory, "settings.json"), settingsRaw170);
  f.input.plugins.commandLine.developmentDirectories = [directory];
  f.input.foundationOptions.requirements = () => [];
  const controllerRef170: { current?: PluginController } = {};
  let remote!: RpcPeer;
  f.input.foundationOptions.hasPermission = (principal, permission) =>
    principal.kind === "plugin" &&
    !!controllerRef170.current &&
    desktopDeviceAccess(controllerRef170.current).hasPermission(principal.owner, permission);
  const delivered: unknown[] = [];
  const { memoryPlugin } =
    await import("../../../../../packages/plugin-runtime/src/test-process.js");
  f.input.plugins.launcher = () => async () =>
    memoryPlugin((peer, control) => {
      remote = peer;
      peer.handle("initialize", () => ({
        apiVersion: "1.7.0",
        sdk: { name: "test", version: "1" },
      }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => null);
      peer.onNotification("exit", () => control.exit());
      peer.onNotification("events/deliver", (event) => {
        delivered.push(event);
      });
    }).process;
  const composition = await composeDesktopMain(f.input, {});
  const controller = composition.plugins;
  controllerRef170.current = controller;
  try {
    expect(await controller.execute("acme.settings-rpc.greet")).toMatchObject({ ok: true });
    expect(await remote.request("settings/read", { schemaVersion: 1 })).toMatchObject({
      ok: true,
      value: { values: [{ key: "device.choice", value: 1 }] },
    });
    const watch = await remote.request("settings/watch", { schemaVersion: 1 });
    expect(watch.ok).toBe(true);
    const saved = await remote.request("settings/update", {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "device.choice", value: "1" }],
    });
    expect(saved).toMatchObject({
      ok: true,
      value: {
        snapshot: { values: [{ key: "device.choice", value: "1" }] },
        receipt: { revision: expect.any(String) },
      },
    });
    await vi.waitFor(() =>
      expect(delivered).toContainEqual(
        expect.objectContaining({ kind: "settings.changed", delivery: "telemetry" }),
      ),
    );
    if (watch.ok)
      expect(
        await remote.request("events/unsubscribe", { subscriptionId: watch.value.subscriptionId }),
      ).toMatchObject({ ok: true, value: { removed: true } });
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});

import type { PersistenceBackend as PersistenceBackend170 } from "./persistence/engine-port.js";
import type { StoreRoot as StoreRoot170 } from "./persistence/filesystem.js";
import type { ExportDestination as ExportDestination170 } from "./persistence/actions.js";
import type { PluginProcess as PluginProcess170 } from "@kobrixa/plugin-runtime";
it("composeDesktopMain cleans a coordinator construction failure after the actual host is ready", async () => {
  const f = await compositionInput();
  const factory = f.factory.getMockImplementation()!;
  const hostFactory = vi.spyOn(persistenceFactory, "createPersistenceHost");
  let closeFoundation: ReturnType<typeof vi.spyOn> | undefined;
  f.factory.mockImplementation(async (options) => {
    const foundation = await factory(options);
    closeFoundation = vi.spyOn(foundation, "dispose");
    vi.spyOn(foundation.broker.reservations, "onEnded").mockImplementation(() => {
      throw new Error("listener construction failed");
    });
    return foundation;
  });
  try {
    await expect(composeDesktopMain(f.input)).rejects.toThrow("listener construction failed");
    const host = await hostFactory.mock.results[0]!.value;
    await expect(
      host.settings.open({
        sourceKey: "builtin:test.settings",
        scope: f.input.scope(),
        resourceDigest: "a".repeat(64),
      }),
    ).rejects.toThrow();
    expect(closeFoundation).toHaveBeenCalledOnce();
    const started = await vi.mocked(worker170.startPersistenceWorker).mock.results[0]!.value;
    expect(worker170.persistenceWorkerCount(started.backend)).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it("safe mode suppresses the actual optional static settings inventory before reading invalid resources", async () => {
  const f = await compositionInput();
  f.input.plugins.builtins = [staticSource170("test.settings", "{not JSON")];
  f.input.plugins.commandLine.safeMode = true;
  const composition = await composeDesktopMain(f.input);
  try {
    expect(composition.plugins.persistenceCatalogSources()).toEqual([]);
    await expect(
      composition.plugins.persistence170!.settings.open({
        sourceKey: "builtin:test.settings",
        scope: f.input.scope(),
        resourceDigest: "a".repeat(64),
      }),
    ).rejects.toThrow("not admitted");
  } finally {
    await composition.dispose();
    await f.cleanup();
  }
});
it("actual primary profile remains held through backend disposal and confirmed worker exit", async () => {
  const f = await compositionInput();
  let quit: (() => void) | undefined;
  let composition: DesktopMainComposition | undefined;
  const primary = startPrimary(
    {
      requestSingleInstanceLock: () => true,
      hasSingleInstanceLock: () => true,
      whenReady: async () => {},
      quit() {
        throw new Error("Unexpected native quit");
      },
      on(event, listener) {
        if (event === "quit") quit = listener;
      },
    },
    async (profile) => {
      const scope = { hostEpoch: profile.hostEpoch, workbenchInstance: randomUUID() };
      f.input.foundationOptions.profile = profile;
      f.input.foundationOptions.authority = new AuthorityContexts(profile.hostEpoch);
      f.input.foundationOptions.journal = createJournal(
        createJournalFilesystem(f.input.plugins.userData),
        profile,
      );
      f.input.foundationOptions.coreActions = createCoreActionLedger({
        now: f.input.foundationOptions.now,
        current: (candidate) =>
          candidate.hostEpoch === scope.hostEpoch &&
          candidate.workbenchInstance === scope.workbenchInstance,
      });
      f.input.scope = () => scope;
      f.input.currentScope = (candidate) =>
        candidate.hostEpoch === scope.hostEpoch &&
        candidate.workbenchInstance === scope.workbenchInstance;
      composition = await composeDesktopMain(f.input, {});
    },
    () => false,
  )!;
  await primary.ready;
  const value = composition!;
  const handles = desktopFoundationTestHandles(value);
  const close = handles.backend.dispose.bind(handles.backend);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backendClose = vi.spyOn(handles.backend, "dispose").mockImplementation(async () => {
    primary.profile.assertHeld();
    await gate;
    await close();
    primary.profile.assertHeld();
  });
  const foundationClose = vi.spyOn(value.foundation, "dispose");
  try {
    expect(handles.persistenceProfile).toBe(primary.profile);
    expect(handles.profile).toBe(primary.profile);
    const disposal = value.dispose();
    await vi.waitFor(() => expect(backendClose).toHaveBeenCalledOnce());
    primary.profile.assertHeld();
    expect(foundationClose).not.toHaveBeenCalled();
    expect(worker170.persistenceWorkerCount(handles.backend)).toBe(1);
    release();
    await disposal;
    expect(worker170.persistenceWorkerCount(handles.backend)).toBe(0);
    expect(foundationClose).toHaveBeenCalledOnce();
    primary.profile.assertHeld();
    quit!();
    expect(() => primary.profile.assertHeld()).toThrow("not held");
  } finally {
    release();
    await value.dispose();
    await f.cleanup();
  }
});
it("native clipboard uses only the original consumed feature claim and cannot replay", async () => {
  const scope = { hostEpoch: h170, workbenchInstance: h170 };
  const owner = {
    sourceKey: "builtin:test.settings",
    pluginId: "test.settings",
    generation: 1,
    hostEpoch: h170,
    processEpoch: h170,
  };
  let live = true;
  const ledger = new UserPersistenceActions(
    () => 0,
    () => live,
  );
  const core = createCoreActionLedger({ now: () => 0, current: () => live });
  const claims = createPersistenceClaims170({
    feature: ledger,
    core,
    scope: () => scope,
    currentScope: () => live,
    currentOwner: () => live,
    now: () => 0,
  });
  const copy = vi.fn(),
    choose = vi.fn(async () => null),
    register = vi.fn(async () => {
      throw new Error("Unexpected destination");
    });
  const native = createNativePersistenceActions170({
    claims: claims.lookup,
    backend: { destinations: { register, release: async () => {} } },
    currentScope: () => live,
    now: () => 0,
    copy,
    choose,
  });
  const actionRef = ledger.mint(owner, scope, 1);
  await expect(native.copyText(actionRef, "forged")).rejects.toThrow("Stale");
  expect(copy).not.toHaveBeenCalled();
  expect(claims.feature.claim({ owner, actionRef }, "ui.clipboard")).toMatchObject({ ok: true });
  await native.copyText(actionRef, "copied");
  await expect(native.copyText(actionRef, "replayed")).rejects.toThrow("Stale");
  const retired = ledger.mint(owner, scope, 1);
  expect(claims.feature.claim({ owner, actionRef: retired }, "ui.clipboard")).toMatchObject({
    ok: true,
  });
  live = false;
  await expect(native.copyText(retired, "retired")).rejects.toThrow("Stale");
  expect(copy).toHaveBeenCalledExactlyOnceWith("copied");
  expect(choose).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});
import { UserPersistenceActions } from "./user-persistence-actions.js";
it.each(["1.7.0+build.1", "1.8.0-beta.1"])(
  "accepts negotiated semver %s at or above 1.7",
  async (version) => {
    const f = routes170();
    f.api(version);
    try {
      await expect(f.client.request("settings/read", { schemaVersion: 1 })).resolves.toMatchObject({
        ok: false,
      });
      expect(f.calls).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);

it.each(["malformed", "missing", "oversize", "invalid"])(
  "isolates %s optional settings at startup and refresh while healthy settings and recovery remain available",
  async (kind) => {
    const f = await compositionInput();
    const bad = staticSource170(
      "test.bad",
      kind === "malformed"
        ? "{bad"
        : kind === "oversize"
          ? " ".repeat(65537)
          : kind === "invalid"
            ? "{}"
            : settingsRaw170,
    );
    if (kind === "missing") bad.resources = {};
    f.input.plugins.builtins = [bad, staticSource170()];
    let composition: DesktopMainComposition | undefined;
    try {
      composition = await composeDesktopMain(f.input, {
        worker: { entry: testWorkerEntry170, control: () => {} },
      });
      const settings = composition.plugins.persistence170!.settings;
      const resourceDigest = createHash("sha256").update(settingsRaw170).digest("hex");
      const open = () =>
        settings.open({
          sourceKey: "builtin:test.settings",
          resourceDigest,
          scope: f.input.scope(),
        });
      expect((await open()).snapshot.values).toEqual([{ key: "device.choice", value: 1 }]);
      expect(f.input.report).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("builtin:test.bad") }),
      );
      expect(
        desktopFoundationTestHandles(composition).host.participant.recoverySnapshot(),
      ).toBeDefined();
      await expect(
        settings.open({ sourceKey: "builtin:test.bad", resourceDigest, scope: f.input.scope() }),
      ).rejects.toThrow("not admitted");
      await composition.plugins.setEnabled("builtin:test.bad", false);
      await composition.plugins.setEnabled("builtin:test.bad", true);
      await vi.waitFor(() => expect(f.input.report).toHaveBeenCalledTimes(2));
      expect((await open()).snapshot.values).toEqual([{ key: "device.choice", value: 1 }]);
    } finally {
      await composition?.dispose();
      await f.cleanup();
    }
  },
);

it.each(["disable", "removal", "reload"])(
  "source %s gets a new form lifetime while retaining actual backend ownership",
  async (kind) => {
    const sources = createPersistenceSources170({
      currentScope: () => true,
      currentRuntime: () => false,
      beforeDelivery: () => {},
    });
    const owner = {
      sourceKey: "builtin:test.settings",
      pluginId: "test.settings",
      uiResourceGeneration: 7,
    };
    const scope = { hostEpoch: h170, workbenchInstance: h170 };
    const document = {
      value: JSON.parse(settingsRaw170),
      bytes: Buffer.byteLength(settingsRaw170),
      digest: "a".repeat(64),
    };
    const first = sources.admit({ owner, eligible: true, document })!;
    if (kind === "disable")
      sources.reconcileSources([
        {
          owner: { ...owner, generation: 7, hostEpoch: h170, processEpoch: h170 },
          eligible: false,
        },
      ]);
    else if (kind === "removal") sources.reconcileSources([]);
    else owner.uiResourceGeneration++;
    const fresh = sources.admit({ owner, eligible: true, document })!;
    expect(fresh.owner.uiResourceGeneration).toBeGreaterThan(first.owner.uiResourceGeneration);
    expect(
      (await sources.port.settings({
        sourceKey: owner.sourceKey,
        resourceDigest: document.digest,
      }))!.owner,
    ).toEqual(fresh.owner);
    expect(sources.port.coreOwner({ sourceKey: owner.sourceKey, scope })!.generation).toBe(
      owner.uiResourceGeneration,
    );
    expect(sources.admit({ owner, eligible: true, document })!.owner).toEqual(fresh.owner);
  },
);

import * as staticResources170 from "@kobrixa/plugin-runtime";
it("disabling an optional source during an asynchronous resource read prevents late readmission", async () => {
  const f = await compositionInput();
  const directory = await pluginFolder("async-settings");
  const manifestPath = path.join(directory, "kobrixa-plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.apiVersion = "^1.7.0";
  manifest.permissions = ["settings.read", "settings.write"];
  manifest.contributes.settings = { version: 1, path: "settings.json" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(directory, "settings.json"), settingsRaw170);
  f.input.plugins.commandLine.developmentDirectories = [directory];
  f.input.plugins.builtins = [staticSource170()];
  const composition = await composeDesktopMain(f.input, {
    worker: { entry: testWorkerEntry170, control: () => {} },
  });
  const sourceKey = developmentSourceKey(await realpath(directory));
  const read = staticResources170.readPackagedJson;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const heldRead = vi
    .spyOn(staticResources170, "readPackagedJson")
    .mockImplementation(async (...args) => {
      await gate;
      return read(...args);
    });
  try {
    await composition.plugins.setEnabled(sourceKey, false);
    await composition.plugins.setEnabled(sourceKey, true);
    await vi.waitFor(() => expect(heldRead).toHaveBeenCalled());
    await composition.plugins.setEnabled(sourceKey, false);
    release();
    // A later healthy-source exchange is queued behind the held read and its stale completion.
    await composition.plugins.setEnabled("builtin:test.settings", false);
    await composition.plugins.setEnabled("builtin:test.settings", true);
    const settings = composition.plugins.persistence170!.settings;
    const resourceDigest = createHash("sha256").update(settingsRaw170).digest("hex");
    await vi.waitFor(async () =>
      expect(
        (
          await settings.open({
            sourceKey: "builtin:test.settings",
            resourceDigest,
            scope: f.input.scope(),
          })
        ).snapshot.values,
      ).toHaveLength(1),
    );
    await expect(
      settings.open({ sourceKey, resourceDigest, scope: f.input.scope() }),
    ).rejects.toThrow("not admitted");
  } finally {
    release();
    await composition.dispose();
    await f.cleanup();
  }
});
