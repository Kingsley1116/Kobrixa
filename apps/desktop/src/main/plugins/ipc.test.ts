import { expect, it, vi } from "vitest";
import type { IpcHandle } from "../ipc.js";
import { registerPluginIpc, type PluginIpcTarget } from "./ipc.js";

import { emptyStaticLanguagesCatalog } from "@kobrixa/plugin-runtime";
import type { ReportLanguageRegistrationFailureInput } from "../../shared/static-languages.js";
import { registerIpc } from "../ipc.js";
import { registerCoreRecoveryIpc } from "./ipc.js";
import { registerUiIpc, trustedWorkbench } from "./ui-bridge.js";
import type { CoreRecoveryPort, PluginUiBridge } from "@kobrixa/plugin-runtime";

const electronHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, action: (event: unknown, ...args: unknown[]) => unknown) =>
      electronHandlers.set(channel, action),
  },
}));

const key = "dev:0123456789abcdef";
it("UI and recovery routes use the actual trusted wrapper and reject renderer-minted authority", async () => {
  electronHandlers.clear();
  const renderer = { id: 4, mainFrame: {} };
  const invoke = vi.fn<PluginUiBridge["invoke"]>(async () => ({
    ok: true,
    value: { output: {}, fieldErrors: [] },
  }));
  const bridge = { invoke } as Pick<PluginUiBridge, "invoke"> as PluginUiBridge;
  const snapshot = {
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    items: [],
    nextCursor: null,
  };
  const recovery: CoreRecoveryPort = {
    snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    act: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    onChanged: () => () => {},
  };
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { run: (_channel: string, work: () => unknown) => work() } as never,
    undefined,
    undefined,
    undefined,
    [
      (handle) => {
        registerUiIpc({ handle, bridge, trusted: (event) => trustedWorkbench(event, renderer) });
        registerCoreRecoveryIpc(handle, recovery, () => {});
      },
    ],
  );
  const trusted = { sender: renderer, senderFrame: renderer.mainFrame };
  for (const channel of [
    "plugins:ui:invoke",
    "plugins:recovery:act",
    "plugins:recovery:snapshot",
  ]) {
    for (const event of [
      { ...trusted, sender: { id: 7 } },
      { ...trusted, senderFrame: {} },
    ])
      expect(() => electronHandlers.get(channel)!(event, {})).toThrow("untrusted");
  }
  const act = electronHandlers.get("plugins:recovery:act")!;
  const selection = {
    itemId: snapshot.hostEpoch,
    actionId: "00000000-0000-4000-8000-000000000002",
  };
  expect(() => act(trusted, { ...selection, actionToken: "forged" })).toThrow();
  expect(() => act(trusted, { ...selection, itemId: "device:foreign" })).toThrow();
  expect(recovery.act).not.toHaveBeenCalled();
  expect(await act(trusted, selection)).toEqual({ ok: true, value: snapshot });
  expect(recovery.act).toHaveBeenCalledExactlyOnceWith(selection);
  expect(
    await electronHandlers.get("plugins:ui:invoke")!(trusted, { ...selection, owner: "forged" }),
  ).toMatchObject({ ok: false });
  expect(invoke).not.toHaveBeenCalled();
});
function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const handle = ((channel, action) => handlers.set(channel, action as never)) as IpcHandle;
  const ok = async () => ({ ok: true }) as never;
  const plugins = {
    state: vi.fn(() => ({
      revision: 0,
      diagnosticHelpRevision: 0,
      staticLanguagesRevision: 7,
      staticLanguageOwners: [],
      safeMode: false,
      developmentMode: false,
      plugins: [],
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    })),
    diagnosticHelp: vi.fn(() => ({ revision: 0, plugins: {} })),
    staticLanguages: vi.fn(() => emptyStaticLanguagesCatalog(7)),
    reportLanguageRegistrationFailure: vi.fn<PluginIpcTarget["reportLanguageRegistrationFailure"]>(
      () => ({ accepted: false, revision: 7 }),
    ),
    notices: vi.fn(() => []),
    execute: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(),
    setEnabled: vi.fn(ok),
    setDeveloperMode: vi.fn(ok),
    linkFolder: vi.fn(ok),
    relinkFolder: vi.fn(ok),
    unlink: vi.fn(ok),
    reload: vi.fn(ok),
    pythonCandidates: vi.fn(async () => []),
    setPython: vi.fn(ok),
    readLog: vi.fn(() => ({ lines: [], next: 0, truncated: false })),
    clearSafeModeLock: vi.fn(ok),
    onEvent: vi.fn(() => () => {}),
  } satisfies PluginIpcTarget;
  const publish = vi.fn();
  registerPluginIpc(handle, plugins, publish);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { handlers, plugins, publish, call };
}

