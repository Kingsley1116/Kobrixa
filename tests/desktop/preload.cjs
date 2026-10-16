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
contextBridge.exposeInMainWorld("kobrixa", {
  // The harness does not customize the native Windows title bar.
  windowChrome: { setAppearance: async () => {} },
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
    state: async () => ({
      revision: 0,
      diagnosticHelpRevision: 0,
      safeMode: false,
      developmentMode: false,
      plugins: [],
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    }),
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
    onEvent: () => () => {},
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
