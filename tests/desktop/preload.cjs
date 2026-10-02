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
  workspace: {
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
    write: call("write"),
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
    completionSync: call("completionSync"),
    sync: call("languageSync"),
    cancel: call("languageCancel"),
    analyze: call("analyze"),
    diagnostics: async () => [],
  },
  device: {
    onEvent: () => () => {},
    discover: async () => [],
    files: async () => ({ ok: true, entries: [] }),
    prepareFiles: call("device"),
    executeFiles: call("device"),
    stopFiles: call("device"),
    connect: call("device"),
    connectWifi: call("device"),
    disconnect: call("device"),
    upload: call("device"),
    deploy: call("device"),
    run: call("device"),
    stop: call("device"),
    delete: call("device"),
  },
});
