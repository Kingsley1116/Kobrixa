import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, clipboard } from "electron";
import type { DrainOffer, DrainReport, PluginLauncher } from "@kobrixa/plugin-runtime";
import { pluginManifestSchema, type ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  composeDesktopMain,
  desktopUi,
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
import { assembleBuiltinPluginSources } from "../../apps/desktop/src/main/plugins/builtin.js";
import {
  createCoreActionLedger,
  CoreRecovery,
  createRecoveryEntries,
} from "../../apps/desktop/src/main/plugins/core-recovery.js";
import {
  registerCoreRecoveryIpc,
  registerPluginIpc,
} from "../../apps/desktop/src/main/plugins/ipc.js";
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
import type { IpcHandle } from "../../apps/desktop/src/main/ipc.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
function accepted(value: unknown): ObjectValue {
  const result = object(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  return object(result.value);
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

/** Native producer only. Every Lab action traverses generic renderer -> preload -> host -> original SDK. */
export function runInstalledLab(): void {
  assert.equal(app.isReady(), false, "Primary lock must precede Electron readiness");
  const root = app.commandLine.getSwitchValue("lab-root");
  const output = path.join(root, "producer.json");
  const scenario = app.commandLine.getSwitchValue("lab-scenario");
  assert.ok(["healthy", "absent", "missing-resource", "tampered"].includes(scenario));
  assert.ok(path.isAbsolute(root));
  app.setPath("userData", path.join(root, "profile"));
  const wire: Wire[] = [],
    ipc: ObjectValue[] = [],
    native: ObjectValue[] = [];
  const launches: ObjectValue[] = [],
    exits: ObjectValue[] = [],
    gate: ObjectValue[] = [];
  const drains: Array<{
    offer: DrainOffer;
    at: number;
    report?: DrainReport;
    finishedAt?: number;
  }> = [];
  const logs: string[] = [],
    failures: string[] = [];
  const checkpoints: ObjectValue = {};
  const brokerCalls: ObjectValue[] = [];
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
      assert.equal(plugin.entry, path.join(root, "plugins/sensor-lab/main.cjs"));
      assert.equal(await realpath(plugin.entry), plugin.entry);
      launches.push({
        owner: originalOwner,
        at: wall(),
        entry: plugin.entry,
        directory: plugin.directory,
        sha256: createHash("sha256")
          .update(await readFile(plugin.entry))
          .digest("hex"),
      });
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
        const probes: string[] = JSON.parse(process.env.LAB_SOURCE_PROBES ?? "[]");
        assert.ok(probes.length >= 2);
        for (const file of probes)
          await assert.rejects(readFile(file), (error: NodeJS.ErrnoException) =>
            ["EPERM", "EACCES"].includes(error.code ?? ""),
          );
        await new Promise<void>((resolve, reject) => {
          const socket = connect({
            host: "127.0.0.1",
            port: Number(process.env.LAB_NETWORK_PROBE),
          });
          socket.once("connect", () => {
            socket.destroy();
            reject(Error("Network sandbox did not deny connection"));
          });
          socket.once("error", (error: NodeJS.ErrnoException) => {
            if (["EPERM", "EACCES"].includes(error.code ?? "")) resolve();
            else reject(error);
          });
          socket.setTimeout(2000, () => {
            socket.destroy();
            reject(Error("Network probe timed out; denial unproven"));
          });
        });
        await new Promise<void>((resolve, reject) =>
          execFile("node", ["--version"], (error) => {
            if (error && "code" in error && error.code === "ENOENT") resolve();
            else reject(Error("PATH Node not absent"));
          }),
        );
        checkpoints.isolation = {
          sourceDenied: true,
          networkDenied: true,
          noPathNode: true,
          probes,
        };
        // Product assembler must reject negative artifacts, not a fixture-only parser.
        const builtins = await assembleBuiltinPluginSources({
          packaged: false,
          appPath: root,
          buildRoot: root,
        });
        const source = builtins.find(
          (row) => row.kind === "builtin" && object(row.manifest).id === "kobrixa.sensor-lab",
        );
        assert.ok(source && source.kind === "builtin");
        const manifest = object(source.manifest);
        const requirements =
          scenario === "healthy"
            ? (pluginManifestSchema.parse(source.manifest).requires?.devices ?? [])
            : [];
        const sourceKey = "builtin:kobrixa.sensor-lab";
        // This fixture has no legacy writer. Preserve the durable importer barrier,
        // but never initialize/repair the original files or pretend to flush live work.
        const legacy = Object.freeze({
          freezeAdmission() {},
          async settleMigration() {},
        });
        legacy.freezeAdmission();
        gate.push({ phase: "constructed-frozen", writer: "retired", at: wall() });
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
        const preferences = (
          window.webContents as unknown as {
            getLastWebPreferences(): {
              sandbox?: boolean;
              contextIsolation?: boolean;
              nodeIntegration?: boolean;
            };
          }
        ).getLastWebPreferences();
        assert.ok(
          preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration,
        );
        assert.ok(
          !app.commandLine.hasSwitch("no-sandbox") &&
            !app.commandLine.hasSwitch("disable-setuid-sandbox"),
        );
        checkpoints.chromiumSandbox = true;
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
        const scope = () => {
          const p = authority.core(sender, "recovery");
          return { hostEpoch: p.hostEpoch, workbenchInstance: p.workbenchInstance };
        };
        const currentScope: DesktopMainCompositionInput["currentScope"] = (candidate) =>
          !window.isDestroyed() &&
          candidate.hostEpoch === scope().hostEpoch &&
          candidate.workbenchInstance === scope().workbenchInstance;
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
                providerFactory: (catalog) => {
                  const provider = createFakeDeviceProvider({ catalog, now: options.now }).provider;
                  const original = provider.sources.bind(provider);
                  provider.sources = async (session, context) => {
                    const result = await original(session, context);
                    for (const channel of result.value?.channels ?? []) {
                      channel.portId = "input:0";
                      channel.typeId = "ev3:29";
                      channel.modeId = "mode:0";
                      channel.channelId = catalog.identify({
                        sessionId: result.value!.sessionId,
                        portId: channel.portId,
                        typeId: channel.typeId,
                        modeId: channel.modeId,
                        component: channel.component,
                        unit: channel.unit,
                      });
                    }
                    return result;
                  };
                  return provider;
                },
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
                  : p.owner.sourceKey === sourceKey &&
                    Array.isArray(manifest.permissions) &&
                    manifest.permissions.includes(permission),
              requirements: (p) => (p.sourceKey === sourceKey ? requirements : null),
              connectionPolicy: () => ({
                wifiConnectTimeoutMs: 10_000,
                wifiHandshakeTimeoutMs: 5_000,
                usbAutoReconnect: false,
                usbRetryInterval: 2000,
                usbRetryLimit: 3,
              }),
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
            legacyLabWriter: {
              sourceKey: sourceKey,
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
          {
            worker: { entry: path.join(root, "persistence-worker.cjs"), control() {} },
            // Only destination selection is substituted. Real action claim, export job,
            // output staging/fsync/rename and receipts remain production implementations.
            nativeActions: {
              choose: async (suggestedName) => {
                checkpoints.exportChoice = { suggestedName, at: wall() };
                return path.join(root, "export.csv");
              },
              copy: (text) => clipboard.writeText(text),
            },
          },
        );
        const live = composition,
          ui = desktopUi(live),
          handles = desktopFoundationTestHandles(live);
        assert.equal(handles.recovery, "ready");
        assert.equal(handles.profile, handles.persistenceProfile);
        if (scenario !== "healthy") {
          const row = live.plugins.state().plugins.find((p) => p.sourceKey === sourceKey);
          assert.equal(row?.status, "invalid");
          assert.ok(row?.problems.some((p) => p.code === "PLUGIN_E_ENTRY"));
          const catalog = await ui.bridge.catalog({});
          assert.ok(catalog.ok);
          assert.ok(!catalog.value.entries.some((e) => e.pluginId === "kobrixa.sensor-lab"));
          assert.equal(launches.length, 0);
          checkpoints.negative = { row, catalog, at: wall() };
          await live.dispose();
          cleanup = {
            bridge: diagnosticsFor(ui.bridge).snapshot(),
            worker: workerDiagnostics(handles.backend).snapshot(),
            workers: persistenceWorkerCount(handles.backend),
          };
          stage = "complete";
          return;
        }
        const broker = live.foundation.broker;
        const originalRequest = broker.request.bind(broker);
        broker.request = (principal, method, params, signal) => {
          if (method !== "devices/recording/release")
            return originalRequest(principal, method, params, signal);
          const call: ObjectValue = {
            principal: structuredClone(principal),
            method,
            params: structuredClone(params),
            at: wall(),
          };
          brokerCalls.push(call);
          const result = originalRequest(principal, method, params, signal);
          void result.then(
            (reply) => {
              call.result = structuredClone(reply);
            },
            (error) => {
              call.error = String(error);
            },
          );
          return result;
        };
        off.push(() => {
          broker.request = originalRequest;
        });
        const participant = handles.host.participant,
          originalDrain = participant.drain;
        participant.drain = function (offer, dispatch) {
          const row: (typeof drains)[number] = { offer: structuredClone(offer), at: wall() };
          drains.push(row);
          return originalDrain.call(this, offer, dispatch).then((report) => {
            row.report = structuredClone(report);
            row.finishedAt = wall();
            return report;
          });
        };
        off.push(() => {
          participant.drain = originalDrain;
        });
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
            const result = action(...args);
            void Promise.resolve(result).then(
              (result) => {
                row.result = result;
              },
              (error) => {
                row.error = String(error);
              },
            );
            return result;
          });
        };
        off.push(
          registerPluginIpc(handle, live.plugins, (event) => {
            if (!window.isDestroyed()) window.webContents.send("plugins:event", event);
          }),
        );
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
        window.on("blur", () => ui.intent.dispose());
        window.on("hide", () => ui.intent.dispose());
        window.webContents.on("console-message", (detail) => {
          logs.push(`renderer:${detail.message}`);
          if (detail.message.startsWith("NATIVE_INPUT:"))
            native.push({ ...object(JSON.parse(detail.message.slice(13))), sequence: ++sequence });
        });
        window.webContents.on("render-process-gone", (_, detail) =>
          failures.push(`Renderer exited early: ${JSON.stringify(detail)}`),
        );
        accepted(
          await live.foundation.broker.request(
            authority.core(sender, "recovery"),
            "devices/connect",
            {
              target: {
                kind: "wifi-address",
                providerId: "kobrixa.device-ev3",
                address: "127.0.0.1",
              },
            },
            new AbortController().signal,
          ),
        );
        await window.loadFile(path.join(root, "renderer/index.html"));
        window.show();
        window.focus();
        window.webContents.focus();
        await until(() => window.isFocused(), "native focus");
        const js = <T>(source: string) =>
          window.webContents.executeJavaScript(source) as Promise<T>;
        const click = async (selector: string, text?: string) => {
          const find = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${text === undefined ? "true" : `e.textContent.trim() === ${JSON.stringify(text)}`})`;
          await until(
            () =>
              js<boolean>(
                `(() => { const e=${find}; if(!e || e.disabled) return false; e.scrollIntoView({block:'center'}); return true; })()`,
              ),
            `enabled target ${selector} ${text ?? ""}`,
          );
          await pause(100);
          const bounds = await js<{ x: number; y: number }>(
            `(() => { const e=${find}; const r=e.getBoundingClientRect(); if(e.disabled || r.width<=0 || r.height<=0) throw Error('Target unavailable'); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
          );
          checkpoints[`input-${sequence}`] = { stage, selector, text, at: wall() };
          for (const type of ["mouseDown", "mouseUp"] as const) {
            window.webContents.sendInputEvent({ type, ...bounds, button: "left", clickCount: 1 });
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
        const edit = async (key: string, value: string) => {
          await click(`[data-ui-node="${key}"] input`);
          // This isolated shell has no application Edit menu/accelerator.
          // Use Chromium's native editing command on the actually focused input;
          // do not set DOM values or synthesize DOM input events.
          window.webContents.selectAll();
          await until(
            () =>
              js<boolean>(
                `(() => { const e=document.activeElement; return e instanceof HTMLInputElement && e.selectionStart===0 && e.selectionEnd===e.value.length; })()`,
              ),
            `native selection ${key}`,
          );
          await window.webContents.insertText(value);
          await until(
            async () =>
              state()?.form[key] === value &&
              (await js<boolean>(`document.activeElement?.value === ${JSON.stringify(value)}`)),
            `canonical draft ${key}`,
          );
        };
        const command = async (node: string, name = node) => {
          const before = sequence;
          await click(`[data-ui-node="${node}"] button`);
          await until(
            () =>
              exchanges("command/invoke", "host-plugin").find(
                (row) =>
                  row.request.sequence > before &&
                  object(row.request.message.params).command === `kobrixa.sensor-lab.${name}` &&
                  success(row),
              ),
            `successful ${name}`,
          );
        };
        stage = "open";
        await click('.plugin-tools-pane [role="tabpanel"] > button', "Open");
        await until(() => state(), "original panel snapshot");
        checkpoints.open = { at: wall(), state: state(), owner };
        stage = "source-selection";
        await command("select-current");
        const beforeSelect = sequence;
        await click('[data-ui-node="available"] tbody button');
        await until(
          () =>
            exchanges("command/invoke", "host-plugin").find(
              (r) =>
                r.request.sequence > beforeSelect &&
                object(r.request.message.params).command === "kobrixa.sensor-lab.select-channel" &&
                success(r),
            ),
          "select channel",
        );
        stage = "draft-capture-apply";
        await click('[data-ui-node="two-point"] input');
        await until(() => state()?.form["two-point"] === true, "two-point canonical draft");
        await edit("source-b", "100");
        await edit("target-a", "0");
        await edit("target-b", "200");
        await command("capture-a");
        await until(
          () => state()?.form["source-a"] === "42",
          "Capture A fresh fake-provider raw reading",
        );
        await command("apply");
        checkpoints.applied = { at: wall(), state: state() };
        stage = "copy-code";
        const beforeCopy = sequence;
        const displayed = await until(
          () =>
            js<string>(`(() => {
            const node = document.querySelector('[data-ui-node="code"]');
            const button = node?.querySelector('button');
            return button && !button.disabled ? node.querySelector('code')?.textContent ?? '' : '';
          })()`),
          "current draft code rendered with enabled copy",
        );
        await click('[data-ui-node="code"] button');
        const copied = await until(
          () =>
            exchanges("ui/copyText").find(
              (row) => row.request.sequence > beforeCopy && success(row),
            ),
          "actual clipboard copy",
        );
        checkpoints.copy = {
          at: wall(),
          params: copied.request.message.params,
          text: await clipboard.readText(),
          displayed,
        };
        assert.equal(
          checkpoints.copy && object(checkpoints.copy).text,
          object(copied.request.message.params).text,
        );
        await edit("recording-name", "D7 actual Lab");
        stage = "start";
        await command("start");
        await until(
          () => exchanges("storage/registerCheckpoint").some(success),
          "original registered recording checkpoint",
        );
        await until(
          () => exchanges("devices/recording/read").some(success),
          "original recording read",
        );
        checkpoints.started = { at: wall(), sequence, state: state() };
        stage = "background-close";
        await click('[data-close-contribution="true"]');
        await until(() => !state(), "panel removed while process stays alive");
        const backgroundStart = sequence;
        await pause(650);
        assert.equal(exits.length, 0);
        assert.equal(launches.length, 1);
        assert.equal(exchanges("devices/recording/release").length, 0);
        await until(
          () =>
            exchanges("devices/recording/read").some(
              (r) =>
                r.request.sequence > backgroundStart &&
                success(r) &&
                Array.isArray(accepted(r.response.message.result).frames) &&
                (accepted(r.response.message.result).frames as unknown[]).length > 0,
            ),
          "recording progresses after panel close",
        );
        checkpoints.background = {
          at: wall(),
          sequence,
          owner,
          launchCount: launches.length,
          exitCount: exits.length,
        };
        stage = "status-core-stop";
        await click("#lab-status button", "Stop recording");
        await until(
          () => drains.some((d) => d.report?.state === "saved"),
          "actual host saved drain",
          25_000,
        );
        checkpoints.saved = { at: wall(), sequence };
        stage = "reopen-history";
        await click('.plugin-tools-pane [role="tabpanel"] > button', "Open");
        await until(() => state(), "reopened panel");
        checkpoints.reopened = { at: wall(), state: state() };
        await command("refresh");
        await until(
          () =>
            exchanges("storage/stat").some(
              (row) =>
                success(row) &&
                object(accepted(row.response.message.result).record).checkpoint === "final",
            ),
          "SDK final stat",
        );
        const historyAt = wall();
        await click('[data-ui-node="history"] button', "View");
        await until(
          () =>
            exchanges("command/invoke", "host-plugin").some(
              (r) =>
                object(r.request.message.params).command === "kobrixa.sensor-lab.view-record" &&
                success(r),
            ),
          "history view command and verified read",
        );
        await until(
          () =>
            exchanges("storage/readChunk").some(
              (row) => success(row) && accepted(row.response.message.result).eof === true,
            ),
          "full SDK history read",
        );
        await until(
          () =>
            ipc.some(
              (row) =>
                row.channel === "plugins:ui:data-read" &&
                Number(row.at) > historyAt &&
                object(row.result ?? {}).ok === true &&
                object(accepted(row.result).header).view === "full",
            ),
          "renderer reads saved full-domain data after history selection",
        );
        await until(
          () => js<boolean>('!!document.querySelector("[data-ui-node=chart0] svg")'),
          "generic history chart",
        );
        checkpoints.history = {
          at: wall(),
          state: state(),
          text: await js<string>("document.body.innerText"),
        };
        stage = "export";
        await command("export");
        await until(
          () => exchanges("storage/exportCommit").some(success),
          "actual export commit",
          25_000,
        );
        checkpoints.export = {
          at: wall(),
          bytes: (await readFile(path.join(root, "export.csv"))).toString("base64"),
        };
        stage = "disable-reenable";
        const firstOwner = structuredClone(owner);
        await click('[data-installed-management="disable"]');
        const disabled = await until(
          () =>
            ipc.find(
              (row) =>
                row.channel === "plugins:set-enabled" &&
                row.args &&
                (row.args as unknown[])[1] === false &&
                row.result,
            )?.result,
          "disable management reply",
        );
        assert.equal(object(disabled).ok, true);
        await until(() => exits.length === 1, "disabled original process exit");
        const disabledState = live.plugins.state();
        await click('[data-installed-management="enable"]');
        const enabled = await until(
          () =>
            ipc.find(
              (row) =>
                row.channel === "plugins:set-enabled" &&
                row.args &&
                (row.args as unknown[])[1] === true &&
                row.result,
            )?.result,
          "enable management reply",
        );
        assert.equal(object(enabled).ok, true);
        // onPanel activation: re-enable itself must not replay start or launch eagerly.
        await pause(350);
        assert.equal(launches.length, 1);
        await click('.plugin-tools-pane [role="tabpanel"] > button', "Open");
        await until(() => launches.length === 2 && state(), "explicit new panel generation");
        assert.notDeepEqual(owner, firstOwner);
        await pause(350);
        assert.equal(exchanges("devices/recording/reserve").length, 1);
        checkpoints.management = {
          at: wall(),
          disabled,
          disabledState,
          enabled,
          firstOwner,
          newOwner: owner,
        };
        stage = "cleanup";
        await live.dispose();
        await until(() => exits.length === launches.length, "original SDK exits");
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
        if (composition) checkpoints.failureState = composition.plugins.state();
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
              scenario,
              hostKind: "installed-payload-acceptance-host",
              saveDialog: "isolated-destination-substitution",
              management: "native-input-preload-production-management-ipc",
              quit: "composition-dispose-then-app-quit",
              stage,
              versions: process.versions,
              wire,
              ipc,
              native,
              launches,
              exits,
              gate,
              brokerCalls,
              drains,
              checkpoints,
              cleanup,
              failures,
              logs,
            },
            null,
            2,
          ),
        );
        if (win && !win.isDestroyed()) win.destroy();
        if (stage === "complete") app.quit();
        else app.exit(1);
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
