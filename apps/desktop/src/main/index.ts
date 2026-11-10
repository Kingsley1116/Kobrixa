import { DevicePreferencesStore } from "./device/preferences.js";
import { createUpdateService } from "./updates/runtime.js";
import { UpdateOperationGate, type UpdateService } from "./updates/service.js";
import { attachKeyboard } from "./window/keyboard.js";
import { registerWindowChromeIpc, WINDOWS_WINDOW_CHROME } from "./window/chrome.js";
import path from "node:path";
import {
  app,
  BrowserWindow,
  session,
  shell,
  powerMonitor,
  dialog,
  ipcMain,
  type MessageBoxOptions,
} from "electron";
import { BuildService } from "./workspace/build.js";
import { DeviceService } from "./device/device.js";
import { registerIpc, registerPersistenceWindow170, type IpcHandle } from "./ipc.js";
import { LanguageService } from "./language/language.js";
import { WorkspaceService } from "./workspace/workspace.js";
import { CloseHandshake } from "./window/close.js";
import { MonitorService } from "./device/monitor-service.js";
import { WorkbenchLifecycle } from "./window/workbench-lifecycle.js";
import { MainProcessCloseGuard } from "./window/main-close.js";
import { rendererContentSecurityPolicy } from "./window/csp.js";
import { resolveCollabServerUrl } from "./collab/server-url.js";
import { createCollabService } from "./collab/runtime.js";
import { CollabProjects } from "./collab/projects.js";
import { registerCollabIpc } from "./collab/ipc.js";
import { assembleBuiltinPluginSources } from "./plugins/builtin.js";
import { pluginLocale, pluginOptions } from "./plugins/options.js";
import { registerPluginIpc, registerCoreRecoveryIpc } from "./plugins/ipc.js";
import { registerUiIpc, registerUiEventIpc, trustedWorkbench } from "./plugins/ui-bridge.js";
import { attachNativeLifecycle, requireCleanClose } from "./plugins/shutdown-coordinator.js";
import { installPluginQuitCleanup, createQuitRecovery } from "./plugins/quit.js";
import {
  composeDesktopMain,
  desktopLifecycle,
  desktopUi,
  desktopDeviceAccess,
  desktopDeviceSettings,
  createWindowRetirementHandler,
  createLegacyActionAdmission,
  trustedDeviceActions,
  createDeviceLossHandler,
  type PluginController,
} from "./plugins/controller.js";
import { createDesktopFoundation } from "./device-broker/lifecycle-coordinator.js";
import { readDeviceRecoverySessions } from "./device-broker/broker.js";
import { createJournal } from "./device-broker/journal.js";
import { createJournalFilesystem } from "./device-broker/journal-filesystem.js";
import {
  createCoreActionLedger,
  CoreRecovery,
  createRecoveryEntries,
} from "./plugins/core-recovery.js";
import {
  createLegacyDevice,
  createLegacyMonitorFeed,
  createSessionPowerLifecycle,
} from "./device-broker/legacy-device.js";
import { LegacyFiles } from "./device-broker/legacy-files.js";
import type { CoreWindowScope, Principal } from "@kobrixa/plugin-runtime";
import type { Permission, ResourceOwner } from "@kobrixa/plugin-protocol";
import { electronPluginDialogs } from "./plugins/dialogs.js";
import { quitOnSignals } from "./plugins/session.js";
import { canonicalUserData } from "./user-data.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Keep the profile used by existing Forge distributions, including drafts and localStorage.
app.setPath(
  "userData",
  canonicalUserData(
    app.commandLine.getSwitchValue("user-data-dir") ||
      path.join(app.getPath("appData"), "@kobrixa/desktop"),
  ),
);
let updates: UpdateService | undefined;
let cancelUpdate: () => Promise<void> = async () => {};
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let closeHandshake: CloseHandshake | undefined;
let rendererCanFlush = false;
let reopenWindow: (() => void) | undefined;
const quitRecovery = createQuitRecovery({
  focus: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  },
  open: () => {
    reopenWindow?.();
  },
  retry: (error) => retryDeviceWork(error, mainWindow),
  quit: () => app.quit(),
});

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

