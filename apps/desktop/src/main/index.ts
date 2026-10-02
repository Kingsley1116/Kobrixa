import { createUpdateService } from "./updates/runtime.js";
import { UpdateOperationGate, type UpdateService } from "./updates/service.js";
import { attachKeyboard } from "./window/keyboard.js";
import path from "node:path";
import { app, BrowserWindow, session, shell } from "electron";
import { BuildService } from "./workspace/build.js";
import { DeviceService } from "./device/device.js";
import { registerIpc } from "./ipc.js";
import { LanguageService } from "./language/language.js";
import { WorkspaceService } from "./workspace/workspace.js";
import { CloseHandshake } from "./window/close.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Keep the profile used by existing Forge distributions, including drafts and localStorage.
app.setPath(
  "userData",
  app.commandLine.getSwitchValue("user-data-dir") ||
    path.join(app.getPath("appData"), "@kobrixa/desktop"),
);
let updates: UpdateService | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let closeHandshake: CloseHandshake | undefined;
let rendererCanFlush = false;

function createWindow(): void {
  rendererCanFlush = false;
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    backgroundColor: "#18212b",
    title: "Kobrixa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const window = mainWindow;
  const handshake = new CloseHandshake(
    (id) => window.webContents.send("workspace:before-close", id),
    () => {
      if (quitting) app.quit();
      else window.close();
    },
  );
  closeHandshake = handshake;
  window.on("close", (event) => {
    if (updates?.installing || handshake.ready || window.webContents.isCrashed()) return;
    // Before the renderer subscribes it cannot have editable buffers to flush.
    if (!rendererCanFlush && !updates?.preparing) return;
    event.preventDefault();
    if (!updates?.preparing) handshake.request();
  });
  window.webContents.on("render-process-gone", () => {
    updates?.cancelInstall();
    handshake.reset();
  });
  window.webContents.on("did-start-loading", () => {
    rendererCanFlush = false;
    updates?.cancelInstall();
    handshake.reset();
  });
  attachKeyboard(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://education.lego.com/")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
}

void app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          MAIN_WINDOW_VITE_DEV_SERVER_URL
            ? "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src 'self' blob:"
            : "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'none'",
        ],
      },
    });
  });
  const workspaces = new WorkspaceService();
  const renderer = () => mainWindow?.webContents;
  const builds = new BuildService(workspaces, renderer);
  const language = new LanguageService(workspaces);
  app.on("before-quit", (event) => {
    if (updates?.preparing) {
      event.preventDefault();
      return;
    }
    quitting = true;
  });
  app.on("will-quit", () => {
    updates?.dispose();
    language.dispose();
  });
  app.on("window-all-closed", () => language.cancel());
  const devices = new DeviceService(builds, renderer);
  app.on("will-quit", () => {
    void devices.reset();
  });
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window") return;
    contents.on("destroyed", () => {
      void devices.reset();
    });
    contents.on("render-process-gone", () => {
      void devices.reset();
    });
    contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) void devices.reset();
    });
  });
  const operationGate = new UpdateOperationGate(() => updates);
  updates = await createUpdateService(
    renderer,
    () => operationGate.busy || builds.busy || devices.busy,
  );
  registerIpc(
    renderer,
    workspaces,
    builds,
    language,
    devices,
    updates,
    operationGate,
    (id, ready) => {
      if (closeHandshake?.finish(id, ready) && !ready) quitting = false;
    },
    () => {
      rendererCanFlush = true;
    },
  );
  createWindow();
  updates.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
