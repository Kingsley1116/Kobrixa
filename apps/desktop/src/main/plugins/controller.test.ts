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
  PluginError,
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
  const key = "dev:0123456789abcdef";
  const snapshot: PluginsSnapshot = {
    revision: 4,
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
  function setup() {
    let listener: (event: PluginManagerEvent) => void = () => {};
    const manager = {
      active: false,
      state: () => snapshot,
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
    const marker = { update: vi.fn(), finish: vi.fn() };
    let document: PluginStateDocument = {
      schemaVersion: 2,
      developerMode: true,
      sources: [],
      disabled: [],
      legacyDisabledIds: [],
    };
    const controller = new PluginController({
      manager: manager as unknown as PluginManagerPort,
      settings: {
        settings: () => document,
        update: async (change) => {
          document = change(document);
        },
      },
      dialogs: fakeDialogs(),
      logs: new PluginLogs(),
      notices: new PluginNotices(),
      marker,
      probe: async () => usable,
      realpath: async (directory) => directory,
      locale: "en",
      platform: "linux",
      session: { directories: [], safeMode: false },
    });
    return { controller, manager, marker, emit: (event: PluginManagerEvent) => listener(event) };
  }

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
});
