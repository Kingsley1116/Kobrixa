import type { UpdateState } from "../shared/updates.js";
import { contextBridge, ipcRenderer } from "electron";
import type { BuildEvent, DeviceEvent, KobrixaApi } from "../shared/api.js";

const api: KobrixaApi = {
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
    start: (workspaceId, overlays) => ipcRenderer.invoke("build:start", workspaceId, overlays),
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
    monitor: (sessionId) => ipcRenderer.invoke("device:monitor", sessionId),
    inputModes: (sessionId, port, expectedType) =>
      ipcRenderer.invoke("device:input-modes", sessionId, port, expectedType),
    setInputMode: (sessionId, port, expectedType, mode) =>
      ipcRenderer.invoke("device:set-input-mode", sessionId, port, expectedType, mode),
    getPreferences: () => ipcRenderer.invoke("device:preferences"),
    setPreferences: (patch) => ipcRenderer.invoke("device:set-preferences", patch),
    prepareFiles: (request) => ipcRenderer.invoke("device:files-prepare", request),
    executeFiles: (ref, policy) => ipcRenderer.invoke("device:files-execute", ref, policy),
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

contextBridge.exposeInMainWorld("kobrixa", api);
