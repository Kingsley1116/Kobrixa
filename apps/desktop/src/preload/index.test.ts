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
  expect(channel).toBe("plugins:ui:event");
  const event = { type: "catalog", hostEpoch: "host", revision: 2, owners: [] };
  handler({}, event);
  expect(callback).toHaveBeenCalledExactlyOnceWith(event);
  off();
  expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler);
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
