import { beforeEach, expect, it, vi } from "vitest";
import type { KobrixaApi } from "../shared/api.js";
import type { PluginEvent } from "../shared/plugins.js";
import type {
  ReportLanguageRegistrationFailureInput,
  StaticLanguagesCatalog,
} from "../shared/static-languages.js";

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: KobrixaApi) => void>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));
let api: KobrixaApi;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  await import("./index.js");
  expect(electron.expose).toHaveBeenCalledOnce();
  expect(electron.expose.mock.calls[0]![0]).toBe("kobrixa");
  api = electron.expose.mock.calls[0]![1];
});

it("returns the catalog promise through the frozen channel without transforming its DTO", async () => {
  const value: StaticLanguagesCatalog = {
    formatVersion: 1,
    limitsVersion: 1,
    revision: 9,
    languages: [],
    extensionRoutes: { toy: null },
    conflicts: [],
  };
  electron.invoke.mockResolvedValueOnce(value);
  await expect(api.plugins.staticLanguages()).resolves.toBe(value);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("plugins:static-languages");
});

it("forwards the exact report and returns its accepted/revision result", async () => {
  const input: ReportLanguageRegistrationFailureInput = {
    sourceKey: "dev:0123456789abcdef",
    generation: 3,
    languageId: "toy",
    revision: 9,
    reason: "validation",
    detail: "The language failed defensive validation.",
  };
  electron.invoke.mockResolvedValueOnce({ accepted: true, revision: 10 });
  await expect(api.plugins.reportLanguageRegistrationFailure(input)).resolves.toEqual({
    accepted: true,
    revision: 10,
  });
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
    "plugins:report-language-registration-failure",
    input,
  );
});

