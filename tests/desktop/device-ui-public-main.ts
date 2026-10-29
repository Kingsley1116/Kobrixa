import assert from "node:assert/strict";
import path from "node:path";
import { realpath, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { app, BrowserWindow, ipcMain } from "electron";
import type { PluginLauncher } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  composeDesktopMain,
  createWindowRetirementHandler,
  desktopUi,
  desktopDeviceSettings,
  desktopFoundationTestHandles,
} from "../../apps/desktop/src/main/plugins/controller.js";
import {
  createDesktopFoundation,
  type DesktopMainComposition,
  type DesktopMainCompositionInput,
} from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import { AuthorityContexts } from "../../apps/desktop/src/main/device-broker/authority-context.js";
import { createFakeDeviceProvider } from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import { createJournal } from "../../apps/desktop/src/main/device-broker/journal.js";
import { createJournalFilesystem } from "../../apps/desktop/src/main/device-broker/journal-filesystem.js";
import { startPrimary } from "../../apps/desktop/src/main/plugins/profile-writer-lock.js";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";
import { BUILTIN_PLUGIN_SOURCES } from "../../apps/desktop/src/main/plugins/builtin.js";
import {
  resolveBuiltinLaunch,
  validateBuiltinLeaf,
} from "../../apps/desktop/src/main/plugins/builtin-launch.js";
import {
  createCoreActionLedger,
  CoreRecovery,
  createRecoveryEntries,
} from "../../apps/desktop/src/main/plugins/core-recovery.js";
import { registerCoreRecoveryIpc } from "../../apps/desktop/src/main/plugins/ipc.js";
import {
  registerUiIpc,
  registerUiEventIpc,
  trustedWorkbench,
  diagnosticsFor,
} from "../../apps/desktop/src/main/plugins/ui-bridge.js";
import {
  persistenceWorkerCount,
  diagnosticsFor as workerDiagnostics,
} from "../../apps/desktop/src/main/plugins/persistence/worker.js";
import { DevicePreferencesStore } from "../../apps/desktop/src/main/device/preferences.js";
import { registerPersistenceWindow170, type IpcHandle } from "../../apps/desktop/src/main/ipc.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
type Wire = {
  sequence: number;
  at: number;
  direction: "plugin-host" | "host-plugin";
  owner: ResourceOwner;
  message: ObjectValue;
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(
  check: () => T | Promise<T>,
  label: string,
  timeout = 15_000,
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    assert.ok(performance.now() < deadline, `Missing observation: ${label}`);
    await pause(25);
  }
}

