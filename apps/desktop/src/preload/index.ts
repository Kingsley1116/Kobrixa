import type { MotorTestState } from "../shared/motor-test.js";
import type { UpdateState } from "../shared/updates.js";
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
    prepareProject: (roomId, workspaceId) =>
      ipcRenderer.invoke("collab:prepare-project", roomId, workspaceId),
    checkpoint: (roomId) => ipcRenderer.invoke("collab:checkpoint", roomId),
    saveCopy: (roomId, reveal) => ipcRenderer.invoke("collab:save-copy", roomId, reveal),
    resumeRoom: (roomId) => ipcRenderer.invoke("collab:resume-room", roomId),
    closeRoom: (roomId) => ipcRenderer.invoke("collab:close-room", roomId),
    sendChat: (roomId, message) => ipcRenderer.invoke("collab:send-chat", roomId, message),
    kick: (roomId, participantId) => ipcRenderer.invoke("collab:kick", roomId, participantId),
    setRole: (roomId, request) => ipcRenderer.invoke("collab:set-role", roomId, request),
    leave: (roomId) => ipcRenderer.invoke("collab:leave", roomId),
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
