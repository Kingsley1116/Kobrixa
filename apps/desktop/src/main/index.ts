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

function createWindow(): void {
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

  mainWindow.on("close", (event) => {
    if (updates?.preparing) event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", () => updates?.cancelInstall());
  mainWindow.webContents.on("did-start-loading", () => updates?.cancelInstall());
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
    updates?.dispose();
    language.dispose();
  });
  app.on("window-all-closed", () => language.cancel());
  const devices = new DeviceService(builds, renderer);
  const operationGate = new UpdateOperationGate(() => updates);
  updates = await createUpdateService(
    renderer,
    () => operationGate.busy || builds.busy || devices.busy,
  );
  registerIpc(renderer, workspaces, builds, language, devices, updates, operationGate);
  createWindow();
  updates.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
