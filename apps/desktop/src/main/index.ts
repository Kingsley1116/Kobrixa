import { loadDevicePreferences } from "./device/preferences.js";
import { createUpdateService } from "./updates/runtime.js";
import { UpdateOperationGate, type UpdateService } from "./updates/service.js";
import { attachKeyboard } from "./window/keyboard.js";
import path from "node:path";
import {
  app,
  BrowserWindow,
  session,
  shell,
  powerMonitor,
  dialog,
  type MessageBoxOptions,
} from "electron";
import { BuildService } from "./workspace/build.js";
import { DeviceService } from "./device/device.js";
import { registerIpc } from "./ipc.js";
import { LanguageService } from "./language/language.js";
import { WorkspaceService } from "./workspace/workspace.js";
import { CloseHandshake } from "./window/close.js";
import { MonitorService } from "./device/monitor-service.js";
import { MotorTestService } from "./device/motor-test-service.js";
import { SensorLabService } from "./sensor-lab/service.js";
import { MainProcessCloseGuard } from "./window/main-close.js";

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

async function retryDeviceWork(error: unknown, window?: BrowserWindow): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: "error",
    title: "Device work unfinished / 設備操作尚未完成",
    message:
      "Finish stopping motors and saving recordings before closing. / 請先確認馬達停止並儲存記錄，再關閉程式。",
    detail: error instanceof Error ? error.message : String(error),
    buttons: ["Retry / 重試", "Keep open / 保持開啟"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
  return result.response === 0;
}

function createWindow(flushSensorLab: () => Promise<void>): void {
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
  const finish = () => {
    if (quitting) app.quit();
    else window.close();
  };
  const mainClose = new MainProcessCloseGuard(
    flushSensorLab,
    finish,
    (error) => retryDeviceWork(error, window),
    () => {
      quitting = false;
    },
  );
  const handshake = new CloseHandshake(
    (id) => window.webContents.send("workspace:before-close", id),
    finish,
  );
  closeHandshake = handshake;
  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = undefined;
    closeHandshake = undefined;
    rendererCanFlush = false;
  });
  window.on("close", (event) => {
    if (updates?.installing || handshake.ready || mainClose.ready) return;
    event.preventDefault();
    if (updates?.preparing) return;
    if (window.webContents.isCrashed() || !rendererCanFlush) {
      void mainClose.request();
    } else handshake.request();
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
  const renderer = () => {
    // Reading webContents itself throws once its BrowserWindow is destroyed.
    // Services may finish saving or disconnecting after the last window closes.
    if (!mainWindow || mainWindow.isDestroyed()) return undefined;
    const contents = mainWindow.webContents;
    return contents.isDestroyed() ? undefined : contents;
  };
  const builds = new BuildService(workspaces, renderer);
  const language = new LanguageService(workspaces);
  app.on("will-quit", () => {
    updates?.dispose();
    language.dispose();
    builds.dispose();
  });
  app.on("window-all-closed", () => {
    language.cancel();
    builds.cancelAll();
  });
  const devices = new DeviceService(
    builds,
    renderer,
    await loadDevicePreferences(app.getPath("userData")),
  );
  const send = (channel: string, value: unknown) => {
    const target = renderer();
    if (target && !target.isDestroyed()) target.send(channel, value);
  };
  const monitor = new MonitorService(devices, (update) => send("device:monitor-update", update));
  const motors = new MotorTestService({
    run: (id, work) => devices.withMotorTest(id, work),
    recording: () => monitor.recordingSession !== undefined,
    publish: (state) => send("device:motor-test-update", state),
  });
  devices.setBeforeDisconnect((id) => motors.stopAll(id));
  let labBusy = false;
  const sensorLab = new SensorLabService({
    directory: path.join(app.getPath("userData"), "sensor-lab"),
    device: (id) => devices.descriptor(id),
    acquire: (id) => {
      if (motors.busy) throw new Error("Stop the motor test before recording.");
      return monitor.acquire(id);
    },
    release: (id) => monitor.release(id),
    latest: monitor.latest,
    publish: (state) => {
      labBusy = state.active || !state.saved;
      send("sensor-lab:state", state);
    },
  });
  // On macOS the application can outlive its last window. A quit in that state
  // still has to finish any crash recovery / background checkpoint writes.
  const mainQuit = new MainProcessCloseGuard(
    async () => {
      await motors.flush();
      await sensorLab.flush("close");
    },
    () => app.quit(),
    (error) => retryDeviceWork(error),
    () => {
      quitting = false;
    },
  );
  app.on("before-quit", (event) => {
    if (updates?.preparing) {
      event.preventDefault();
      return;
    }
    quitting = true;
    if (!updates?.installing && !mainQuit.ready && BrowserWindow.getAllWindows().length === 0) {
      event.preventDefault();
      void mainQuit.request();
    }
  });
  monitor.subscribe((update) => sensorLab.observe(update));
  devices.subscribe((event) => {
    const connectedId =
      event.type === "state" && event.state === "connected"
        ? event.sessionId
        : event.type === "usb-recovery" && event.state === "restored"
          ? event.sessionId
          : undefined;
    if (connectedId) void motors.reconnected(connectedId);
    const id =
      event.type === "state" && event.state === "disconnected"
        ? event.sessionId
        : event.type === "usb-recovery" && ["waiting", "unavailable"].includes(event.state)
          ? event.previousSessionId
          : undefined;
    if (id) {
      motors.disconnected(id);
      sensorLab.onDisconnect(id);
      void monitor.disconnect(id);
    }
  });
  powerMonitor.on("suspend", () => {
    void motors.stopAll();
    void sensorLab.suspend().catch(() => {});
  });
  void sensorLab.getState().catch(() => {});
  app.on("will-quit", () => {
    void monitor.dispose();
    void devices.reset();
  });
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window") return;
    contents.on("destroyed", () => {
      void sensorLab.stop("close").catch(() => {});
      void monitor.pause();
      void devices.reset();
    });
    contents.on("render-process-gone", () => {
      void sensorLab.stop("interrupted").catch(() => {});
      void monitor.pause();
      void devices.reset();
    });
    contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        void sensorLab.stop("interrupted").catch(() => {});
        void monitor.pause();
        void devices.reset();
      }
    });
  });
  const operationGate = new UpdateOperationGate(() => updates);
  updates = await createUpdateService(
    renderer,
    () =>
      operationGate.busy || builds.busy || devices.busy || monitor.busy || motors.busy || labBusy,
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
    { monitor, lab: sensorLab, motors },
  );
  const flushDeviceWork = async () => {
    await motors.flush();
    await sensorLab.flush("close");
  };
  const openWindow = () => {
    createWindow(flushDeviceWork);
    mainWindow?.on("blur", () => {
      void motors.stopAll();
    });
    mainWindow?.on("hide", () => {
      void motors.stopAll();
    });
    mainWindow?.on("minimize", () => {
      void motors.stopAll();
    });
  };
  openWindow();
  updates.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