/** Native producer only. Every device action traverses generic renderer -> preload -> host -> original SDK. */
export function runNativeDevice(): void {
  assert.equal(app.isReady(), false, "Primary lock must precede Electron readiness");
  const root = app.commandLine.getSwitchValue("device-root");
  const output = path.join(root, "producer.json");
  assert.ok(path.isAbsolute(root));
  app.setPath("userData", path.join(root, "profile"));
  const wire: Wire[] = [],
    ipc: ObjectValue[] = [],
    native: ObjectValue[] = [];
  const launches: ObjectValue[] = [],
    exits: ObjectValue[] = [],
    gate: ObjectValue[] = [];
  const logs: string[] = [],
    failures: string[] = [];
  const checkpoints: ObjectValue = {};
  const navigation: ObjectValue[] = [];
  const inputs: ObjectValue[] = [],
    legacyAudit: ObjectValue[] = [];

  const wall = () => performance.timeOrigin + performance.now();
  let sequence = 0,
    stage = "startup";
  let owner: ResourceOwner | undefined, win: BrowserWindow | undefined;
  let composition: DesktopMainComposition | undefined;
  const off: Array<() => void> = [],
    ipcNames: string[] = [];
  let cleanup: ObjectValue | undefined;
  function observingLauncher(hooks: Parameters<typeof createDesktopLauncher>[0]): PluginLauncher {
    const launch = createDesktopLauncher({
      ...hooks,
      onOutput(plugin, line) {
        hooks.onOutput?.(plugin, line);
        logs.push(line);
      },
    });
    return async (plugin) => {
      assert.ok(plugin.channelOwner);
      owner = structuredClone(plugin.channelOwner);
      const originalOwner = owner;
      launches.push({ owner: originalOwner, at: wall() });
      const process = await launch(plugin);
      process.onExit((exit) => exits.push({ owner: originalOwner, at: wall(), exit }));
      const record = (direction: Wire["direction"], text: string) =>
        wire.push({
          direction,
          sequence: ++sequence,
          at: wall(),
          owner: originalOwner,
          message: object(JSON.parse(text)),
        });
      return {
        ...process,
        onMessage(listener) {
          return process.onMessage((text) => {
            record("plugin-host", text);
            listener(text);
          });
        },
        send(text) {
          record("host-plugin", text);
          process.send(text);
        },
      };
    };
  }
  function exchanges(method: string, direction: Wire["direction"] = "plugin-host") {
    return wire
      .filter((row) => row.direction === direction && row.message.method === method)
      .flatMap((request) => {
        const response = wire.find(
          (row) =>
            row.sequence > request.sequence &&
            row.direction !== direction &&
            row.message.id === request.message.id &&
            !row.message.method,
        );
        return response ? [{ request, response }] : [];
      });
  }
  const success = (row: ReturnType<typeof exchanges>[number]) =>
    object(row.response.message.result).ok === true;
  const primary = startPrimary(
    app,
    async (profile) => {
      try {
        const launch = await resolveBuiltinLaunch({
          sourceKey: "builtin:kobrixa.device-ev3",
          pluginId: "kobrixa.device-ev3",
          slug: "device-ev3",
          packaged: false,
          appPath: root,
          buildRoot: root,
        });
        const leaf = await validateBuiltinLeaf(launch.packageRoot, launch.pluginId);
        const builtins = [
          ...BUILTIN_PLUGIN_SOURCES.filter(
            (source) =>
              source.kind !== "builtin" ||
              (source.manifest as { id: string }).id !== launch.pluginId,
          ),
          {
            kind: "builtin" as const,
            policy: "optional" as const,
            manifest: leaf.manifest,
            resources: leaf.resources,
            launch,
          },
        ];
        // Fresh barrier: never call the old catch/default file loader.
        const legacy = new DevicePreferencesStore();
        legacy.freezeAdmission();
        gate.push({ phase: "constructed-frozen", at: wall() });
        const authority = new AuthorityContexts(profile.hostEpoch);
        win = new BrowserWindow({
          width: 1100,
          height: 900,
          show: true,
          webPreferences: {
            preload: path.join(root, "preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        const window = win,
          sender = window.webContents.id;
        // Like product currentCoreScope: identity may exist before document authority.
        // Device authority remains invalid until the real main-frame document commits.
        const scope = () => {
          authority.open(sender);
          const p = authority.core(sender, "recovery");
          return { hostEpoch: p.hostEpoch, workbenchInstance: p.workbenchInstance };
        };
        const currentScope: DesktopMainCompositionInput["currentScope"] = (candidate) => {
          if (window.isDestroyed()) return false;
          const current = scope();
          return (
            candidate.hostEpoch === current.hostEpoch &&
            candidate.workbenchInstance === current.workbenchInstance
          );
        };
        const actions = createCoreActionLedger({
          now: () => performance.now(),
          current: currentScope,
        });
        const journal = createJournal(
          createJournalFilesystem(await realpath(app.getPath("userData"))),
          profile,
        );
        await journal.load();
        composition = await composeDesktopMain(
          {
            createFoundation: (options) =>
              createDesktopFoundation({
                ...options,
                providerFactory: (catalog) =>
                  (() => {
                    const fake = createFakeDeviceProvider({
                      catalog: {
                        ...catalog,
                        identify: (metadata) =>
                          catalog.identify({ ...metadata, portId: "input:0" }),
                      },
                      now: options.now,
                    });
                    const discover = fake.provider.discover.bind(fake.provider);
                    fake.provider.discover = async (...args) => {
                      const result = await discover(...args);
                      if (result.value)
                        for (const row of result.value)
                          row.descriptor = { ...row.descriptor, transport: "usb" };
                      return result;
                    };
                    const sources = fake.provider.sources.bind(fake.provider);
                    fake.provider.sources = async (...args) => {
                      const result = await sources(...args);
                      if (result.value)
                        for (const row of result.value.channels) row.portId = "input:0";
                      return result;
                    };
                    return fake.provider;
                  })(),
              }),
            foundationOptions: {
              profile,
              authority,
              journal,
              coreActions: actions,
              now: () => performance.now(),
              hasPermission: (p, permission) =>
                p.kind === "core"
                  ? currentScope(p) &&
                    ["devices.read", "devices.connect", "devices.control"].includes(permission)
                  : p.owner.sourceKey === launch.sourceKey &&
                    !!leaf.manifest.permissions?.includes(permission),
              requirements: (p) =>
                p.sourceKey === launch.sourceKey ? (leaf.manifest.requires?.devices ?? []) : null,
              connectionPolicy: () => {
                throw new Error("Authoritative device gate unavailable");
              },
              operationGate: () => ({ ok: true, value: null }),
            },
            plugins: {
              userData: app.getPath("userData"),
              builtins,
              locale: "en",
              commandLine: { developmentDirectories: [], safeMode: false },
              dialogs: {
                confirmDeveloperMode: async () => false,
                chooseFolder: async () => undefined,
                confirmLink: async () => false,
                confirmUnlink: async () => false,
                choosePython: async () => undefined,
              },
              launcher: observingLauncher,
            },
            principal: (p) => authority.plugin(sender, p),
            scope,
            currentScope,
            legacyFlush: async () => {},
            legacyDeviceWriter: {
              sourceKey: launch.sourceKey,
              freezeAdmission() {
                legacy.freezeAdmission();
                gate.push({ phase: "gate-freeze", at: wall() });
              },
              async settled() {
                await legacy.settleMigration();
                gate.push({ phase: "gate-settled", at: wall() });
              },
            },
            report: (error) => failures.push(String(error)),
          },
          { worker: { entry: path.join(root, "persistence-worker.cjs"), control() {} } },
        );
        const live = composition,
          ui = desktopUi(live),
          handles = desktopFoundationTestHandles(live);
        assert.equal(handles.recovery, "ready");
        assert.equal(handles.profile, handles.persistenceProfile);
        const trusted = (event: { sender: { id: number }; senderFrame: unknown }) =>
          !window.isDestroyed() && trustedWorkbench(event, window.webContents);
        const handle: IpcHandle = (name, action) => {
          ipcNames.push(name);
          ipcMain.handle(name, (...args: Parameters<typeof action>) => {
            assert.ok(trusted(args[0]));
            const row: ObjectValue = {
              channel: name,
              at: wall(),
              sequence: ++sequence,
              args: args.slice(1),
            };
            ipc.push(row);
            let result: ReturnType<typeof action>;
            try {
              result = action(...args);
            } catch (error) {
              row.error = String(error);
              row.finishedAt = wall();
              throw error;
            }
            void Promise.resolve(result).then(
              (result) => {
                row.result = result;
                row.finishedAt = wall();
              },
              (error) => {
                row.error = String(error);
              },
            );
            return result;
          });
        };
        registerUiIpc({ handle, bridge: ui.bridge, trusted });
        const send = (channel: string, event: unknown) => {
          if (!window.isDestroyed()) window.webContents.send(channel, event);
        };
        off.push(registerUiEventIpc({ handle, bridge: ui.bridge, trusted, send }));
        const recovery = new CoreRecovery({
          scope,
          now: () => performance.now(),
          actions,
          entries: createRecoveryEntries({
            device: live.foundation.broker.recovery,
            sessions: async () => {
              const result = await live.foundation.broker.request(
                authority.core(sender, "recovery"),
                "devices/list",
                {},
                new AbortController().signal,
              );
              assert.ok(result.ok);
              return result.value.sessions;
            },
            processes: () => live.plugins.state().plugins,
            confirmDevice: async () => false,
          }),
          openDetail() {
            throw new Error("Recovery detail is outside this happy-path harness");
          },
        });
        off.push(
          registerCoreRecoveryIpc(handle, recovery, () => send("plugins:recovery:changed", null)),
        );
        off.push(live.foundation.broker.recovery.subscribe(() => recovery.changed()));
        const originalSend = window.webContents.send.bind(window.webContents);
        window.webContents.send = (channel, ...args) => {
          if (channel === "plugins:settings:changed")
            ipc.push({ channel, direction: "publish", at: wall(), args });
          originalSend(channel, ...args);
        };
        off.push(() => {
          window.webContents.send = originalSend;
        });
        // The actual persistence adapter retires its initial frame on navigation.
        // Mirror product native lifecycle: retire the old scope BEFORE invalidating
        // authority. A new host identity alone does not grant device authority.
        const retireWindow = createWindowRetirementHandler({
          composition: live,
          scope,
          coreActions: actions,
          invalidate: () => authority.invalidate(sender),
          flush: async () => {}, // No legacy Lab writer or monitor in this synthetic shell.
          pause: async () => {},
        });
        let retirement = Promise.resolve();
        const navigationStarted = (
          _event: Electron.Event,
          _url: string,
          inPlace: boolean,
          mainFrame: boolean,
        ) => {
          if (!mainFrame || inPlace) return;
          const previous = scope();
          ui.intent.dispose();
          retirement = retireWindow(false);
          const row: ObjectValue = { at: wall(), previous, next: scope() };
          navigation.push(row);
          void retirement.then(
            () => {
              row.retiredAt = wall();
            },
            (error) => {
              row.error = String(error);
              failures.push(`document retirement: ${String(error)}`);
            },
          );
        };
        const documentCommitted = () => {
          const document = authority.open(sender);
          authority.report(sender, {
            document,
            sequence: 1,
            state: "local",
            roomId: null,
            connected: true,
            synced: true,
            role: null,
            isHolder: true,
          });
          const row = navigation.at(-1);
          if (row) {
            row.committedAt = wall();
            row.committed = scope();
          }
        };
        window.webContents.on("did-start-navigation", navigationStarted);
        window.webContents.on("did-navigate", documentCommitted);
        off.push(() => {
          window.webContents.removeListener("did-start-navigation", navigationStarted);
          window.webContents.removeListener("did-navigate", documentCommitted);
        });
        assert.ok(live.plugins.persistence170);
        off.push(
          registerPersistenceWindow170({
            handle,
            facets: live.plugins.persistence170,
            coreRecovery: recovery,
            renderer: () => window.webContents,
          }),
        );
        window.on("blur", () => ui.intent.dispose());
        window.on("hide", () => ui.intent.dispose());
        window.webContents.on("console-message", (detail) => {
          logs.push(`renderer:${detail.message}`);
          if (detail.message.startsWith("LEGACY_AUDIT:"))
            legacyAudit.push(object(JSON.parse(detail.message.slice(13))));
          if (detail.message.startsWith("NATIVE_INPUT:"))
            native.push({ ...object(JSON.parse(detail.message.slice(13))), sequence: ++sequence });
        });
        window.webContents.on("render-process-gone", (_, detail) =>
          failures.push(`Renderer exited early: ${JSON.stringify(detail)}`),
        );
        const settingsDigest = createHash("sha256")
          .update(await readFile(path.join(launch.packageRoot, "settings/preferences.json")))
          .digest("hex");
        await window.loadFile(path.join(root, "renderer/index.html"), {
          query: {
            digest: settingsDigest,
          },
        });
        await retirement;
        window.show();
        window.focus();
        window.webContents.focus();
        await until(() => window.isFocused(), "native focus");
        const js = <T>(source: string) =>
          window.webContents.executeJavaScript(source) as Promise<T>;
        const click = async (selector: string, text?: string, command?: string) => {
          const find = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${text === undefined ? "true" : `e.textContent.trim() === ${JSON.stringify(text)}`})`;
          await until(
            () =>
              js<boolean>(
                `(() => { const e=${find}; if(!e || e.disabled) return false; e.scrollIntoView({block:'center'}); return true; })()`,
              ),
            `enabled target ${selector} ${text ?? ""}`,
          );
          await pause(100);
          const bounds = await js<{
            x: number;
            y: number;
            node: string | null;
            targetId: number;
            ariaLabel: string | null;
          }>(
            `(() => { const e=${find}; const r=e.getBoundingClientRect(); if(e.disabled || r.width<=0 || r.height<=0) throw Error('Target unavailable'); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),node:e.closest("[data-ui-node]")?.getAttribute("data-ui-node") ?? null,targetId:window.deviceNativeTargetId(e),ariaLabel:e.getAttribute("aria-label")}; })()`,
          );
          inputs.push({
            command,
            selector,
            text,
            at: wall(),
            target: bounds,
            binding: state()?.binding,
          });
          for (const type of ["mouseDown", "mouseUp"] as const) {
            window.webContents.sendInputEvent({
              type,
              x: bounds.x,
              y: bounds.y,
              button: "left",
              clickCount: 1,
            });
            await pause(30);
          }
        };
        const state = () => {
          if (!owner) return;
          const binding = ui.states.instances(owner).find((b) => b.kind === "panel");
          if (!binding) return;
          const result = ui.states.state(owner, binding);
          return result.ok ? result.value : undefined;
        };
        const checkpoint = (name: string) => {
          checkpoints[name] = {
            at: wall(),
            sequence,
            state: state(),
            settings: desktopDeviceSettings(live).getSnapshot(),
            launches: launches.length,
          };
        };
        await until(
          () => desktopDeviceSettings(live).getSnapshot().state === "ready",
          "original nine-field migration",
        );
        checkpoint("migrated");
        assert.equal(launches.length, 0, "Capture must not activate feature");
        const migrated = desktopDeviceSettings(live).getSnapshot();
        assert.equal(migrated.state, "ready");
        if (migrated.state === "ready") assert.equal(migrated.values.skipUnchangedAssets, true);
        await click(".plugin-tools-pane button", "Open");
        await until(() => state()?.data.presentation, "original feature presentation");
        await pause(250);
        checkpoint("opened");
        assert.equal(exchanges("devices/connect").length, 0);
        assert.equal(exchanges("devices/discover").length, 0);
        await click('[data-close-contribution="true"]');
        await click(".plugin-tools-pane button", "Open");
        await until(() => state()?.data.presentation, "readonly reopen");
        checkpoint("reopened");
        assert.equal(exchanges("devices/connect").length, 0);
        assert.equal(exchanges("devices/discover").length, 0);
        const command = async (selector: string, name: string) => {
          const before = sequence;
          await click(selector, undefined, name);
          return until(
            () =>
              exchanges("command/invoke", "host-plugin").find(
                (row) =>
                  row.request.sequence > before &&
                  object(row.request.message.params).command === `kobrixa.device-ev3.${name}` &&
                  success(row),
              ),
            name,
          );
        };
        await command('[data-ui-node="discover-action"] button', "discover");
        await command('[data-ui-node="candidates"] tbody tr button', "candidate");
        await until(() => exchanges("devices/connect").some(success), "public connect");
        const refreshed = await command('[data-ui-node="refresh-action"] button', "refresh");
        await until(
          () =>
            exchanges("devices/read").some(
              (row) => row.request.sequence > refreshed.request.sequence && success(row),
            ),
          "public telemetry read after explicit refresh",
        );
        checkpoint("read");
        await command('[data-ui-node="modes-action"] button', "modes");
        await command('[data-ui-node="modes"] tbody tr button', "mode");
        await until(() => exchanges("devices/inputModes/set").some(success), "public mode write");
        checkpoint("mode");
        await click('[data-harness="settings"]');
        await until(
          () =>
            ipc.some(
              (row) => row.channel === "plugins:settings:watch" && row.finishedAt !== undefined,
            ),
          "actual bound settings watch",
        );
        await click('[id$="-field-0"]');
        await until(
          () =>
            ipc.some(
              (row) =>
                row.channel === "plugins:settings:update" && object(row.result ?? {}).ok === true,
            ),
          "actual settings CAS",
        );
        await until(() => {
          const snapshot = desktopDeviceSettings(live).getSnapshot();
          return snapshot.state === "ready" && snapshot.values.skipUnchangedAssets === false;
        }, "authoritative updated preference");
        checkpoint("updated");
        await click('.plugin-ui-node:has([id$="-field-0"]) button');
        await until(
          () =>
            ipc.some(
              (row) =>
                row.channel === "plugins:settings:reset" && object(row.result ?? {}).ok === true,
            ),
          "actual settings reset",
        );
        await until(() => {
          const snapshot = desktopDeviceSettings(live).getSnapshot();
          return snapshot.state === "ready" && snapshot.values.skipUnchangedAssets === true;
        }, "authoritative reset preference");
        checkpoint("reset");
        await click('[data-harness="settings"]');
        await until(
          () => ipc.some((row) => row.channel === "plugins:settings:unwatch"),
          "settings unwatch",
        );
        checkpoint("hiding");
        const beforeHide = sequence;
        const subscriptions = exchanges("devices/subscribe").filter(success);
        const removed = exchanges("events/unsubscribe").filter(
          (row) =>
            success(row) && object(object(row.response.message.result).value).removed === true,
        );
        const activeSubscriptions = subscriptions
          .map((row) => object(object(row.response.message.result).value).subscriptionId)
          .filter(
            (id) =>
              !removed.some((row) => object(row.request.message.params).subscriptionId === id),
          );
        assert.ok(activeSubscriptions.length > 0, "Live device observers before hide");
        assert.equal(new Set(activeSubscriptions).size, activeSubscriptions.length);
        assert.ok(activeSubscriptions.every((id) => typeof id === "string"));
        await click(".plugin-tools-pane > header button", "Close");
        await until(
          () =>
            activeSubscriptions.every((id) =>
              exchanges("events/unsubscribe").some(
                (row) =>
                  row.request.sequence > beforeHide &&
                  success(row) &&
                  object(row.request.message.params).subscriptionId === id &&
                  object(object(row.response.message.result).value).removed === true,
              ),
            ),
          "hidden observer unsubscribe",
        );
        checkpoint("hidden");
        await live.plugins.setEnabled(launch.sourceKey, false);
        await until(() => exits.length === launches.length, "disabled original process exit");
        checkpoint("disabled");
        await live.plugins.setEnabled(launch.sourceKey, true);
        await until(
          () => desktopDeviceSettings(live).getSnapshot().state === "ready",
          "authoritative re-admission",
        );
        await pause(300);
        checkpoint("reenabled");
        assert.equal(launches.length, 1, "Re-enable must not launch/replay hidden feature");
        assert.equal(exchanges("devices/connect").length, 1);
        stage = "cleanup";
        await live.dispose();
        cleanup = {
          bridge: diagnosticsFor(ui.bridge).snapshot(),
          worker: workerDiagnostics(handles.backend).snapshot(),
          workers: persistenceWorkerCount(handles.backend),
        };
        assert.equal(cleanup.workers, 0);
        for (const counters of [cleanup.bridge, cleanup.worker])
          for (const [key, value] of Object.entries(object(counters)))
            assert.equal(value, 0, `cleanup ${key}`);
        assert.deepEqual(failures, []);
        stage = "complete";
      } catch (error) {
        failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
        if (composition)
          await composition.dispose().catch((error) => failures.push(`cleanup: ${String(error)}`));
      } finally {
        for (const unsubscribe of off.reverse()) unsubscribe();
        for (const name of ipcNames) ipcMain.removeHandler(name);
        await writeFile(
          output,
          JSON.stringify(
            {
              schema: 1,
              stage,
              mainPid: process.pid,
              versions: process.versions,
              wire,
              ipc,
              native,
              launches,
              exits,
              gate,
              checkpoints,
              navigation,
              inputs,
              legacyAudit,
              cleanup,
              failures,
              logs,
            },
            null,
            2,
          ),
        );
        if (win && !win.isDestroyed()) win.destroy();
        app.exit(stage === "complete" ? 0 : 1);
      }
    },
    () => {
      if (!win || win.isDestroyed()) return false;
      win.focus();
      return true;
    },
  );
  assert.ok(primary, "Isolated profile primary lock unavailable");
  void primary.ready.catch(async (error) => {
    await writeFile(output, JSON.stringify({ stage, failures: [String(error)] }));
    app.exit(1);
  });
}
