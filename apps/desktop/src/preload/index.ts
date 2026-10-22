import type { UiBridgeEvent } from "../shared/plugin-ui.js";
let nextUiListener = 0;
import type { LanguageStatusEvent } from "../shared/language-services.js";
import type { MotorTestState } from "../shared/motor-test.js";
import type { UpdateState } from "../shared/updates.js";
import type { PluginEvent } from "../shared/plugins.js";
import { contextBridge, ipcRenderer } from "electron";
import type { BuildEvent, DeviceEvent, KobrixaApi } from "../shared/api.js";
import type { MonitorUpdate, SensorLabState } from "../shared/sensor-lab.js";

const api: KobrixaApi = {
  collab: {
    serverUrl: () => ipcRenderer.invoke("collab:server-url"),
    getPreferences: () => ipcRenderer.invoke("collab:preferences"),
    setPreferences: (patch) => ipcRenderer.invoke("collab:set-preferences", patch),
    createRoom: (request, workspaceId) =>
      ipcRenderer.invoke("collab:create-room", request, workspaceId),
    joinRoom: (request) => ipcRenderer.invoke("collab:join-room", request),
    previewProject: (workspaceId) => ipcRenderer.invoke("collab:preview-project", workspaceId),
    prepareProject: (roomId, workspaceId, resolution) =>
      ipcRenderer.invoke("collab:prepare-project", roomId, workspaceId, resolution),
    checkpoint: (roomId) => ipcRenderer.invoke("collab:checkpoint", roomId),
    saveCopy: (roomId, reveal) => ipcRenderer.invoke("collab:save-copy", roomId, reveal),
    resumeRoom: (roomId) => ipcRenderer.invoke("collab:resume-room", roomId),
    closeRoom: (roomId) => ipcRenderer.invoke("collab:close-room", roomId),
    sendChat: (roomId, message) => ipcRenderer.invoke("collab:send-chat", roomId, message),
    kick: (roomId, participantId) => ipcRenderer.invoke("collab:kick", roomId, participantId),
    setRole: (roomId, request) => ipcRenderer.invoke("collab:set-role", roomId, request),
    leave: (roomId) => ipcRenderer.invoke("collab:leave", roomId),
    deviceControlContext: () => ipcRenderer.invoke("collab:device-control-context"),
    setDeviceControl: (holder) => ipcRenderer.invoke("collab:set-device-control", holder),
    openMirror: (roomId, projectName) =>
      ipcRenderer.invoke("collab:open-mirror", roomId, projectName),
    removeMirror: (roomId) => ipcRenderer.invoke("collab:remove-mirror", roomId),
  },
  simulator: {
    cancel: (workspaceId) => ipcRenderer.invoke("simulator:cancel", workspaceId),
    prepare: (workspaceId, overlays, entries) =>
      ipcRenderer.invoke("simulator:prepare", workspaceId, overlays, entries),
  },
  sensorLab: {
    getState: () => ipcRenderer.invoke("sensor-lab:state"),
    start: (request) => ipcRenderer.invoke("sensor-lab:start", request),
    stop: (reason) => ipcRenderer.invoke("sensor-lab:stop", reason),
    retrySave: () => ipcRenderer.invoke("sensor-lab:retry-save"),
    list: () => ipcRenderer.invoke("sensor-lab:list"),
    read: (id) => ipcRenderer.invoke("sensor-lab:read", id),
    delete: (id) => ipcRenderer.invoke("sensor-lab:delete", id),
    listCalibrations: () => ipcRenderer.invoke("sensor-lab:calibrations"),
    saveCalibration: (profile) => ipcRenderer.invoke("sensor-lab:save-calibration", profile),
    deleteCalibration: (id) => ipcRenderer.invoke("sensor-lab:delete-calibration", id),
    exportCsv: (id) => ipcRenderer.invoke("sensor-lab:export", id),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: SensorLabState) => listener(state);
      ipcRenderer.on("sensor-lab:state", handler);
      return () => ipcRenderer.removeListener("sensor-lab:state", handler);
    },
  },
  plugins: {
    settings: createSettingsPreload170(),
    persistenceRecovery: createPersistenceRecoveryPreload170(),
    legacyPreferences: {
      challenge: (descriptorId) => {
        if (
          typeof descriptorId !== "string" ||
          descriptorId.length > 128 ||
          !/^[a-z][a-z0-9-]*(?:[.:][a-z0-9-]+)+$/.test(descriptorId)
        )
          return Promise.reject(new Error("Invalid preference descriptor"));
        return ipcRenderer.invoke("persistence:legacy-preferences-challenge", descriptorId);
      },
      submit: (snapshot) => {
        if (!isLegacyPreferencesSnapshot(snapshot))
          return Promise.reject(new Error("Invalid preference snapshot"));
        return ipcRenderer.invoke("persistence:legacy-preferences-submit", snapshot);
      },
    },
    ui: {
      catalog: (input) => ipcRenderer.invoke("plugins:ui:catalog", input),
      resource: (input) => ipcRenderer.invoke("plugins:ui:resource", input),
      open: (input) => ipcRenderer.invoke("plugins:ui:open", input),
      close: (input) => ipcRenderer.invoke("plugins:ui:close", input),
      visibility: (input) => ipcRenderer.invoke("plugins:ui:visibility", input),
      invoke: (input) => ipcRenderer.invoke("plugins:ui:invoke", input),
      hold: (input) => ipcRenderer.invoke("plugins:ui:hold", input),
      pulse: (input) => ipcRenderer.invoke("plugins:ui:pulse", input),
      snapshot: (input) => ipcRenderer.invoke("plugins:ui:snapshot", input),
      reportFailure: (input) => ipcRenderer.invoke("plugins:ui:report-failure", input),
      onEvent: (listener) => {
        const id = ++nextUiListener;
        const channel = `plugins:ui:event:${id}`;
        const receive = (_event: Electron.IpcRendererEvent, value: UiBridgeEvent) =>
          listener(value);
        ipcRenderer.on(channel, receive);
        void ipcRenderer.invoke("plugins:ui:subscribe", id).catch(() => {});
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          ipcRenderer.removeListener(channel, receive);
          void ipcRenderer.invoke("plugins:ui:unsubscribe", id).catch(() => {});
        };
      },
    },
    recovery: {
      snapshot: (input) => ipcRenderer.invoke("plugins:recovery:snapshot", input),
      act: (input) => ipcRenderer.invoke("plugins:recovery:act", input),
      onChanged: (listener) => {
        const receive = () => listener();
        ipcRenderer.on("plugins:recovery:changed", receive);
        return () => ipcRenderer.removeListener("plugins:recovery:changed", receive);
      },
    },
    state: () => ipcRenderer.invoke("plugins:state"),
    diagnosticHelp: () => ipcRenderer.invoke("plugins:diagnosticHelp"),
    staticLanguages: () => ipcRenderer.invoke("plugins:static-languages"),
    reportLanguageRegistrationFailure: (input) =>
      ipcRenderer.invoke("plugins:report-language-registration-failure", input),
    notices: () => ipcRenderer.invoke("plugins:notices"),
    execute: (commandId) => ipcRenderer.invoke("plugins:execute", commandId),
    cancel: (sourceKey) => ipcRenderer.invoke("plugins:cancel", sourceKey),
    setEnabled: (sourceKey, enabled) =>
      ipcRenderer.invoke("plugins:set-enabled", sourceKey, enabled),
    setDeveloperMode: (enabled) => ipcRenderer.invoke("plugins:setDeveloperMode", enabled),
    linkFolder: () => ipcRenderer.invoke("plugins:linkFolder"),
    relinkFolder: (sourceKey) => ipcRenderer.invoke("plugins:relinkFolder", sourceKey),
    unlink: (sourceKey) => ipcRenderer.invoke("plugins:unlink", sourceKey),
    reload: (sourceKey) => ipcRenderer.invoke("plugins:reload", sourceKey),
    pythonCandidates: () => ipcRenderer.invoke("plugins:pythonCandidates"),
    setPython: (id) => ipcRenderer.invoke("plugins:setPython", id),
    readLog: (sourceKey, after) => ipcRenderer.invoke("plugins:readLog", sourceKey, after),
    clearSafeModeLock: () => ipcRenderer.invoke("plugins:clearSafeModeLock"),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PluginEvent) => listener(value);
      ipcRenderer.on("plugins:event", handler);
      return () => ipcRenderer.removeListener("plugins:event", handler);
    },
  },
  documentation: { open: (request) => ipcRenderer.invoke("documentation:open", request) },
  updates: {
    getState: () => ipcRenderer.invoke("updates:state"),
    setPreferences: (value) => ipcRenderer.invoke("updates:preferences", value),
    check: () => ipcRenderer.invoke("updates:check"),
    prepareInstall: () => ipcRenderer.invoke("updates:prepare"),
    cancelInstall: () => ipcRenderer.invoke("updates:cancel"),
    install: () => ipcRenderer.invoke("updates:install"),
    openRelease: () => ipcRenderer.invoke("updates:open"),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: UpdateState) => listener(value);
      ipcRenderer.on("updates:state", handler);
      return () => ipcRenderer.removeListener("updates:state", handler);
    },
  },
  keyboard: { updateContext: (context) => ipcRenderer.invoke("keyboard:context", context) },
  workspace: {
    getPreferences: () => ipcRenderer.invoke("workspace:preferences"),
    setPreferences: (patch) => ipcRenderer.invoke("workspace:set-preferences", patch),
    restoreSession: () => ipcRenderer.invoke("workspace:restore-session"),
    saveSession: (state) => ipcRenderer.invoke("workspace:save-session", state),
    close: (workspaceId) => ipcRenderer.invoke("workspace:close", workspaceId),
    onBeforeClose: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, requestId: string) => listener(requestId);
      ipcRenderer.on("workspace:before-close", handler);
      void ipcRenderer.invoke("workspace:renderer-ready").catch(() => undefined);
      return () => ipcRenderer.removeListener("workspace:before-close", handler);
    },
    finishClose: (requestId, ready) =>
      ipcRenderer.invoke("workspace:finish-close", requestId, ready),
    open: () => ipcRenderer.invoke("workspace:open"),
    search: (workspaceId, request) => ipcRenderer.invoke("workspace:search", workspaceId, request),
    create: (name) => ipcRenderer.invoke("workspace:create", name),
    selectEntry: (workspaceId, entry) =>
      ipcRenderer.invoke("workspace:select-entry", workspaceId, entry),
    read: (workspaceId, file) => ipcRenderer.invoke("workspace:read", workspaceId, file),
    readFile: (workspaceId, file) => ipcRenderer.invoke("workspace:read-file", workspaceId, file),
    refresh: (workspaceId, known) => ipcRenderer.invoke("workspace:refresh", workspaceId, known),
    write: (workspaceId, file, content, expectedRevision) =>
      ipcRenderer.invoke("workspace:write", workspaceId, file, content, expectedRevision),
    history: (workspaceId, file) => ipcRenderer.invoke("workspace:history", workspaceId, file),
    historyContent: (workspaceId, file, entryId) =>
      ipcRenderer.invoke("workspace:history-content", workspaceId, file, entryId),
    saveDraft: (workspaceId, file, content, baseRevision) =>
      ipcRenderer.invoke("workspace:save-draft", workspaceId, file, content, baseRevision),
    createEntry: (workspaceId, parent, kind, name) =>
      ipcRenderer.invoke("workspace:create-entry", workspaceId, parent, kind, name),
    moveEntry: (workspaceId, source, target) =>
      ipcRenderer.invoke("workspace:move-entry", workspaceId, source, target),
    trashEntry: (workspaceId, entry) =>
      ipcRenderer.invoke("workspace:trash-entry", workspaceId, entry),
  },
  build: {
    start: (workspaceId, overlays, preview) =>
      ipcRenderer.invoke("build:start", workspaceId, overlays, preview),
    preview: (buildId) => ipcRenderer.invoke("build:preview", buildId),
    cancel: (buildId) => ipcRenderer.invoke("build:cancel", buildId),
    artifacts: (buildId) => ipcRenderer.invoke("build:artifacts", buildId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: BuildEvent): void =>
        listener(value);
      ipcRenderer.on("build:event", handler);
      return () => ipcRenderer.removeListener("build:event", handler);
    },
  },
  language: {
    status: (workspaceId, refresh) =>
      ipcRenderer.invoke("language:status", workspaceId, refresh ?? false),
    feature: (workspaceId, request) => ipcRenderer.invoke("language:feature", workspaceId, request),
    cancelFeature: (workspaceId, requestId) =>
      ipcRenderer.invoke("language:cancel-feature", workspaceId, requestId),
    onStatus: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, event: LanguageStatusEvent) =>
        listener(event);
      ipcRenderer.on("language:status-changed", receive);
      return () => {
        ipcRenderer.removeListener("language:status-changed", receive);
      };
    },

    cancelQuickFix: (workspaceId, requestId) =>
      ipcRenderer.invoke("language:cancel-quick-fix", workspaceId, requestId),
    quickFixes: (workspaceId, request) =>
      ipcRenderer.invoke("language:quick-fixes", workspaceId, request),
    completionSync: (workspaceId, request) =>
      ipcRenderer.invoke("language:completion-sync", workspaceId, request),
    sync: (workspaceId, request) => ipcRenderer.invoke("language:sync", workspaceId, request),
    analyze: (workspaceId, overlays) =>
      ipcRenderer.invoke("language:analyze", workspaceId, overlays),
    cancel: () => ipcRenderer.invoke("language:cancel"),
    diagnostics: (workspaceId, overlays) =>
      ipcRenderer.invoke("language:diagnostics", workspaceId, overlays),
  },
  device: {
    startMotorTest: (request) => ipcRenderer.invoke("device:motor-test-start", request),
    keepMotorTestAlive: (ref) => ipcRenderer.invoke("device:motor-test-keepalive", ref),
    stopMotorTest: (ref, brake) => ipcRenderer.invoke("device:motor-test-stop", ref, brake),
    motorTestState: () => ipcRenderer.invoke("device:motor-test-state"),
    onMotorTest: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: MotorTestState) => listener(state);
      ipcRenderer.on("device:motor-test-update", handler);
      return () => ipcRenderer.removeListener("device:motor-test-update", handler);
    },
    watchMonitor: (sessionId, enabled) =>
      ipcRenderer.invoke("device:watch-monitor", sessionId, enabled),
    onMonitor: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, update: MonitorUpdate) =>
        listener(update);
      ipcRenderer.on("device:monitor-update", handler);
      return () => ipcRenderer.removeListener("device:monitor-update", handler);
    },
    monitor: (sessionId) => ipcRenderer.invoke("device:monitor", sessionId),
    inputModes: (sessionId, port, expectedType) =>
      ipcRenderer.invoke("device:input-modes", sessionId, port, expectedType),
    setInputMode: (sessionId, port, expectedType, mode) =>
      ipcRenderer.invoke("device:set-input-mode", sessionId, port, expectedType, mode),
    getPreferences: () => ipcRenderer.invoke("device:preferences"),
    setPreferences: (patch) => ipcRenderer.invoke("device:set-preferences", patch),
    prepareFiles: (request) => ipcRenderer.invoke("device:files-prepare", request),
    executeFiles: (ref, policy) => ipcRenderer.invoke("device:files-execute", ref, policy),
    renewFiles: (ref) => ipcRenderer.invoke("device:files-renew", ref),
    stopFiles: (ref) => ipcRenderer.invoke("device:files-stop", ref),
    files: (request) => ipcRenderer.invoke("device:files", request),
    discover: () => ipcRenderer.invoke("device:discover"),
    connect: (descriptor) => ipcRenderer.invoke("device:connect", descriptor),
    connectWifi: (address) => ipcRenderer.invoke("device:connect-wifi", address),
    disconnect: (sessionId) => ipcRenderer.invoke("device:disconnect", sessionId),
    upload: (sessionId, buildId, remotePath) =>
      ipcRenderer.invoke("device:upload", sessionId, buildId, remotePath),
    deploy: (sessionId, buildId, remoteDirectory) =>
      ipcRenderer.invoke("device:deploy", sessionId, buildId, remoteDirectory),
    run: (sessionId, remotePath) => ipcRenderer.invoke("device:run", sessionId, remotePath),
    stop: (sessionId) => ipcRenderer.invoke("device:stop", sessionId),
    delete: (sessionId, remotePath) => ipcRenderer.invoke("device:delete", sessionId, remotePath),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: DeviceEvent): void =>
        listener(value);
      ipcRenderer.on("device:event", handler);
      return () => ipcRenderer.removeListener("device:event", handler);
    },
  },
};

