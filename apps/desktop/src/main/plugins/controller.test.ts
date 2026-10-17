import { readFileSync } from "node:fs";
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  startPlugins,
  type PluginManagerPort,
  type StartPluginsOptions,
} from "./controller.js";
import { PluginLogs, PluginNotices } from "./logs.js";
import type { PluginStateDocument } from "./state-store.js";

vi.mock("electron", () => ({ utilityProcess: {}, MessageChannelMain: class {} }));

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
    "ignores renderer hangs without development sources (developer mode: %s)",
    async (developerMode) => {
      const controller = await enabled();
      await controller.setDeveloperMode(developerMode);
      controller.markRendererUnresponsive();
      const marker = JSON.parse(
        await readFile(path.join(userData, "plugins/session.json"), "utf8"),
      );
      expect.soft(marker.rendererUnresponsive).toBe(false);
      controller.finishSession();
      const restarted = await start();
      expect.soft(restarted.state().safeMode).toBe(false);
      expect.soft(restarted.state().safeModeLock).toBeUndefined();
      expect((await saved()).safeModeLock).toBeUndefined();
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
    expect(controller.reportLanguageRegistrationFailure(report(0))).toEqual({
      accepted: false,
      revision: 1,
    });
    expect(controller.reportLanguageRegistrationFailure(report(2))).toEqual({
      accepted: false,
      revision: 1,
    });
    manager.reportLanguageRegistrationFailure.mockImplementation(() => {
      publishCatalog(catalog(2, [bp]));
      return { accepted: true, revision: 2 };
    });
    expect(controller.reportLanguageRegistrationFailure(report())).toEqual({
      accepted: true,
      revision: 2,
    });
    expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(report());
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
      // Simulate T2's single host transaction: quarantine this contribution, append
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
      // The runtime receives inert source descriptors for the recovery UI. T2 owns
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