it("registers every plugin channel and forwards events", () => {
  const { handlers, plugins, publish } = setup();
  expect([...handlers.keys()].sort()).toEqual(
    [
      "plugins:state",
      "plugins:diagnosticHelp",
      "plugins:static-languages",
      "plugins:report-language-registration-failure",
      "plugins:notices",
      "plugins:execute",
      "plugins:cancel",
      "plugins:set-enabled",
      "plugins:setDeveloperMode",
      "plugins:linkFolder",
      "plugins:relinkFolder",
      "plugins:unlink",
      "plugins:reload",
      "plugins:pythonCandidates",
      "plugins:setPython",
      "plugins:readLog",
      "plugins:clearSafeModeLock",
    ].sort(),
  );
  expect(plugins.onEvent).toHaveBeenCalledWith(publish);
});

it.each(["acme.hello", "dev:../../etc"])(
  "rejects bad source key %s for enabling and reading logs before calling the controller",
  (sourceKey) => {
    const { plugins, call } = setup();
    expect.soft(() => call("plugins:set-enabled", sourceKey, true)).toThrow();
    expect.soft(() => call("plugins:readLog", sourceKey, 0)).toThrow();
    expect.soft(plugins.setEnabled).not.toHaveBeenCalled();
    expect(plugins.readLog).not.toHaveBeenCalled();
  },
);

it("validates every renderer argument before it reaches the controller", async () => {
  const { plugins, call } = setup();
  expect(await call("plugins:execute", "acme.hello.greet")).toEqual({ ok: true });
  expect(() => call("plugins:execute", "../../etc")).toThrow();
  for (const channel of [
    "plugins:cancel",
    "plugins:relinkFolder",
    "plugins:unlink",
    "plugins:reload",
  ]) {
    expect(() => call(channel, "/Users/me/plugin")).toThrow();
    expect(() => call(channel, "dev:../../etc")).toThrow();
    await call(channel, key);
  }
  expect(plugins.reload).toHaveBeenCalledWith(key);
  expect(() => call("plugins:set-enabled", key, "yes")).toThrow();
  expect(() => call("plugins:setDeveloperMode", "true")).toThrow();
  await call("plugins:setDeveloperMode", true);
  expect(plugins.setDeveloperMode).toHaveBeenCalledWith(true);
  expect(() => call("plugins:setPython", "/usr/bin/python3")).toThrow();
  await call("plugins:setPython", "other");
  expect(plugins.setPython).toHaveBeenCalledWith("other");
  expect(() => call("plugins:readLog", key, -1)).toThrow();
  expect(() => call("plugins:readLog", key, 1.5)).toThrow();
  await call("plugins:readLog", key, 3);
  expect(plugins.readLog).toHaveBeenCalledWith(key, 3);
  // Channels without arguments ignore anything the renderer adds.
  await call("plugins:linkFolder", "/etc");
  expect(plugins.linkFolder).toHaveBeenCalledWith();
});

it("forwards the diagnostic help catalog", () => {
  const { plugins, call } = setup();
  expect(call("plugins:diagnosticHelp")).toEqual({ revision: 0, plugins: {} });
  expect(plugins.diagnosticHelp).toHaveBeenCalledOnce();
});

const registrationFailure = (): ReportLanguageRegistrationFailureInput => ({
  sourceKey: key,
  generation: 2,
  languageId: "toy",
  revision: 7,
  reason: "adapter",
  detail: "The validated language could not be adapted.",
});

