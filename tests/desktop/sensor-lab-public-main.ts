import assert from "node:assert/strict";
import path from "node:path";
import { realpath, writeFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import type { DrainOffer, DrainReport, PluginLauncher } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
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
import { SensorLabService } from "../../apps/desktop/src/main/sensor-lab/service.js";
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
export function runNativeLab(): void {
  assert.equal(app.isReady(), false, "Primary lock must precede Electron readiness");
  const root = app.commandLine.getSwitchValue("lab-root");
  const output = path.join(root, "producer.json");
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
          sourceKey: "builtin:kobrixa.sensor-lab",
          pluginId: "kobrixa.sensor-lab",
          slug: "sensor-lab",
          packaged: false,
          appPath: root,
          buildRoot: root,
        });
        const leaf = await validateBuiltinLeaf(launch.packageRoot, launch.pluginId);
        const builtins = [
          ...BUILTIN_PLUGIN_SOURCES,
          {
            kind: "builtin" as const,
            policy: "optional" as const,
            manifest: leaf.manifest,
            resources: leaf.resources,
            launch,
          },
        ];
        const legacy = new SensorLabService({
          directory: path.join(app.getPath("userData"), "sensor-lab"),
          device() {
            throw new Error("Legacy device must never be used");
          },
          acquire() {
            throw new Error("Legacy acquisition must never run");
          },
          release() {
            throw new Error("Legacy release must never run");
          },
          publish() {
            throw new Error("Legacy publisher must never run");
          },
        });
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
                providerFactory: (catalog) =>
                  createFakeDeviceProvider({ catalog, now: options.now }).provider,
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
          const bounds = await js<{
            x: number;
            y: number;
            targetId: number;
            ariaLabel: string | null;
          }>(
            `(() => { const e=${find}; const r=e.getBoundingClientRect(); if(e.disabled || r.width<=0 || r.height<=0) throw Error('Target unavailable'); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),targetId:window.labNativeTargetId(e),ariaLabel:e.getAttribute("aria-label")}; })()`,
          );
          checkpoints[`input-${sequence}`] = {
            stage,
            selector,
            text,
            at: wall(),
            targetId: bounds.targetId,
            ariaLabel: bounds.ariaLabel,
          };
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
          sequence,
          state: state(),
          text: await js<string>("document.body.innerText"),
        };
        // Selected D7 parity only; all mutations remain trusted generic UI actions.
        const steps: ObjectValue[] = [];
        const parity: ObjectValue = { steps };
        checkpoints.parity = parity;
        const step = async (name: string, action: () => Promise<void>) => {
          stage = `parity-${name}`;
          const row: ObjectValue = { name, at: wall(), before: sequence };
          steps.push(row);
          await action();
          row.finishedAt = wall();
          row.after = sequence;
        };
        const latestPage = (dataset: string) =>
          ipc
            .filter(
              (row) =>
                row.channel === "plugins:ui:data-read" &&
                object((row.args as unknown[])[0]).dataset === dataset &&
                object(row.result ?? {}).ok === true,
            )
            .at(-1);
        const rowAction = async (dataset: string, id: string, label: string, name: string) => {
          const before = sequence;
          await click(
            `[data-ui-node="${dataset}"] button[aria-label=${JSON.stringify(`${label}: ${id}`)}]`,
          );
          if (label === "Delete") await click('[role="dialog"] button', "Delete");
          await until(
            () =>
              exchanges("command/invoke", "host-plugin").some(
                (row) =>
                  row.request.sequence > before &&
                  object(row.request.message.params).command === `kobrixa.sensor-lab.${name}` &&
                  success(row),
              ),
            name,
          );
          if (label === "Delete") {
            // Confirmation dispatches a command; the generic modal stays open until Close.
            // A successful plugin reply is not evidence that its backdrop is gone.
            await click('[role="dialog"] button', "Close");
            await until(
              () => js(`!document.querySelector('[role="dialog"]')`),
              `${name} dialog closed`,
            );
          }
        };
        const finalRecords = () =>
          exchanges("storage/commitWrite")
            .filter(success)
            .map((row) => object(accepted(row.response.message.result).record))
            .filter((meta) => meta.kind === "sensor-lab.recording" && meta.checkpoint === "final");
        const first = finalRecords()[0]!;
        assert.ok(first);
        parity.first = first;
        await step("live-profile", () => command("live"));
        await edit("profile-name", "D7 saved calibration");
        await step("save-profile", () => command("save-profile"));
        const calibrationProfile = await until(
          () =>
            exchanges("storage/commitWrite")
              .filter(success)
              .map((row) => object(accepted(row.response.message.result).record))
              .find((meta) => meta.kind === "sensor-lab.calibration"),
          "saved calibration metadata",
        );
        parity.profile = calibrationProfile;
        await step("list-profile", () => command("refresh"));
        await until(() => latestPage("profiles"), "profile dataset");
        await step("reset-profile", () => command("reset"));
        await step("apply-profile", () =>
          rowAction("profiles", String(calibrationProfile.id), "Apply", "apply-profile"),
        );
        await until(
          () => state()?.form["source-a"] === "42" && state()?.form["target-b"] === "200",
          "restored profile calibration",
        );
        parity.applied = state();
        await step("delete-profile", () =>
          rowAction("profiles", String(calibrationProfile.id), "Delete", "delete-profiles"),
        );
        await step("live-second", () => command("live"));
        await edit("recording-name", "D7 comparison Lab");
        await step("start-second", () => command("start"));
        const secondReserve = exchanges("devices/recording/reserve").filter(success).at(-1)!;
        const secondId = object(
          accepted(secondReserve.response.message.result).reservation,
        ).reservationId;
        await until(
          () =>
            exchanges("devices/recording/read").some(
              (row) =>
                success(row) &&
                object(row.request.message.params).reservationId === secondId &&
                (accepted(row.response.message.result).frames as unknown[]).length > 0,
            ),
          "second recording frames",
        );
        await step("stop-second", async () => {
          const before = drains.length;
          await click("#lab-status button", "Stop recording");
          await until(
            () => drains.slice(before).some((d) => d.report?.state === "saved"),
            "second saved drain",
            25_000,
          );
        });
        const second = await until(
          () => finalRecords().find((meta) => meta.id !== first.id),
          "distinct second final record",
        );
        parity.second = second;
        await step("list-two", () => command("refresh"));
        await step("view-first", () =>
          rowAction("history", String(first.id), "View", "view-record"),
        );
        await step("compare-second", () =>
          rowAction("history", String(second.id), "Compare", "compare-record"),
        );
        const chart = async (calibrated: boolean) => {
          const before = wall();
          if (state()?.form.calibrated !== calibrated)
            await click('[data-ui-node="calibrated"] input');
          else {
            await click('[data-ui-node="calibrated"] input');
            await until(() => state()?.form.calibrated !== calibrated, "toggle chart mode");
            await click('[data-ui-node="calibrated"] input');
          }
          await until(() => state()?.form.calibrated === calibrated, "canonical chart mode");
          const page = await until(() => {
            const page = latestPage("chart0");
            if (!page || Number(page.at) <= before) return;
            const value = accepted(page.result);
            const entries = object(value.chunk).entries as number[][];
            return entries?.some((p) => p[0] === 0 && p[3] === (calibrated ? 0 : 42)) &&
              entries.some((p) => p[0] === 1 && p[3] === (calibrated ? 0 : 42))
              ? page
              : undefined;
          }, "two actual comparison series");
          parity[calibrated ? "calibrated" : "raw"] = { page, form: state()?.form };
        };
        await step("raw", () => chart(false));
        await step("calibrated", () => chart(true));
        await step("live-delete", () => command("live"));
        await step("fresh-history", () => command("refresh"));
        await step("delete-first", () =>
          rowAction("history", String(first.id), "Delete", "delete-history"),
        );
        await step("list-after-delete", () => command("refresh"));
        await until(() => {
          const page = latestPage("history");
          if (!page) return false;
          const entries = object(accepted(page.result).chunk).entries as ObjectValue[];
          return (
            entries.some((row) => row.key === second.id) &&
            !entries.some((row) => row.key === first.id)
          );
        }, "original history ID absent, second retained");
        parity.finishedAt = wall();
        parity.sequence = sequence;
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
