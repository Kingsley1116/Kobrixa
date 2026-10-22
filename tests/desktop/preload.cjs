// Sandboxed Electron preloads must use CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");
const call =
  (name) =>
  (...args) =>
    ipcRenderer.invoke("smoke", name, args);
const unsupportedPluginOperation = async () => {
  throw new Error("Development plugin operations are not supported by the smoke harness.");
};
let nextUiListener = 0;
const uiRequest = (method) => (input) => ipcRenderer.invoke(`plugins:ui:${method}`, input);
function createSettingsPreload170() {
  let nextWatch = 0;
  return {
    open: (input) => ipcRenderer.invoke("plugins:settings:open", input),
    read: (binding) => ipcRenderer.invoke("plugins:settings:read", binding),
    update: (binding, params) => ipcRenderer.invoke("plugins:settings:update", binding, params),
    reset: (binding, params) => ipcRenderer.invoke("plugins:settings:reset", binding, params),
    watch(binding, changed) {
      const watch = ++nextWatch;
      let active = true;
      const receive = (_event, value) => {
        if (
          active &&
          value?.watch === watch &&
          JSON.stringify(value.binding) === JSON.stringify(binding)
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
      void ipcRenderer.invoke("plugins:settings:dispose", binding).catch(() => {});
    },
  };
}
function createPersistenceRecoveryPreload170() {
  let listeners = 0;
  function listen(channel, callback) {
    let active = true;
    const receive = (_event, value) => {
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
    snapshot: (input) => ipcRenderer.invoke("plugins:persistence-recovery:snapshot", input),
    act: (input) => ipcRenderer.invoke("plugins:persistence-recovery:act", input),
    onOpen: (listener) => listen("plugins:persistence-recovery:open", listener),
    onChanged: (listener) => listen("plugins:persistence-recovery:changed", listener),
  };
}
contextBridge.exposeInMainWorld("kobrixa", {
  // The harness does not customize the native Windows title bar.
  ...(process.platform === "win32" ? { windowChrome: { setAppearance: async () => {} } } : {}),
  collab: {
    serverUrl: call("collabServerUrl"),
    getPreferences: call("collabPreferences"),
    setPreferences: call("collabSetPreferences"),
    prepareProject: call("collabPrepareProject"),
    previewProject: call("collabPreviewProject"),
    checkpoint: call("collabCheckpoint"),
    saveCopy: call("collabSaveCopy"),
    resumeRoom: call("collabResumeRoom"),
    closeRoom: call("collabCloseRoom"),
    sendChat: call("collabSendChat"),
    createRoom: call("collabCreateRoom"),
    joinRoom: call("collabJoinRoom"),
    kick: call("collabKick"),
    setRole: call("collabSetRole"),
    leave: call("collabLeave"),
    setDeviceControl: call("collabSetDeviceControl"),
    deviceControlContext: call("collabDeviceControlContext"),
    openMirror: call("collabOpenMirror"),
    removeMirror: call("collabRemoveMirror"),
  },
  simulator: { prepare: call("simulatorPrepare"), cancel: call("simulatorCancel") },
  updates: {
    getState: call("updateState"),
    setPreferences: call("updatePreferences"),
    check: call("updateCheck"),
    prepareInstall: call("updatePrepare"),
    cancelInstall: call("updateCancel"),
    install: call("updateInstall"),
    openRelease: call("updateOpen"),
    onState: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("updates:state", handler);
      return () => ipcRenderer.removeListener("updates:state", handler);
    },
  },
  keyboard: { updateContext: call("keyboard") },
  documentation: { open: call("documentationOpen") },
  // No development plugins; built-in help entries come from the renderer's catalog.
  plugins: {
    settings: createSettingsPreload170(),
    legacyPreferences: {
      challenge: (descriptorId) =>
        ipcRenderer.invoke("persistence:legacy-preferences-challenge", descriptorId),
      submit: (snapshot) => ipcRenderer.invoke("persistence:legacy-preferences-submit", snapshot),
    },
    persistenceRecovery: createPersistenceRecoveryPreload170(),
    // General workbench smoke has no dynamic plugins. Keep real IPC forwarding
    // so missing main handlers fail visibly; UI acceptance has its own real host.
    ui: {
      catalog: uiRequest("catalog"),
      resource: uiRequest("resource"),
      open: uiRequest("open"),
      close: uiRequest("close"),
      visibility: uiRequest("visibility"),
      invoke: uiRequest("invoke"),
      hold: uiRequest("hold"),
      pulse: uiRequest("pulse"),
      snapshot: uiRequest("snapshot"),
      reportFailure: uiRequest("report-failure"),
      onEvent(listener) {
        const id = ++nextUiListener,
          channel = `plugins:ui:event:${id}`;
        const receive = (_event, value) => listener(value);
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
      onChanged(listener) {
        const receive = () => listener();
        ipcRenderer.on("plugins:recovery:changed", receive);
        return () => ipcRenderer.removeListener("plugins:recovery:changed", receive);
      },
    },
    execute: unsupportedPluginOperation,
    cancel: unsupportedPluginOperation,
    setEnabled: unsupportedPluginOperation,
    setDeveloperMode: unsupportedPluginOperation,
    linkFolder: unsupportedPluginOperation,
    relinkFolder: unsupportedPluginOperation,
    unlink: unsupportedPluginOperation,
    reload: unsupportedPluginOperation,
    pythonCandidates: unsupportedPluginOperation,
    setPython: unsupportedPluginOperation,
    readLog: unsupportedPluginOperation,
    clearSafeModeLock: unsupportedPluginOperation,
    state: () => ipcRenderer.invoke("plugins:state"),
    staticLanguages: () => ipcRenderer.invoke("plugins:static-languages"),
    reportLanguageRegistrationFailure: (input) =>
      ipcRenderer.invoke("plugins:report-language-registration-failure", input),
    diagnosticHelp: async () => ({
      revision: 0,
      plugins: {
        "kobrixa.basic-plus": { displayName: "Basic Plus", entries: [] },
        "kobrixa.ev3": {
          displayName: { en: "EV3 native backend", "zh-TW": "EV3 原生後端" },
          entries: [],
        },
      },
    }),
    notices: async () => [],
    onEvent: (listener) => {
      const receive = (_event, event) => listener(event);
      ipcRenderer.on("plugins:event", receive);
      return () => ipcRenderer.removeListener("plugins:event", receive);
    },
  },
  workspace: {
    getPreferences: call("filePreferences"),
    setPreferences: call("setFilePreferences"),
    restoreSession: call("restoreSession"),
    saveSession: call("saveSession"),
    close: call("closeProject"),
    finishClose: call("finishClose"),
    onBeforeClose: (listener) => {
      const handler = (_event, id) => listener(id);
      ipcRenderer.on("workspace:before-close", handler);
      return () => ipcRenderer.removeListener("workspace:before-close", handler);
    },
    open: call("open"),
    create: call("open"),
    selectEntry: call("open"),
    read: call("read"),
    readFile: call("readFile"),
    search: call("search"),
    write: call("write"),
    refresh: call("refresh"),
    history: call("history"),
    historyContent: call("historyContent"),
    saveDraft: call("draft"),
    createEntry: call("createEntry"),
    moveEntry: call("moveEntry"),
    trashEntry: call("trashEntry"),
  },
  build: {
    start: call("build"),
    cancel: call("cancel"),
    artifacts: async () => [],
    preview: call("previewIR"),
    onEvent: (listener) => {
      const handler = (_event, event) => listener(event);
      ipcRenderer.on("build:event", handler);
      return () => ipcRenderer.removeListener("build:event", handler);
    },
  },
  language: {
    status: (workspaceId, refresh) => call("languageStatus")(workspaceId, refresh ?? false),
    feature: call("languageFeature"),
    cancelFeature: call("languageCancelFeature"),
    onStatus: (listener) => {
      const receive = (_event, event) => listener(event);
      ipcRenderer.on("language:status-changed", receive);
      return () => ipcRenderer.removeListener("language:status-changed", receive);
    },
    quickFixes: call("diagnosticQuickFixes"),
    cancelQuickFix: call("diagnosticCancelQuickFix"),
    completionSync: call("completionSync"),
    sync: call("languageSync"),
    cancel: call("languageCancel"),
    analyze: call("analyze"),
    diagnostics: call("languageDiagnostics"),
  },
  sensorLab: {
    getState: call("labGetState"),
    start: call("labStart"),
    stop: call("labStop"),
    retrySave: call("labRetrySave"),
    list: call("labList"),
    read: call("labRead"),
    delete: call("labDelete"),
    listCalibrations: call("labListCalibrations"),
    saveCalibration: call("labSaveCalibration"),
    deleteCalibration: call("labDeleteCalibration"),
    exportCsv: call("labExportCsv"),
    onState: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("sensor-lab:state", handler);
      return () => ipcRenderer.removeListener("sensor-lab:state", handler);
    },
  },
  device: {
    startMotorTest: call("motorStart"),
    keepMotorTestAlive: call("motorKeepAlive"),
    stopMotorTest: call("motorStop"),
    motorTestState: call("motorState"),
    onMotorTest: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("device:motor-test", handler);
      return () => ipcRenderer.removeListener("device:motor-test", handler);
    },
    getPreferences: call("devicePreferences"),
    setPreferences: call("setDevicePreferences"),
    onEvent: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("device:event", handler);
      return () => ipcRenderer.removeListener("device:event", handler);
    },
    monitor: call("deviceMonitor"),
    watchMonitor: call("deviceWatchMonitor"),
    onMonitor: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("device:monitor-update", handler);
      return () => ipcRenderer.removeListener("device:monitor-update", handler);
    },
    inputModes: call("deviceInputModes"),
    setInputMode: call("deviceSetInputMode"),
    discover: call("deviceDiscover"),
    files: call("deviceFiles"),
    prepareFiles: call("device"),
    executeFiles: call("device"),
    renewFiles: call("device"),
    stopFiles: call("device"),
    connect: call("deviceConnect"),
    connectWifi: call("deviceConnectWifi"),
    disconnect: call("deviceDisconnect"),
    upload: call("device"),
    deploy: call("device"),
    run: call("device"),
    stop: call("device"),
    delete: call("device"),
  },
});
