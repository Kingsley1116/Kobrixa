import path from "node:path";
import { app, BrowserWindow, session, shell } from "electron";
import { BuildService } from "./build.js";
import { DeviceService } from "./device.js";
import { registerIpc } from "./ipc.js";
import { LanguageService } from "./language.js";
import { WorkspaceService } from "./workspace.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

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

void app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          MAIN_WINDOW_VITE_DEV_SERVER_URL
            ? "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:"
            : "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'none'",
        ],
      },
    });
  });
  createWindow();
  const workspaces = new WorkspaceService();
  const renderer = () => mainWindow?.webContents;
  const builds = new BuildService(workspaces, renderer);
  const language = new LanguageService(workspaces);
  const devices = new DeviceService(builds, renderer);
  registerIpc(renderer, workspaces, builds, language, devices);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