it("forwards the current static catalog and all five allowed report reasons", () => {
  const { plugins, call } = setup();
  expect(call("plugins:static-languages")).toEqual(emptyStaticLanguagesCatalog(7));
  expect(plugins.staticLanguages).toHaveBeenCalledOnce();
  for (const reason of [
    "dto-version",
    "validation",
    "adapter",
    "monaco",
    "session-language-ids",
  ] as const) {
    const input = { ...registrationFailure(), reason };
    expect(call("plugins:report-language-registration-failure", input)).toEqual({
      accepted: false,
      revision: 7,
    });
    expect(plugins.reportLanguageRegistrationFailure).toHaveBeenLastCalledWith(input);
  }
});

it("rejects malformed reports, physical paths and extra fields before the controller", () => {
  const { plugins, call } = setup();
  for (const input of [
    null,
    [],
    { ...registrationFailure(), sourceKey: "dev:../../etc" },
    { ...registrationFailure(), sourceKey: "/tmp/plugin" },
    { ...registrationFailure(), languageId: "TOY" },
    { ...registrationFailure(), generation: -1 },
    { ...registrationFailure(), generation: 1.5 },
    { ...registrationFailure(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...registrationFailure(), revision: -1 },
    { ...registrationFailure(), revision: Infinity },
    { ...registrationFailure(), reason: "reload" },
    { ...registrationFailure(), detail: { message: "bad" } },
    { ...registrationFailure(), detail: "a".repeat(2049) },
    { ...registrationFailure(), detail: "😀".repeat(2049) },
    { ...registrationFailure(), detail: "/Users/me/plugin/language.json" },
    { ...registrationFailure(), detail: "Failed at C:\\plugins\\language.json" },
    { ...registrationFailure(), detail: "Failed at \\\\server\\plugin\\language.json" },
    { ...registrationFailure(), detail: "Failed at file:///tmp/language.json" },
    { ...registrationFailure(), resourcePath: "/tmp/language.json" },
    { ...registrationFailure(), pluginId: "acme.forged" },
  ])
    expect(() => call("plugins:report-language-registration-failure", input)).toThrow();
  expect(plugins.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
});

it("counts report detail in decoded code points and accepts the exact boundary", () => {
  const { plugins, call } = setup();
  for (const detail of ["", "a".repeat(2048), "😀".repeat(2048)]) {
    const input = { ...registrationFailure(), detail };
    call("plugins:report-language-registration-failure", input);
    expect(plugins.reportLanguageRegistrationFailure).toHaveBeenLastCalledWith(input);
  }
});

it("uses the real trusted-sender wrapper for catalog and registration-report channels", () => {
  const { plugins } = setup();
  electronHandlers.clear();
  const renderer = { id: 4, mainFrame: {} };
  let available = true;
  registerIpc(
    () => (available ? (renderer as never) : undefined),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { run: (_channel: string, work: () => unknown) => work() } as never,
    () => {},
    () => {},
    undefined,
    [(handle) => registerPluginIpc(handle, plugins, () => {})],
  );
  const trusted = { sender: renderer, senderFrame: renderer.mainFrame };
  for (const channel of [
    "plugins:static-languages",
    "plugins:report-language-registration-failure",
  ]) {
    const handler = electronHandlers.get(channel)!;
    for (const event of [
      { ...trusted, sender: { id: 99 } },
      { ...trusted, senderFrame: {} },
    ])
      expect(() => handler(event, registrationFailure())).toThrow("untrusted");
    available = false;
    expect(() => handler(trusted, registrationFailure())).toThrow("untrusted");
    available = true;
  }
  expect(plugins.staticLanguages).not.toHaveBeenCalled();
  expect(plugins.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  expect(electronHandlers.get("plugins:static-languages")!(trusted)).toEqual(
    emptyStaticLanguagesCatalog(7),
  );
  electronHandlers.get("plugins:report-language-registration-failure")!(
    trusted,
    registrationFailure(),
  );
  expect(plugins.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(
    registrationFailure(),
  );
});

import {
  bindSettingsBridge,
  registerSettingsIpc170,
  registerPersistenceRecoveryIpc170,
} from "./ipc.js";
import type { BoundSettingsService, SettingsFormBinding } from "@kobrixa/plugin-runtime";
import type { PluginsApi } from "../../shared/plugins.js";
function settingsBridgeFixture170() {
  let scope = {
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    workbenchInstance: "00000000-0000-4000-8000-000000000002",
  };
  const binding: SettingsFormBinding = {
    owner: {
      sourceKey: "builtin:test.settings",
      pluginId: "test.settings",
      uiResourceGeneration: 1,
    },
    scope: { ...scope },
    resourceDigest: "a".repeat(64),
  };
  const snapshot = {
    schemaVersion: 1,
    revision: null,
    values: [{ key: "device.choice", value: 1 }],
  };
  const resource = {
    schemaVersion: 1,
    title: { en: "Settings" },
    fields: [
      {
        key: "device.choice",
        label: { en: "Choice" },
        type: "enum" as const,
        default: 1,
        options: [
          { value: 1, label: { en: "Number" } },
          { value: "1", label: { en: "String" } },
        ],
      },
    ],
  };
  let notify = () => {};
  const off = vi.fn();
  const service: BoundSettingsService = {
    open: vi.fn(async () => ({ binding, resource, snapshot })),
    read: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    update: vi.fn(async () => ({
      ok: false as const,
      error: { code: "PLUGIN_E_SETTINGS_CONFLICT" as const, message: "Conflict" },
    })),
    reset: vi.fn(async () => ({
      ok: false as const,
      error: { code: "PLUGIN_E_SETTINGS_CONFLICT" as const, message: "Conflict" },
    })),
    watch: vi.fn((_binding, listener) => {
      notify = listener;
      return off;
    }),
    dispose: vi.fn(),
  };
  const api = bindSettingsBridge(service, () => scope);
  return {
    binding,
    service,
    api,
    off,
    notify: () => notify(),
    open: () =>
      api.open({ sourceKey: binding.owner.sourceKey, resourceDigest: binding.resourceDigest }),
    replaceWindow: () => {
      scope = { ...scope, workbenchInstance: "00000000-0000-4000-8000-000000000003" };
    },
  };
}
it("opens data-only settings once and retains scalar types and dotted keys", async () => {
  const f = settingsBridgeFixture170();
  const opened = await f.open();
  expect(opened.resource.fields[0]).toMatchObject({
    key: "device.choice",
    options: [{ value: 1 }, { value: "1" }],
  });
  expect(f.service.open).toHaveBeenCalledExactlyOnceWith({
    sourceKey: f.binding.owner.sourceKey,
    resourceDigest: f.binding.resourceDigest,
    scope: f.binding.scope,
  });
  await expect(
    f.api.update(f.binding, {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "device.choice", value: "1" }],
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT" } });
  expect(f.service.update).toHaveBeenCalledWith(f.binding, {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "device.choice", value: "1" }],
  });
  f.api.dispose(f.binding);
});
it("rejects every changed binding field and stops watches on window change", async () => {
  const f = settingsBridgeFixture170();
  await f.open();
  const changed = vi.fn();
  f.api.watch(f.binding, changed);
  const variants: SettingsFormBinding[] = [
    { ...f.binding, resourceDigest: "b".repeat(64) },
    { ...f.binding, owner: { ...f.binding.owner, sourceKey: "builtin:other" } },
    { ...f.binding, owner: { ...f.binding.owner, pluginId: "test.other" } },
    { ...f.binding, owner: { ...f.binding.owner, uiResourceGeneration: 2 } },
    {
      ...f.binding,
      scope: { ...f.binding.scope, hostEpoch: "00000000-0000-4000-8000-000000000004" },
    },
    {
      ...f.binding,
      scope: { ...f.binding.scope, workbenchInstance: "00000000-0000-4000-8000-000000000004" },
    },
  ];
  for (const binding of variants) {
    await expect(f.api.read(binding)).rejects.toThrow("Stale");
    await expect(
      f.api.update(binding, { schemaVersion: 1, expectedRevision: null, changes: [] }),
    ).rejects.toThrow("Stale");
    await expect(
      f.api.reset(binding, { schemaVersion: 1, expectedRevision: null, keys: [] }),
    ).rejects.toThrow("Stale");
    expect(() => f.api.watch(binding, changed)).toThrow("Stale");
    expect(() => f.api.dispose(binding)).toThrow("Stale");
  }
  f.notify();
  expect(changed).toHaveBeenCalledOnce();
  f.replaceWindow();
  f.notify();
  expect(changed).toHaveBeenCalledOnce();
  expect(f.off).toHaveBeenCalledOnce();
  expect(f.service.dispose).toHaveBeenCalledOnce();
});
it("disposes a late open from the old generation without replacing the new form", async () => {
  const f = settingsBridgeFixture170();
  let release!: (value: Awaited<ReturnType<BoundSettingsService["open"]>>) => void;
  const original = await f.service.open({
    sourceKey: f.binding.owner.sourceKey,
    resourceDigest: f.binding.resourceDigest,
    scope: f.binding.scope,
  });
  vi.mocked(f.service.open).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const old = f.open();
  const rejected = expect(old).rejects.toThrow("Stale");
  await Promise.resolve();
  const newer = f.open();
  release({ ...original, binding: { ...original.binding, resourceDigest: "b".repeat(64) } });
  await rejected;
  const current = await newer;
  await expect(f.api.read(current.binding)).resolves.toMatchObject({ ok: true });
  expect(f.service.dispose).toHaveBeenCalledOnce();
  f.api.dispose(current.binding);
});
it("disposes a late open after navigation and ignores a late read", async () => {
  const f = settingsBridgeFixture170();
  await f.open();
  let release!: (value: Awaited<ReturnType<BoundSettingsService["read"]>>) => void;
  vi.mocked(f.service.read).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const read = f.api.read(f.binding);
  const rejected = expect(read).rejects.toThrow("Stale");
  f.replaceWindow();
  release({ ok: true, value: { schemaVersion: 1, revision: null, values: [] } });
  await rejected;
  expect(f.service.dispose).toHaveBeenCalledOnce();
});

function ipcHandlers170() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const handle: IpcHandle = <T extends unknown[], R>(
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: T) => R,
  ) => {
    handlers.set(name, (event, ...args) => action(event, ...(args as T)));
  };
  const invoke = async (name: string, ...args: unknown[]) => {
    const action = handlers.get(name);
    if (!action) throw new Error("Missing dedicated handler");
    return action({} as IpcMainInvokeEvent, ...args);
  };
  return { handle, invoke, handlers };
}
it("dedicated settings IPC validates inputs and an old unwatch cannot cancel the replacement", async () => {
  const f = settingsBridgeFixture170(),
    ipc = ipcHandlers170(),
    publish = vi.fn();
  const dispose = registerSettingsIpc170({
    handle: ipc.handle,
    service: f.service,
    scope: () => f.binding.scope,
    publish,
  });
  try {
    await ipc.invoke("plugins:settings:open", {
      sourceKey: f.binding.owner.sourceKey,
      resourceDigest: f.binding.resourceDigest,
    });
    await ipc.invoke("plugins:settings:watch", { binding: f.binding, watch: 1 });
    await ipc.invoke("plugins:settings:watch", { binding: f.binding, watch: 2 });
    await ipc.invoke("plugins:settings:unwatch", { binding: f.binding, watch: 1 });
    f.notify();
    expect(publish).toHaveBeenCalledWith(f.binding.scope, "plugins:settings:changed", {
      binding: f.binding,
      watch: 2,
    });
    expect(f.off).toHaveBeenCalledTimes(1);
    await expect(
      ipc.invoke("plugins:settings:update", f.binding, {
        schemaVersion: 1,
        expectedRevision: null,
        changes: [],
        scope: f.binding.scope,
      }),
    ).rejects.toThrow();
    expect(f.service.update).not.toHaveBeenCalled();
    expect([...ipc.handlers.keys()].sort()).toEqual([
      "plugins:settings:dispose",
      "plugins:settings:open",
      "plugins:settings:read",
      "plugins:settings:reset",
      "plugins:settings:unwatch",
      "plugins:settings:update",
      "plugins:settings:watch",
    ]);
    await ipc.invoke("plugins:settings:dispose", f.binding);
    expect(f.service.dispose).toHaveBeenCalledOnce();
  } finally {
    dispose();
  }
});

it("recovery IPC rejects replaced windows and removes both subscriptions exactly once", async () => {
  const ipc = ipcHandlers170();
  let scope = {
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    workbenchInstance: "00000000-0000-4000-8000-000000000002",
  };
  const offOpen = vi.fn(),
    offChanged = vi.fn();
  let open: (value: { itemId: string }) => void = () => {};
  const bridge: PluginsApi["persistenceRecovery"] = {
    snapshot: vi.fn(async () => ({ ok: true as const, value: { revision: 0, items: [] } })),
    act: vi.fn(async () => ({ ok: true as const, value: { revision: 0, items: [] } })),
    onOpen: (listener) => {
      open = listener;
      return offOpen;
    },
    onChanged: () => offChanged,
  };
  const publish = vi.fn();
  const dispose = registerPersistenceRecoveryIpc170({
    handle: ipc.handle,
    bridge,
    scope: () => scope,
    publish,
  });
  await ipc.invoke("plugins:persistence-recovery:subscribe");
  const itemId = "00000000-0000-4000-8000-000000000003";
  open({ itemId });
  expect(publish).toHaveBeenCalledOnce();
  scope = { ...scope, workbenchInstance: "00000000-0000-4000-8000-000000000004" };
  open({ itemId });
  expect(publish).toHaveBeenCalledOnce();
  await expect(ipc.invoke("plugins:persistence-recovery:snapshot", { itemId })).rejects.toThrow(
    "Stale",
  );
  expect(bridge.snapshot).not.toHaveBeenCalled();
  dispose();
  dispose();
  expect(offOpen).toHaveBeenCalledOnce();
  expect(offChanged).toHaveBeenCalledOnce();
});

import type { IpcMainInvokeEvent } from "electron";
it("settings IPC disposes an in-flight open after retirement even when scope lookup now throws", async () => {
  const f = settingsBridgeFixture170(),
    ipc = ipcHandlers170();
  const opened = await f.service.open({
    sourceKey: f.binding.owner.sourceKey,
    resourceDigest: f.binding.resourceDigest,
    scope: f.binding.scope,
  });
  let finish!: (value: typeof opened) => void,
    live = true;
  vi.mocked(f.service.open).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const dispose = registerSettingsIpc170({
    handle: ipc.handle,
    service: f.service,
    scope: () => {
      if (!live) throw new Error("No workbench");
      return f.binding.scope;
    },
    publish: vi.fn(),
  });
  const opening = ipc.invoke("plugins:settings:open", {
    sourceKey: f.binding.owner.sourceKey,
    resourceDigest: f.binding.resourceDigest,
  });
  const rejected = expect(opening).rejects.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  live = false;
  dispose();
  finish(opened);
  await rejected;
  expect(f.service.dispose).toHaveBeenCalledExactlyOnceWith(opened.binding);
});
it("a forged settings watch cannot remove the original subscription", async () => {
  const f = settingsBridgeFixture170(),
    ipc = ipcHandlers170();
  const publish = vi.fn();
  const dispose = registerSettingsIpc170({
    handle: ipc.handle,
    service: f.service,
    scope: () => f.binding.scope,
    publish,
  });
  try {
    await ipc.invoke("plugins:settings:open", {
      sourceKey: f.binding.owner.sourceKey,
      resourceDigest: f.binding.resourceDigest,
    });
    await ipc.invoke("plugins:settings:watch", { binding: f.binding, watch: 1 });
    await expect(
      ipc.invoke("plugins:settings:watch", {
        binding: { ...f.binding, resourceDigest: "b".repeat(64) },
        watch: 2,
      }),
    ).rejects.toThrow("Stale");
    f.notify();
    expect(publish).toHaveBeenCalledWith(f.binding.scope, "plugins:settings:changed", {
      binding: f.binding,
      watch: 1,
    });
    expect(f.off).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
it("invalid settings open leaves the issued form and its watch intact", async () => {
  const f = settingsBridgeFixture170(),
    ipc = ipcHandlers170(),
    publish = vi.fn();
  const dispose = registerSettingsIpc170({
    handle: ipc.handle,
    service: f.service,
    scope: () => f.binding.scope,
    publish,
  });
  try {
    await ipc.invoke("plugins:settings:open", {
      sourceKey: f.binding.owner.sourceKey,
      resourceDigest: f.binding.resourceDigest,
    });
    await ipc.invoke("plugins:settings:watch", { binding: f.binding, watch: 1 });
    await expect(
      ipc.invoke("plugins:settings:open", {
        sourceKey: f.binding.owner.sourceKey,
        resourceDigest: f.binding.resourceDigest,
        scope: f.binding.scope,
      }),
    ).rejects.toThrow();
    f.notify();
    expect(publish).toHaveBeenCalledOnce();
    expect(f.off).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