if (process.platform === "win32") {
  api.windowChrome = {
    setAppearance: (appearance) => ipcRenderer.invoke("window-chrome:appearance", appearance),
  };
}

contextBridge.exposeInMainWorld("kobrixa", api);

function createSettingsPreload170(): PluginsApi["settings"] {
  let nextWatch = 0;
  return {
    open: async (input) =>
      ipcRenderer.invoke(
        "plugins:settings:open",
        z.strictObject({ sourceKey: source170, resourceDigest: digest170 }).parse(input),
      ),
    read: async (binding) => ipcRenderer.invoke("plugins:settings:read", binding170.parse(binding)),
    update: async (binding, params) =>
      ipcRenderer.invoke(
        "plugins:settings:update",
        binding170.parse(binding),
        settingsRequestSchemas["settings/update"].params.parse(params),
      ),
    reset: async (binding, params) =>
      ipcRenderer.invoke(
        "plugins:settings:reset",
        binding170.parse(binding),
        settingsRequestSchemas["settings/reset"].params.parse(params),
      ),
    watch(value, changed) {
      const binding = binding170.parse(value);
      const watch = ++nextWatch;
      let active = true;
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const event = z
          .strictObject({ binding: binding170, watch: z.number().int().positive() })
          .safeParse(value);
        if (
          active &&
          event.success &&
          event.data.watch === watch &&
          JSON.stringify(event.data.binding) === JSON.stringify(binding)
        )
          changed();
      };
      ipcRenderer.on("plugins:settings:changed", receive);
      void ipcRenderer.invoke("plugins:settings:watch", { binding, watch }).then(
        () => {
          if (active) changed();
        },
        () => {
          if (active) changed();
        },
      );
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("plugins:settings:changed", receive);
        void ipcRenderer.invoke("plugins:settings:unwatch", { binding, watch }).catch(() => {});
      };
    },
    dispose(binding) {
      void ipcRenderer
        .invoke("plugins:settings:dispose", binding170.parse(binding))
        .catch(() => {});
    },
  };
}
// Add inside the existing plugins object in each preload:
// settings: createSettingsPreload170(),

