// Sandboxed Electron preloads must use CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");
const call =
  (name) =>
  (...args) =>
    ipcRenderer.invoke("smoke", name, args);
contextBridge.exposeInMainWorld("kobrixa", {
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
    onEvent: (listener) => {
      const handler = (_event, event) => listener(event);
      ipcRenderer.on("build:event", handler);
      return () => ipcRenderer.removeListener("build:event", handler);
    },
  },
  language: {
    quickFixes: call("diagnosticQuickFixes"),
    cancelQuickFix: call("diagnosticCancelQuickFix"),
    completionSync: call("completionSync"),
    sync: call("languageSync"),
    cancel: call("languageCancel"),
    analyze: call("analyze"),
    diagnostics: async () => [],
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
