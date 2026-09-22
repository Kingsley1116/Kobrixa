import { contextBridge, ipcRenderer } from "electron";
import type { BuildEvent, DeviceEvent, KobrixaApi } from "../shared/api.js";

const api: KobrixaApi = {
  workspace: {
    open: () => ipcRenderer.invoke("workspace:open"),
    create: (name) => ipcRenderer.invoke("workspace:create", name),
    selectEntry: (workspaceId, entry) =>
      ipcRenderer.invoke("workspace:select-entry", workspaceId, entry),
    read: (workspaceId, file) => ipcRenderer.invoke("workspace:read", workspaceId, file),
    write: (workspaceId, file, content) =>
      ipcRenderer.invoke("workspace:write", workspaceId, file, content),
    saveDraft: (workspaceId, file, content) =>
      ipcRenderer.invoke("workspace:save-draft", workspaceId, file, content),
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
    diagnostics: (workspaceId, overlays) =>
      ipcRenderer.invoke("language:diagnostics", workspaceId, overlays),
  },
  device: {
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