function createPersistenceRecoveryPreload170(): PersistenceRecoveryBridge {
  let listeners = 0;
  function listen<T>(channel: string, callback: (value: T) => void): () => void {
    let active = true;
    const receive = (_event: Electron.IpcRendererEvent, value: T) => {
      if (active) callback(value);
    };
    ipcRenderer.on(channel, receive);
    if (listeners++ === 0)
      void ipcRenderer.invoke("plugins:persistence-recovery:subscribe").catch(() => {});
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(channel, receive);
      if (--listeners === 0)
        void ipcRenderer.invoke("plugins:persistence-recovery:unsubscribe").catch(() => {});
    };
  }
  return {
    snapshot: async (input) =>
      ipcRenderer.invoke(
        "plugins:persistence-recovery:snapshot",
        recoverySelection170.parse(input),
      ),
    act: async (input) =>
      ipcRenderer.invoke("plugins:persistence-recovery:act", recoveryAction170.parse(input)),
    onOpen: (listener) =>
      listen("plugins:persistence-recovery:open", (value) => {
        const parsed = recoverySelection170.safeParse(value);
        if (parsed.success) listener(parsed.data);
      }),
    onChanged: (listener) => listen("plugins:persistence-recovery:changed", listener),
  };
}
// Inside the plugins object in both preloads:
// persistenceRecovery: createPersistenceRecoveryPreload170(),

import type { PluginsApi } from "../shared/plugins.js";
import {
  isLegacyPreferencesSnapshot,
  type PersistenceRecoveryBridge,
} from "../shared/plugin-persistence.js";

import { z } from "zod";
import { settingsRequestSchemas, handleSchema, namespacedIdSchema } from "@kobrixa/plugin-protocol";
const source170 = z
  .string()
  .max(160)
  .regex(/^(?:builtin:[a-z0-9.-]+|dev:[0-9a-f]{16})$/);
const digest170 = z.string().regex(/^[a-f0-9]{64}$/);
const binding170 = z.strictObject({
  owner: z.strictObject({
    sourceKey: source170,
    pluginId: namespacedIdSchema,
    uiResourceGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  scope: z.strictObject({ hostEpoch: handleSchema, workbenchInstance: handleSchema }),
  resourceDigest: digest170,
});
const recoverySelection170 = z.strictObject({ itemId: handleSchema });
const recoveryAction170 = recoverySelection170.extend({ optionId: handleSchema });