it("keeps the state revision and full owners on plugins:event and unsubscribes exactly once", () => {
  const listener = vi.fn<(event: PluginEvent) => void>();
  const off = api.plugins.onEvent(listener);
  expect(electron.on).toHaveBeenCalledOnce();
  const [channel, handler] = electron.on.mock.calls[0]!;
  expect(channel).toBe("plugins:event");
  const event: PluginEvent = {
    type: "state",
    state: {
      revision: 4,
      diagnosticHelpRevision: 0,
      staticLanguagesRevision: 9,
      staticLanguageOwners: [
        {
          pluginId: "acme.toy",
          sourceKey: "dev:0123456789abcdef",
          generation: 3,
          languageId: "toy",
          extensions: ["toy", "shared"],
        },
      ],
      safeMode: false,
      developmentMode: true,
      plugins: [],
      developer: { enabled: true, commandLine: true, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    },
  };
  handler({}, event);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  off();
  expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith("plugins:event", handler);
});

it("preserves IPC rejection so renderer bootstrap can choose its plaintext fallback", async () => {
  electron.invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
  await expect(api.plugins.staticLanguages()).rejects.toThrow("IPC unavailable");
});

it("uses the narrow authority-report bridge without adding a raw device RPC escape hatch", async () => {
  const report = {
    document: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    state: "local" as const,
    roomId: null,
    connected: true,
    synced: true,
    role: null,
    isHolder: true,
  };
  electron.invoke.mockResolvedValueOnce({ document: report.document });
  await expect(api.collab.deviceControlContext()).resolves.toEqual({ document: report.document });
  await api.collab.setDeviceControl(report);
  expect(electron.invoke.mock.calls).toEqual([
    ["collab:device-control-context"],
    ["collab:set-device-control", report],
  ]);
  expect(Object.hasOwn(api.device, "request")).toBe(false);
  expect(Object.hasOwn(api.plugins, "storage")).toBe(false);
  expect(Object.hasOwn(api.plugins.ui, "request")).toBe(false);
});

it("forwards explicit file renewal on the exact channel", async () => {
  const ref = { sessionId: "session", requestId: "request", planId: "plan" };
  await api.device.renewFiles(ref);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("device:files-renew", ref);
});

it("forwards UI requests without accepting principal, context, tokens or native paths", async () => {
  const value = {
    sourceKey: "builtin:acme.fixture",
    id: "acme.fixture.panel",
    uiResourceGeneration: 1,
  };
  electron.invoke.mockResolvedValueOnce({
    ok: false,
    error: { code: "PLUGIN_E_STALE_RESOURCE", message: "stale" },
  });
  await api.plugins.ui.open(value);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("plugins:ui:open", value);
  expect(api.plugins.ui).not.toHaveProperty("mint");
  expect(api.plugins.ui).not.toHaveProperty("setOwner");
});
it("subscribes to UI changes and removes precisely its handler", () => {
  const callback = vi.fn();
  const off = api.plugins.ui.onEvent(callback);
  const [channel, handler] = electron.on.mock.calls[0]!;
  expect(channel).toBe("plugins:ui:event:1");
  const event = { type: "catalog", hostEpoch: "host", revision: 2, owners: [] };
  handler({}, event);
  expect(callback).toHaveBeenCalledExactlyOnceWith(event);
  off();
  expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler);
});
it("gives each UI listener its own replay stream and independent teardown", () => {
  const first = vi.fn(),
    second = vi.fn();
  const offFirst = api.plugins.ui.onEvent(first);
  const offSecond = api.plugins.ui.onEvent(second);
  expect(electron.invoke.mock.calls).toEqual([
    ["plugins:ui:subscribe", 1],
    ["plugins:ui:subscribe", 2],
  ]);
  const [channelFirst] = electron.on.mock.calls[0]!;
  const [channelSecond, receiveSecond] = electron.on.mock.calls[1]!;
  expect(channelFirst).not.toBe(channelSecond);
  const replay = { type: "catalog", hostEpoch: "host", revision: 3, owners: [] };
  receiveSecond({}, replay);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledExactlyOnceWith(replay);
  offFirst();
  offFirst();
  offSecond();
  expect(electron.invoke.mock.calls.slice(2)).toEqual([
    ["plugins:ui:unsubscribe", 1],
    ["plugins:ui:unsubscribe", 2],
  ]);
});
it("core act sends option identifiers, never a renderer-supplied CoreActionReference", async () => {
  await api.plugins.recovery.act({ itemId: "item", actionId: "option" });
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("plugins:recovery:act", {
    itemId: "item",
    actionId: "option",
  });
});
it("preserves main-admitted resource metadata without renderer inference", async () => {
  const input = {
    sourceKey: "builtin:acme.ui",
    id: "acme.ui.panel",
    uiResourceGeneration: 7,
    resourceDigest: "a".repeat(64),
  };
  const admitted = {
    ok: true,
    value: {
      resource: { kind: "panel" },
      validationContext: { pluginId: "acme.ui", commands: [] },
      rawBytes: 123,
    },
  };
  electron.invoke.mockResolvedValueOnce(admitted);
  expect(await api.plugins.ui.resource(input)).toBe(admitted);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("plugins:ui:resource", input);
});