function createWindow(flushDeviceWork: () => Promise<void>): void {
  rendererCanFlush = false;
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    backgroundColor: "#18212b",
    title: "Kobrixa",
    ...(process.platform === "win32" ? WINDOWS_WINDOW_CHROME : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const window = mainWindow;
  if (process.platform === "win32") window.removeMenu();
  const finish = () => {
    if (quitting) app.quit();
    else window.close();
  };
  const mainClose = new MainProcessCloseGuard(
    flushDeviceWork,
    finish,
    (error) => retryDeviceWork(error, window),
    () => {
      quitting = false;
    },
  );
  const handshake = new CloseHandshake(
    (id) => window.webContents.send("workspace:before-close", id),
    () => {
      void mainClose.request();
    },
  );
  closeHandshake = handshake;
  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = undefined;
    closeHandshake = undefined;
    rendererCanFlush = false;
  });
  window.on("close", (event) => {
    if (updates?.installing || mainClose.ready) return;
    event.preventDefault();
    if (updates?.preparing) return;
    if (window.webContents.isCrashed() || !rendererCanFlush) {
      void mainClose.request();
    } else handshake.request();
  });
  window.webContents.on("render-process-gone", () => {
    void cancelUpdate().catch(console.error);
    handshake.reset();
  });
  window.webContents.on("did-start-loading", () => {
    rendererCanFlush = false;
    void cancelUpdate().catch(console.error);
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

const primary = startPrimary(
  app,
  async (profile) => {
    profile.assertHeld();
    const authority = new DeviceControlGate(new AuthorityContexts(profile.hostEpoch));
    const collabServerUrl = resolveCollabServerUrl();
    const contentSecurityPolicy = rendererContentSecurityPolicy(
      collabServerUrl,
      Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL),
    );
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy],
        },
      });
    });
    const workspaces = new WorkspaceService();
    const pluginSettings = pluginOptions(app.commandLine);
    const pluginLanguage = pluginLocale(app.getLocale());
    const now = () => performance.now();
    const operationGate = new UpdateOperationGate(() => updates);
    const workbenchState: { current?: WorkbenchLifecycle } = {};
    // The retired IPC writer starts empty and performs no startup file I/O.
    // Only the admitted migration mapper may read/validate the original file;
    // this store supplies the writer barrier, never authoritative preferences.
    const preferences = new DevicePreferencesStore();
    const journal = createJournal(createJournalFilesystem(app.getPath("userData")), profile);
    const currentCorePrincipal = () => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("No current workbench.");
      return authority.principal(mainWindow.webContents.id, "recovery");
    };
    const currentCoreScope = (): CoreWindowScope => {
      // Recovery and non-device UI can mount before the renderer reports its
      // document. Establish only the host-owned window identity here; open()
      // leaves device authority invalid until an actual document report arrives.
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("No current workbench.");
      authority.open(mainWindow.webContents);
      const principal = currentCorePrincipal();
      if (principal.kind !== "core") throw new Error("Core workbench required.");
      return { hostEpoch: principal.hostEpoch, workbenchInstance: principal.workbenchInstance };
    };
    const isCurrentCoreScope = (scope: CoreWindowScope) => {
      try {
        const current = currentCoreScope();
        return (
          current.hostEpoch === scope.hostEpoch &&
          current.workbenchInstance === scope.workbenchInstance
        );
      } catch {
        return false;
      }
    };
    const coreActions = createCoreActionLedger({ now, current: isCurrentCoreScope });
    const controller: { current?: PluginController } = {};
    const requirements = (owner: ResourceOwner) =>
      controller.current ? desktopDeviceAccess(controller.current).requirements(owner) : null;
    const corePermissions = new Set<Permission>([
      "devices.read",
      "devices.connect",
      "devices.control",
    ]);
    const hasPermission = (principal: Principal, permission: Permission) => {
      if (principal.kind === "plugin")
        return (
          !!controller.current &&
          desktopDeviceAccess(controller.current).hasPermission(principal.owner, permission)
        );
      return isCurrentCoreScope(principal) && corePermissions.has(permission);
    };
    const pluginPrincipal = (owner: ResourceOwner): Principal => {
      try {
        if (mainWindow && !mainWindow.isDestroyed())
          return authority.contexts.plugin(mainWindow.webContents.id, owner);
      } catch {
        /* An unopened document grants no authority. */
      }
      return { kind: "plugin", owner, authorityContext: null };
    };
    // composeDesktopMain replaces this with the migration-gated authoritative reader.
    // Until attachment, no legacy/default policy can authorize optional I/O.
    const connectionPolicy = (): never => {
      throw new Error("Device settings are not attached.");
    };
    const reportCleanupError = (error: unknown) => {
      console.error("Device cleanup blocked.", error);
    };
    // The shipped plugin owns Lab from this release onward. Disabling it must
    // never re-enable the old writer (including before an import is resumed).
    // No legacy Lab runtime exists in this binary. These hooks perform no I/O;
    // settled does not claim to flush another process or a live writer.
    // Keep the durable migration barrier and its original read-only source roots.
    const legacyLabWriter = Object.freeze({
      sourceKey: "builtin:kobrixa.sensor-lab",
      freezeAdmission() {},
      async settled() {},
    });
    const pendingComposition = composeDesktopMain({
      legacyDeviceWriter: {
        sourceKey: "builtin:kobrixa.device-ev3",
        freezeAdmission: () => preferences.freezeAdmission(),
        settled: () => preferences.settleMigration(),
      },
      legacyLabWriter,
      createFoundation: createDesktopFoundation,
      foundationOptions: {
        profile,
        authority: authority.contexts,
        journal,
        coreActions,
        now,
        hasPermission,
        requirements,
        connectionPolicy,
        operationGate: ({ operationClass }) => {
          try {
            operationGate.assertDevice(operationClass);
            if (
              workbenchState.current?.closing &&
              operationClass !== "safety-stop" &&
              operationClass !== "reconciliation"
            )
              throw new Error("The workbench is closing.");
            return { ok: true, value: null };
          } catch (error) {
            return {
              ok: false,
              error: {
                code: "PLUGIN_E_DEVICE_BUSY",
                message: error instanceof Error ? error.message : String(error),
                detail: {
                  kind: "device",
                  reason: "foreground",
                  dispatch: "not-sent",
                  stopConfirmation: "not-required",
                },
              },
            };
          }
        },
      },
      plugins: {
        userData: app.getPath("userData"),
        builtins: await assembleBuiltinPluginSources({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          buildRoot: __dirname,
        }),
        commandLine: pluginSettings,
        dialogs: electronPluginDialogs(() => mainWindow, pluginLanguage),
        locale: pluginLanguage,
      },
      principal: pluginPrincipal,
      scope: currentCoreScope,
      currentScope: isCurrentCoreScope,
      legacyFlush: () => legacyLabWriter.settled(),
      report: reportCleanupError,
    });
    installPluginQuitCleanup(
      app,
      async () => {
        const composition = await pendingComposition;
        await composition.dispose();
        await monitor.dispose();
      },
      (error) => {
        quitting = false;
        void quitRecovery.blocked(error).catch(reportCleanupError);
      },
    );
    const composition = await pendingComposition;
    const { broker } = composition.foundation;
    const plugins = composition.plugins;
    controller.current = plugins;
    const coordinator = desktopLifecycle(composition);
    const ui = desktopUi(composition);
    const focusRecovery = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    };
    ui.setRecoveryNavigation(focusRecovery);
    const recovery = new CoreRecovery({
      scope: currentCoreScope,
      actions: coreActions,
      now,
      entries: createRecoveryEntries({
        device: broker.recovery,
        sessions: async () => readDeviceRecoverySessions(broker),
        processes: () => plugins.state().plugins,
        confirmDevice: async (device) => {
          const window = mainWindow;
          if (!window || window.isDestroyed()) return false;
          const zh = pluginLanguage === "zh-TW";
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            buttons: zh ? ["確認為同一設備", "取消"] : ["Confirm same device", "Cancel"],
            message: zh ? "核對設備安全紀錄" : "Reconcile device safety record",
            detail: zh
              ? `請確認目前連線的「${device.name}」就是此紀錄的設備。核對會讀取停止狀態，不會重新執行動作。`
              : `Confirm that the connected device “${device.name}” is the device in this record. Reconciliation reads its stopped state and does not replay movement.`,
          });
          return result.response === 0;
        },
      }),
      openDetail: (_item, scope) => {
        if (isCurrentCoreScope(scope)) focusRecovery();
      },
    });
    const offDeviceRecovery = broker.recovery.subscribe(() => recovery.changed());
    const offProcessRecovery = plugins.onEvent((event) => {
      if (event.type === "state") recovery.changed();
    });
    let persistenceHandle: IpcHandle | undefined;
    let offPersistenceWindow: (() => void) | undefined;
    let offUi: (() => void) | undefined;
    // The persistence window outlives reloads: it retires and reattaches each
    // document itself, so only quit or a replacement window disposes it.
    const detachUi = () => {
      offUi?.();
    };
    app.on("quit", () => {
      detachUi();
      offPersistenceWindow?.();
      offPersistenceWindow = undefined;
      offDeviceRecovery();
      offProcessRecovery();
      plugins.finishSession();
    });
    quitOnSignals(process, () => app.quit());
    const renderer = () => {
      // Reading webContents itself throws once its BrowserWindow is destroyed.
      // Services may finish saving or disconnecting after the last window closes.
      if (!mainWindow || mainWindow.isDestroyed()) return undefined;
      const contents = mainWindow.webContents;
      return contents.isDestroyed() ? undefined : contents;
    };
    const builds = new BuildService(workspaces, renderer, undefined, (language, target) =>
      plugins.resolveCompiler(language, target),
    );
    const language = new LanguageService(workspaces, undefined, (language) =>
      plugins.resolveLanguageService(language),
    );
    const offLanguageStatus = language.onStatus((event) => {
      const target = renderer();
      if (target && !target.isDestroyed()) target.send("language:status-changed", event);
    });
    const offLanguagePlugins = plugins.onEvent((event) => {
      if (event.type === "state") void language.refresh().catch(console.error);
    });
    app.on("quit", () => {
      offLanguageStatus();
      offLanguagePlugins();
      updates?.dispose();
      language.dispose();
      builds.dispose();
    });
    app.on("window-all-closed", () => {
      language.cancel();
      builds.cancelAll();
    });
    const deviceSettings = desktopDeviceSettings(composition);
    const devices = new DeviceService(builds, renderer, preferences, undefined, () => {
      const snapshot = deviceSettings.getSnapshot();
      if (snapshot.state !== "ready") throw new Error(snapshot.problem);
      // Preserve the existing six-field IPC shape; renderer-only preferences stay private
      // to the contributed settings resource. Core deploy reads this same committed view.
      const {
        skipUnchangedAssets,
        usbAutoReconnect,
        usbRetryInterval,
        usbRetryLimit,
        wifiConnectTimeout,
        wifiHandshakeTimeout,
      } = snapshot.values;
      return {
        skipUnchangedAssets,
        usbAutoReconnect,
        usbRetryInterval,
        usbRetryLimit,
        wifiConnectTimeout,
        wifiHandshakeTimeout,
      };
    });
    const send = (channel: string, value: unknown) => {
      const target = renderer();
      if (target && !target.isDestroyed()) target.send(channel, value);
    };
    const feed = createLegacyMonitorFeed(broker);
    const legacyAdmission = createLegacyActionAdmission(
      trustedDeviceActions(broker, coordinator, coreActions),
    );
    const legacy = createLegacyDevice({
      broker,
      principal: currentCorePrincipal,
      disconnect: legacyAdmission.disconnect,
      stop: legacyAdmission.stop,
      feed,
    });
    const admittedDeviceActions = legacyAdmission.bind(legacy);
    devices.attachLegacy({
      device: legacy,
      files: new LegacyFiles(broker, (operationClass) => {
        const principal = currentCorePrincipal();
        if (principal.kind !== "core") throw new Error("Core operation owner required.");
        return {
          ...principal,
          adapter:
            operationClass === "program-launch"
              ? "program"
              : operationClass === "deployment"
                ? "deployment"
                : "remote-files",
        };
      }),
    });
    const monitor = new MonitorService(legacy, (update) => send("device:monitor-update", update));
    // On macOS the application can outlive its last window. A quit in that state
    // still has to finish any crash recovery / background checkpoint writes.
    const mainQuit = new MainProcessCloseGuard(
      () => requireCleanClose(ui.coordinator, "shutdown"),
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
    devices.subscribe(
      createDeviceLossHandler(
        (id) => {
          void monitor.disconnect(id).catch(reportCleanupError);
        },
        () => {},
      ),
    );
    const powerSessions = createSessionPowerLifecycle({
      sessionIds: () => legacy.sessionIds(),
      suspend: (id) => coordinator.suspend(id),
      resume: (id) => coordinator.resume(id),
    });
    powerMonitor.on("suspend", () => {
      ui.intent.dispose();
      void powerSessions.suspend().catch(reportCleanupError);
    });
    powerMonitor.on("resume", () => {
      // Resume only the original suspended receipts, never a newly connected replacement.
      void powerSessions.resume().catch(reportCleanupError);
    });
    const collab = await createCollabService(app.getPath("userData"), collabServerUrl);
    updates = await createUpdateService(
      renderer,
      () => operationGate.busy || builds.busy || devices.busy || monitor.busy,
    );
    const workbench = new WorkbenchLifecycle({
      sessions: async () => {
        currentCoreScope();
        const result = await broker.request(
          currentCorePrincipal(),
          "devices/list",
          {},
          new AbortController().signal,
        );
        if (!result.ok) throw new Error(result.error.message);
        return result.value.sessions
          .filter((session) => session.state !== "disconnected")
          .map((session) => session.sessionId);
      },
      suspend: (id) => coordinator.suspend(id),
      verify: (id) => coordinator.confirmSuspended(id),
      retire: (reason) => (reason === "update" ? ui.prepareUpdate() : ui.prepareWindowClose()),
      resume: (id) => coordinator.resume(id),
      readmit: () => plugins.resume(),
    });
    workbenchState.current = workbench;
    const flushDeviceWork = () =>
      quitting ? requireCleanClose(ui.coordinator, "shutdown") : workbench.close();
    const installation = registerIpc(
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
        devices.publishSessionCatalog();
      },
      { monitor },
      [
        (handle) => {
          if (process.platform === "win32") registerWindowChromeIpc(handle, () => mainWindow);
        },
        (handle) =>
          registerCollabIpc(
            handle,
            collab,
            new CollabProjects(collab, workspaces, app.getPath("userData")),
          ),
        (handle) => {
          persistenceHandle = handle;
          registerPluginIpc(handle, plugins, (event) => send("plugins:event", event));
          registerUiIpc({
            handle,
            bridge: ui.bridge,
            trusted: (event) => {
              const current = renderer();
              return !!current && trustedWorkbench(event, current);
            },
          });
          const offRecovery = registerCoreRecoveryIpc(handle, recovery, () =>
            send("plugins:recovery:changed", null),
          );
          app.once("quit", offRecovery);
          offUi = registerUiEventIpc({
            handle,
            bridge: ui.bridge,
            trusted: (event) => {
              const current = renderer();
              return !!current && trustedWorkbench(event, current);
            },
            send,
          });
        },
      ],
      () => workbench.close("update"),
      plugins,
      {
        authority,
        stop: admittedDeviceActions.stop,
        disconnect: admittedDeviceActions.disconnect,
        beforeClose: flushDeviceWork,
      },
      flushDeviceWork,
      () => ui.prepareUpdate(),
      async () => {
        await workbench.reopen();
        await plugins.resume();
      },
    );
    cancelUpdate = () => installation.cancel();
    updates.onInstallationFailed(() => {
      void installation.failed().catch(reportCleanupError);
    });
    const attachPersistenceWindow = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const facets = plugins.persistence170;
        if (!facets || !persistenceHandle) throw new Error("P170 persistence not attached");
        offPersistenceWindow?.();
        // Native windows are recreated while global services stay alive. Replace only
        // these dedicated handlers and bind them to this original document and frame.
        const handle: IpcHandle = (channel, action) => {
          ipcMain.removeHandler(channel);
          persistenceHandle!(channel, action);
        };
        offPersistenceWindow = registerPersistenceWindow170({
          handle,
          facets,
          coreRecovery: recovery,
          renderer,
        });
      }
    };
    let opening: Promise<void> | undefined;
    const openWindow = () => {
      if (opening) return opening;
      const work = (async () => {
        await workbench.openWindow(() => {
          createWindow(flushDeviceWork);
          attachPersistenceWindow();
        }, reportCleanupError);
        primary?.windowReady();
        if (mainWindow) {
          const window = mainWindow,
            contents = window.webContents;
          const scope = () => {
            const principal = authority.principal(contents.id, "recovery");
            if (principal.kind !== "core") throw new Error("Core workbench required.");
            return {
              hostEpoch: principal.hostEpoch,
              workbenchInstance: principal.workbenchInstance,
            };
          };
          const retire = createWindowRetirementHandler({
            composition,
            coreActions,
            scope,
            invalidate: () => authority.invalidate(contents.id),
            flush: () => legacyLabWriter.settled(),
            pause: () => monitor.pause(),
          });
          const offNative = attachNativeLifecycle({
            window,
            contents,
            scope,
            owners: () => [],
            sessions: () => legacy.sessionIds(),
            revokeIntent: () => ui.intent.dispose(),
            revokeActions: (value) => {
              coreActions.retire(value);
              ui.actions.revokeWindow(value);
              detachUi();
            },
            windowLost: (_scope, destroyed) => retire(destroyed),
            replaceWorkbench: () => {},
            markUnresponsive: () => plugins.markRendererUnresponsive(),
            retire: (owner, reason) => coordinator.retire(owner, reason),
            suspend: (id) => coordinator.suspend(id),
            resume: (id) => coordinator.resume(id),
            failed: reportCleanupError,
          });
          contents.once("destroyed", offNative);
        }
        mainWindow?.on("blur", () => {
          ui.intent.dispose();
        });
        mainWindow?.on("hide", () => {
          ui.intent.dispose();
        });
        mainWindow?.on("minimize", () => {
          ui.intent.dispose();
        });
      })();
      opening = work;
      void work
        .finally(() => {
          if (opening === work) opening = undefined;
        })
        .catch(reportCleanupError);
      return work;
    };
    reopenWindow = () => {
      void openWindow().catch(reportCleanupError);
    };
    await openWindow();
    updates.start();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void openWindow().catch(reportCleanupError);
    });
  },
  quitRecovery.focus,
);
void primary?.ready.catch((error: unknown) => {
  console.error("Primary startup failed.", error);
  void retryDeviceWork(error);
});

if (primary)
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

import { startPrimary } from "./plugins/profile-writer-lock.js";
import { AuthorityContexts } from "./device-broker/authority-context.js";
import { DeviceControlGate } from "./collab/device-control.js";