it("forwards recovery identifiers only and shares one event subscription", async () => {
  const itemId = "00000000-0000-4000-8000-000000000001",
    optionId = "00000000-0000-4000-8000-000000000002";
  await api.plugins.persistenceRecovery.snapshot({ itemId });
  await api.plugins.persistenceRecovery.act({ itemId, optionId });
  expect(electron.invoke).toHaveBeenCalledWith("plugins:persistence-recovery:snapshot", { itemId });
  expect(electron.invoke).toHaveBeenCalledWith("plugins:persistence-recovery:act", {
    itemId,
    optionId,
  });
  const offOpen = api.plugins.persistenceRecovery.onOpen(vi.fn());
  const offChanged = api.plugins.persistenceRecovery.onChanged(vi.fn());
  expect(
    electron.invoke.mock.calls.filter(
      ([name]) => name === "plugins:persistence-recovery:subscribe",
    ),
  ).toHaveLength(1);
  offOpen();
  expect(
    electron.invoke.mock.calls.filter(
      ([name]) => name === "plugins:persistence-recovery:unsubscribe",
    ),
  ).toHaveLength(0);
  offChanged();
  offChanged();
  expect(
    electron.invoke.mock.calls.filter(
      ([name]) => name === "plugins:persistence-recovery:unsubscribe",
    ),
  ).toHaveLength(1);
  expect(api.plugins.persistenceRecovery).not.toHaveProperty("mint");
  expect(api.plugins.persistenceRecovery).not.toHaveProperty("chooseDestination");
});
it("legacy preferences forwards each durable result unchanged and rejects malformed evidence locally", async () => {
  const scope = {
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    workbenchInstance: "00000000-0000-4000-8000-000000000002",
  };
  const snapshot = {
    nonce: "00000000-0000-4000-8000-000000000003",
    scope,
    entries: [{ key: "fixture.value", raw: null }],
  };
  await api.plugins.legacyPreferences.challenge("test.preferences");
  expect(electron.invoke).toHaveBeenCalledWith(
    "persistence:legacy-preferences-challenge",
    "test.preferences",
  );
  for (const state of ["accepted", "pending", "reconciled"] as const) {
    const result = { state };
    electron.invoke.mockResolvedValueOnce(result);
    expect(await api.plugins.legacyPreferences.submit(snapshot)).toBe(result);
  }
  const count = electron.invoke.mock.calls.length;
  await expect(
    api.plugins.legacyPreferences.submit({ ...snapshot, extra: true } as typeof snapshot),
  ).rejects.toThrow();
  await expect(api.plugins.legacyPreferences.challenge("/private/path")).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledTimes(count);
});
it("settings preload validates bindings and exact params, preserves receipts/errors, and removes the original watch once", async () => {
  const binding = {
    owner: {
      sourceKey: "builtin:test.settings",
      pluginId: "test.settings",
      uiResourceGeneration: 1,
    },
    scope: {
      hostEpoch: "00000000-0000-4000-8000-000000000001",
      workbenchInstance: "00000000-0000-4000-8000-000000000002",
    },
    resourceDigest: "a".repeat(64),
  };
  const params = {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "device.choice", value: "1" }],
  };
  const receipt = { ok: true, value: { receipt: { commitId: "kept" } } };
  electron.invoke.mockResolvedValueOnce(receipt);
  expect(await api.plugins.settings.update(binding, params)).toBe(receipt);
  const error = {
    ok: false,
    error: {
      code: "PLUGIN_E_SETTINGS_CONFLICT",
      message: "Conflict",
      detail: { kind: "persistence", reason: "revision-mismatch" },
    },
  };
  electron.invoke.mockResolvedValueOnce(error);
  expect(await api.plugins.settings.update(binding, params)).toBe(error);
  const count = electron.invoke.mock.calls.length;
  await expect(
    api.plugins.settings.open({
      sourceKey: binding.owner.sourceKey,
      resourceDigest: binding.resourceDigest,
      scope: binding.scope,
    } as Parameters<typeof api.plugins.settings.open>[0]),
  ).rejects.toThrow();
  await expect(
    api.plugins.settings.update(binding, { ...params, owner: binding.owner } as typeof params),
  ).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledTimes(count);
  const changed = vi.fn();
  const off = api.plugins.settings.watch(binding, changed);
  const receive = electron.on.mock.calls.find(([name]) => name === "plugins:settings:changed")![1];
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  receive({}, { binding: { ...binding, resourceDigest: "b".repeat(64) }, watch: 1 });
  expect(changed).toHaveBeenCalledOnce();
  receive({}, { binding, watch: 1 });
  expect(changed).toHaveBeenCalledTimes(2);
  off();
  off();
  receive({}, { binding, watch: 1 });
  expect(changed).toHaveBeenCalledTimes(2);
  expect(
    electron.invoke.mock.calls.filter(([name]) => name === "plugins:settings:unwatch"),
  ).toEqual([["plugins:settings:unwatch", { binding, watch: 1 }]]);
  expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(
    "plugins:settings:changed",
    receive,
  );
});
it("recovery preload rejects namespace or token fields before IPC", async () => {
  const selection = {
    itemId: "00000000-0000-4000-8000-000000000001",
    optionId: "00000000-0000-4000-8000-000000000002",
  };
  await expect(
    api.plugins.persistenceRecovery.act({
      ...selection,
      actionToken: selection.optionId,
    } as typeof selection),
  ).rejects.toThrow();
  expect(electron.invoke).not.toHaveBeenCalled();
});
