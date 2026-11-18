/** W18a acceptance host: real shipped processes, router, persistence worker and generic UI.
 * Provider exchanges are synthetic. This entry never represents unchanged installed-product UI.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  PluginLauncher,
  PluginProcess,
  DrainOffer,
  DrainReport,
  ReservationEnded,
} from "@kobrixa/plugin-runtime";
import { labClickTargetScript } from "./sensor-lab-click-target.js";
import {
  composeDesktopMain,
  desktopUi,
  desktopFoundationTestHandles,
  retireDesktopWindow,
  desktopLifecycle,
} from "../../apps/desktop/src/main/plugins/controller.js";
import {
  createDesktopFoundation,
  type DesktopMainComposition,
  type DesktopMainCompositionInput,
} from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import { AuthorityContexts } from "../../apps/desktop/src/main/device-broker/authority-context.js";
import {
  createFakeDeviceProvider,
  type FakeProviderControl,
} from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import { createJournal } from "../../apps/desktop/src/main/device-broker/journal.js";
import { createJournalFilesystem } from "../../apps/desktop/src/main/device-broker/journal-filesystem.js";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";
import { assembleBuiltinPluginSources } from "../../apps/desktop/src/main/plugins/builtin.js";
import { startPrimary } from "../../apps/desktop/src/main/plugins/profile-writer-lock.js";
import { SessionMarkerFile } from "../../apps/desktop/src/main/plugins/session.js";
import { filePluginStateStore } from "../../apps/desktop/src/main/plugins/state-store.js";
import { createCoreActionLedger } from "../../apps/desktop/src/main/plugins/core-recovery.js";
import {
  registerUiIpc,
  registerUiEventIpc,
  trustedWorkbench,
} from "../../apps/desktop/src/main/plugins/ui-bridge.js";
import { persistenceWorkerCount } from "../../apps/desktop/src/main/plugins/persistence/worker.js";
import type { IpcHandle } from "../../apps/desktop/src/main/ipc.js";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Row;
};
const ok = (value: unknown): Row => {
  const result = object(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  return object(result.value);
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(
  check: () => T | Promise<T>,
  label: string,
  ms = 15_000,
): Promise<NonNullable<T>> {
  const end = performance.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    assert.ok(performance.now() < end, `Missing executed observation: ${label}`);
    await pause(20);
  }
}
const slugs = ["motor-test", "sensor-lab", "device-ev3"];

function run(): void {
  assert.equal(app.isReady(), false);
  const root = app.commandLine.getSwitchValue("lifecycle-root");
  const directory = app.commandLine.getSwitchValue("lifecycle-run");
  const feature = app.commandLine.getSwitchValue("lifecycle-feature");
  const event = app.commandLine.getSwitchValue("lifecycle-event");
  const id = app.commandLine.getSwitchValue("lifecycle-id");
  assert.ok(path.isAbsolute(root) && path.isAbsolute(directory) && slugs.includes(feature));
  const userData = path.join(directory, "profile");
  app.setPath("userData", userData);
  let sequence = 0;
  const stamp = () => ({ sequence: ++sequence, at: performance.timeOrigin + performance.now() });
  const wire: Array<{
    sequence: number;
    at: number;
    owner: ResourceOwner;
    direction: string;
    message: Row;
  }> = [];
  const launches: Array<{ owner: ResourceOwner; sequence: number; at: number; pid?: number }> = [];
  const exits: Array<{ owner: ResourceOwner; sequence: number; at: number; exit: unknown }> = [];
  const drains: Array<{
    offer: DrainOffer;
    sequence: number;
    at: number;
    report?: DrainReport;
    finishedSequence?: number;
    startedMonotonicMs: number;
    finishedMonotonicMs?: number;
  }> = [];
  const native: Row[] = [],
    ipc: Row[] = [],
    toggles: Row[] = [],
    providerTrace: Row[] = [];
  const ended: Array<{ event: ReservationEnded; sequence: number; at: number }> = [];
  const lost: Array<{
    owner: ResourceOwner;
    sequence: number;
    at: number;
    report?: DrainReport;
    finishedSequence?: number;
  }> = [];
  const importGates: Row[] = [];
  const failures: string[] = [],
    logs: string[] = [];
  const checkpoints: Record<string, unknown> = {};
  const processes = new Map<string, PluginProcess>();
  const originalReceivers = new Map<string, Array<(text: string) => void>>();
  const controls: FakeProviderControl[] = [];
  const traced = new Map<FakeProviderControl, number>();
  const pids = new Map<string, number>();
  const off: Array<() => void> = [],
    names: string[] = [];
  let live: DesktopMainComposition | undefined, window: BrowserWindow | undefined;
  let extraWindow: BrowserWindow | undefined;
  let stage = "startup",
    cleanup: Row | undefined;
  let retiring: Promise<void> = Promise.resolve();
  let traceTimer: ReturnType<typeof setInterval> | undefined;
  const syncTrace = () => {
    for (const control of controls) {
      const rows = control.trace();
      for (const row of rows.slice(traced.get(control) ?? 0))
        providerTrace.push({ ...row, ...stamp() });
      traced.set(control, rows.length);
    }
  };
  const launcher = (hooks: Parameters<typeof createDesktopLauncher>[0]): PluginLauncher => {
    const launch = createDesktopLauncher({
      ...hooks,
      onOutput(plugin, line) {
        hooks.onOutput?.(plugin, line);
        logs.push(`${plugin.id}: ${line}`);
        const match = /(?:LAB|LIFECYCLE)_PID:(\d+)/.exec(line);
        if (match) {
          pids.set(plugin.id, Number(match[1]));
          const row = [...launches].reverse().find((r) => r.owner.pluginId === plugin.id);
          if (row) row.pid = Number(match[1]);
        }
      },
    });
    return async (plugin) => {
      assert.ok(plugin.channelOwner);
      const owner = structuredClone(plugin.channelOwner);
      const row: (typeof launches)[number] = { owner, ...stamp() };
      launches.push(row);
      pids.delete(plugin.id);
      const child = await launch(plugin);
      processes.set(plugin.id, child);
      if (pids.has(plugin.id)) row.pid = pids.get(plugin.id)!;
      child.onExit((exit) => {
        exits.push({ owner, exit, ...stamp() });
      });
      const record = (direction: string, text: string) =>
        wire.push({ owner, direction, message: object(JSON.parse(text)), ...stamp() });
      return {
        ...child,
        send(text) {
          record("host-plugin", text);
          child.send(text);
        },
        onMessage(listener) {
          const key = JSON.stringify(owner);
          const receivers = originalReceivers.get(key) ?? [];
          receivers.push(listener);
          originalReceivers.set(key, receivers);
          return child.onMessage((text) => {
            record("plugin-host", text);
            listener(text);
          });
        },
      };
    };
  };
  const pairs = (method: string, after = 0) =>
    wire
      .filter(
        (r) => r.sequence > after && r.direction === "plugin-host" && r.message.method === method,
      )
      .flatMap((request) => {
        const response = wire.find(
          (r) =>
            r.direction === "host-plugin" &&
            r.sequence > request.sequence &&
            r.message.id === request.message.id &&
            !r.message.method &&
            JSON.stringify(r.owner) === JSON.stringify(request.owner),
        );
        return response && object(response.message.result).ok === true
          ? [{ request, response, value: ok(response.message.result) }]
          : [];
      });
  const primary = startPrimary(
    app,
    async (profile) => {
      try {
        // Controlled cold-start marker inputs, not claims of an observed OS crash/third-party run.
        if (event.endsWith("unclean")) {
          const marker = new SessionMarkerFile(userData);
          marker.begin();
          if (event === "renderer-unclean") marker.update({ rendererUnresponsive: true });
          if (event === "third-party-unclean") marker.markThirdPartyUiContributions();
          checkpoints.seedMarker = JSON.parse(await readFile(marker.file, "utf8"));
        }
        if (event === "all-off") {
          const store = filePluginStateStore(userData);
          await store.load();
          await store.update((state) => ({
            ...state,
            disabled: slugs.map((slug) => `builtin:kobrixa.${slug}`),
          }));
        }
        const builtins = await assembleBuiltinPluginSources({
          packaged: false,
          appPath: root,
          buildRoot: root,
        });
        const authority = new AuthorityContexts(profile.hostEpoch);
        window = new BrowserWindow({
          width: 1100,
          height: 900,
          show: false,
          webPreferences: {
            preload: path.join(root, "preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        const win = window,
          sender = win.webContents.id;
        const openAuthority = () => {
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
        };
        openAuthority();
        const scope = () => {
          const p = authority.core(sender, "recovery");
          return { hostEpoch: p.hostEpoch, workbenchInstance: p.workbenchInstance };
        };
        const currentScope: DesktopMainCompositionInput["currentScope"] = (candidate) =>
          !win.isDestroyed() &&
          candidate.hostEpoch === scope().hostEpoch &&
          candidate.workbenchInstance === scope().workbenchInstance;
        const actions = createCoreActionLedger({
          now: () => performance.now(),
          current: currentScope,
        });
        const journal = createJournal(createJournalFilesystem(await realpath(userData)), profile);
        await journal.load();
        live = await composeDesktopMain(
          {
            createFoundation: (options) =>
              createDesktopFoundation({
                ...options,
                providerFactory: (catalog) => {
                  const fake = createFakeDeviceProvider({
                    catalog,
                    now: options.now,
                    ...(feature === "motor-test" ? { profile: "maximum" as const } : {}),
                  });
                  controls.push(fake.control);
                  return fake.provider;
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
                  : builtins.some(
                      (source) =>
                        source.kind === "builtin" &&
                        object(source.manifest).id === p.owner.pluginId &&
                        (object(source.manifest).permissions as string[] | undefined)?.includes(
                          permission,
                        ),
                    ),
              requirements: (owner) => {
                const source = builtins.find(
                  (s) => s.kind === "builtin" && object(s.manifest).id === owner.pluginId,
                );
                const manifest =
                  source?.kind === "builtin"
                    ? (source.manifest as {
                        requires?: {
                          devices?: Array<{
                            capability: "telemetry.v1" | "finiteMotion.v1";
                            required: boolean;
                          }>;
                        };
                      })
                    : undefined;
                return manifest?.requires?.devices ?? [];
              },
              connectionPolicy: () => ({
                wifiConnectTimeoutMs: 10_000,
                wifiHandshakeTimeoutMs: 5000,
                usbAutoReconnect: false,
                usbRetryInterval: 2000,
                usbRetryLimit: 3,
              }),
              operationGate: () => ({ ok: true, value: null }),
            },
            plugins: {
              userData,
              builtins,
              locale: "en",
              commandLine: { developmentDirectories: [], safeMode: event === "cold-safe" },
              dialogs: {
                confirmDeveloperMode: async () => false,
                chooseFolder: async () => undefined,
                confirmLink: async () => false,
                confirmUnlink: async () => false,
                choosePython: async () => undefined,
              },
              launcher,
            },
            principal: (p) => authority.plugin(sender, p),
            scope,
            currentScope,
            legacyFlush: async () => {},
            legacyLabWriter: {
              sourceKey: "builtin:kobrixa.sensor-lab",
              freezeAdmission() {
                importGates.push({ source: "sensor-lab", phase: "freeze", ...stamp() });
              },
              async settled() {
                importGates.push({ source: "sensor-lab", phase: "settled", ...stamp() });
              },
            },
            ...(["cold-safe", "all-off", "renderer-unclean", "third-party-unclean"].includes(event)
              ? {
                  legacyDeviceWriter: {
                    sourceKey: "builtin:kobrixa.device-ev3",
                    freezeAdmission() {
                      importGates.push({ source: "device-ev3", phase: "freeze", ...stamp() });
                    },
                    async settled() {
                      importGates.push({ source: "device-ev3", phase: "settled", ...stamp() });
                    },
                  },
                }
              : {}),
            report: (error) => failures.push(String(error)),
          },
          { worker: { entry: path.join(root, "persistence-worker.cjs"), control() {} } },
        );
        const composition = live,
          ui = desktopUi(composition),
          handles = desktopFoundationTestHandles(composition);
        assert.equal(handles.recovery, "ready");
        assert.equal(handles.profile, handles.persistenceProfile);
        const participant = handles.host.participant,
          originalDrain = participant.drain;
        participant.drain = function (offer, dispatch) {
          const row: (typeof drains)[number] = {
            offer: structuredClone(offer),
            startedMonotonicMs: performance.now(),
            ...stamp(),
          };
          drains.push(row);
          return originalDrain.call(this, offer, dispatch).then((report) => {
            row.report = structuredClone(report);
            row.finishedSequence = ++sequence;
            row.finishedMonotonicMs = performance.now();
            return report;
          });
        };
        off.push(() => {
          participant.drain = originalDrain;
        });
        const originalLost = participant.ownerLost;
        participant.ownerLost = function (owner) {
          const row: (typeof lost)[number] = { owner: structuredClone(owner), ...stamp() };
          lost.push(row);
          return originalLost.call(this, owner).then((report) => {
            row.report = structuredClone(report);
            row.finishedSequence = ++sequence;
            return report;
          });
        };
        off.push(() => {
          participant.ownerLost = originalLost;
        });
        off.push(
          composition.foundation.broker.reservations.onEnded((event) =>
            ended.push({ event: structuredClone(event), ...stamp() }),
          ),
        );
        traceTimer = setInterval(syncTrace, 5);
        const currentOwner = (slug = feature) =>
          [...launches]
            .reverse()
            .find(
              (r) =>
                r.owner.pluginId === `kobrixa.${slug}` &&
                !exits.some((e) => JSON.stringify(e.owner) === JSON.stringify(r.owner)),
            )?.owner;
        const binding = (slug = feature) => {
          const owner = currentOwner(slug);
          return owner && ui.states.instances(owner).find((b) => b.kind === "panel");
        };
        const snapshot = async () => {
          syncTrace();
          return {
            ...stamp(),
            owner: currentOwner(),
            binding: binding(),
            bindings: currentOwner() ? ui.states.instances(currentOwner()!) : [],
            launches: structuredClone(launches),
            state: composition.plugins.state(),
            catalog: ok(await ui.bridge.catalog({})),
            providerSteps: providerTrace.map((r) => r.step),
            recovery: composition.foundation.broker.recovery.snapshot(),
            persistenceRecovery: participant.recoverySnapshot(),
            retirements: desktopLifecycle(composition).reports(),
            providersCreated: controls.length,
            importGates: structuredClone(importGates),
            reservations: pairs("devices/recording/reserve").map((row) => {
              const reservationId = String(object(row.value.reservation).reservationId);
              return {
                owner: row.request.owner,
                reservationId,
                current: composition.foundation.broker.reservations.validate(
                  row.request.owner,
                  reservationId,
                ),
              };
            }),
          };
        };
        await pause(300);
        checkpoints.idle = await snapshot();
        assert.equal(launches.length, 0, "No process may start before explicit UI open");
        assert.equal(providerTrace.length, 0);
        const startup = [
          "cold-safe",
          "all-off",
          "optional-unclean",
          "renderer-unclean",
          "third-party-unclean",
        ].includes(event);
        if (startup) {
          await pause(1000);
          checkpoints.finished = await snapshot();
        } else if (event === "independent-toggles") {
          for (const slug of slugs)
            for (const enabled of [false, true]) {
              const result = await composition.plugins.setEnabled(
                `builtin:kobrixa.${slug}`,
                enabled,
              );
              ok(result);
              toggles.push({
                feature: slug,
                enabled,
                result,
                state: composition.plugins.state(),
                ...stamp(),
              });
              const stored = filePluginStateStore(userData);
              await stored.load();
              assert.equal(
                stored.settings().disabled.includes(`builtin:kobrixa.${slug}`),
                !enabled,
                "Switch is durably persisted",
              );
              assert.equal(
                launches.length,
                0,
                "Switching sources does not launch executable payloads",
              );
            }
          checkpoints.finished = await snapshot();
        } else {
          const trusted = (e: { sender: { id: number }; senderFrame: unknown }) =>
            trustedWorkbench(e, win.webContents);
          const handle: IpcHandle = (name, action) => {
            names.push(name);
            ipcMain.handle(name, (...args: Parameters<typeof action>) => {
              assert.ok(trusted(args[0]));
              const row: Row = { channel: name, args: args.slice(1), ...stamp() };
              ipc.push(row);
              return Promise.resolve(action(...args)).then((result) => {
                row.result = result;
                row.finishedSequence = ++sequence;
                return result;
              });
            });
          };
          registerUiIpc({ handle, bridge: ui.bridge, trusted });
          off.push(
            registerUiEventIpc({
              handle,
              bridge: ui.bridge,
              trusted,
              send: (channel, value) => {
                if (!win.isDestroyed()) win.webContents.send(channel, value);
              },
            }),
          );
          const loss = (name: string) => () => {
            native.push({ event: name, ...stamp() });
            ui.intent.dispose();
          };
          win.on("blur", loss("blur"));
          win.on("hide", loss("hide"));
          win.on("minimize", loss("minimize"));
          win.webContents.on("console-message", (details) => {
            logs.push(details.message);
            if (details.message.startsWith("NATIVE_INPUT:"))
              native.push({ ...object(JSON.parse(details.message.slice(13))), ...stamp() });
          });
          win.webContents.on("render-process-gone", (_, details) => {
            native.push({ event: "render-process-gone", details, ...stamp() });
            const old = scope();
            retiring = retireDesktopWindow(composition, old, false);
          });
          win.webContents.on("destroyed", () => {
            if (stage !== "inject:window-destroyed") return;
            native.push({ event: "destroyed", ...stamp() });
            retiring = retireDesktopWindow(composition, scope(), true);
          });
          const connect = async () =>
            ok(
              await composition.foundation.broker.request(
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
          // Maximum provider requires a discovered candidate; normal provider accepts an address.
          if (feature === "motor-test") {
            const discovered = ok(
              await composition.foundation.broker.request(
                authority.core(sender, "recovery"),
                "devices/discover",
                { providerId: "kobrixa.device-ev3" },
                new AbortController().signal,
              ),
            );
            const first = object((discovered.candidates as unknown[])[0]);
            assert.equal(typeof first.candidateId, "string");
            ok(
              await composition.foundation.broker.request(
                authority.core(sender, "recovery"),
                "devices/connect",
                { target: { kind: "candidate", candidateId: first.candidateId as string } },
                new AbortController().signal,
              ),
            );
          } else await connect();
          const connected = ok(
            await composition.foundation.broker.request(
              authority.core(sender, "recovery"),
              "devices/list",
              {},
              new AbortController().signal,
            ),
          );
          const sessionId = String(object((connected.sessions as unknown[])[0]).sessionId);
          await win.loadFile(path.join(root, "renderer/index.html"));
          win.show();
          win.focus();
          win.webContents.focus();
          await until(() => win.isFocused(), "focused workbench");
          const js = <T>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>;
          const click = async (selector: string, text?: string) => {
            const point = await until(
              async () => {
                if (!(await js<boolean>(labClickTargetScript(selector, text, false)))) return;
                await pause(50);
                return js<{ x: number; y: number } | null>(
                  labClickTargetScript(selector, text, true),
                );
              },
              `${selector} ${text ?? ""}`,
            );
            for (const type of ["mouseDown", "mouseUp"] as const) {
              win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
              await pause(30);
            }
          };
          const open = async (slug: string) => {
            await click(
              '[role="tab"]',
              slug === "motor-test"
                ? "Motor test"
                : slug === "sensor-lab"
                  ? "Sensor Lab"
                  : "EV3 device",
            );
            if (!binding(slug)) {
              const opened = await until(
                async () =>
                  binding(slug) ||
                  (await js<boolean>(
                    '!![...document.querySelectorAll("[role=tabpanel] > button")].find(b=>b.textContent==="Open")',
                  )),
                "open control or opened tab",
              );
              if (opened === true) await click('[role="tabpanel"] > button', "Open");
            }
            await until(() => binding(slug), `${slug} actual initialized process/panel`);
          };
          const activeSlug = event === "device-kill-lab-recording" ? "sensor-lab" : feature;
          await open(activeSlug);
          if (activeSlug === "sensor-lab") {
            await click('[data-ui-node="select-current"] button');
            await click('[data-ui-node="available"] tbody button');
            await click('[data-ui-node="start"] button');
            await until(
              () =>
                pairs("storage/registerCheckpoint").length &&
                pairs("devices/recording/read").some((p) => (p.value.frames as unknown[]).length),
              "Lab committed checkpoint and live original samples",
            );
          } else if (activeSlug === "motor-test") {
            await click('[data-ui-node="select-current"] button');
            await click('[data-ui-node="a-mode"] select');
            for (const keyCode of ["ArrowDown", "Return"])
              for (const type of ["keyDown", "keyUp"] as const)
                win.webContents.sendInputEvent({ type, keyCode });
            await click('[data-ui-node="a-seconds"] input');
            win.webContents.selectAll();
            await win.webContents.insertText("5");
            await click('[data-ui-node="a-start"] button');
            await until(
              () =>
                pairs("devices/motion/start").length &&
                controls.some((c) => c.trace().some((t) => t.step === "motion-pulse")),
              "Live admitted timed motion",
            );
          } else {
            await click('[data-ui-node="refresh-action"] button');
            await until(
              () =>
                pairs("devices/subscribe").some(
                  (p) => p.request.owner.pluginId === "kobrixa.device-ev3",
                ),
              "Device actual observation",
            );
          }
          const active = await snapshot();
          checkpoints.active = active;
          const oldBinding = active.binding;
          assert.ok(oldBinding && active.owner);
          checkpoints.originalBinding = {
            ...stamp(),
            result: await ui.bridge.snapshot({ binding: oldBinding }),
          };
          if (event === "device-kill-lab-recording") await open("device-ev3");
          stage = `inject:${event}`;
          const injection = await snapshot();
          checkpoints.injected = injection;
          if (event === "hide") await click(".plugin-tools-pane > header button", "Close");
          else if (event === "window-hide") {
            win.hide();
            await until(() => !win.isVisible(), "Native window hidden");
          } else if (event === "close") await click('[data-close-contribution="true"]');
          else if (event === "blur") {
            extraWindow = new BrowserWindow({ width: 200, height: 200 });
            extraWindow.show();
            extraWindow.focus();
            await until(
              () =>
                native.some((r) => r.event === "blur" && Number(r.sequence) > injection.sequence),
              "Native blur",
            );
          } else if (event === "minimize") {
            win.minimize();
            await until(() => win.isMinimized(), "Native minimized window");
          } else if (event === "provider-loss") controls.at(-1)!.lose();
          else if (event === "provider-disable")
            ok(await composition.plugins.setEnabled("builtin:kobrixa.device-ev3", false));
          else if (event === "provider-replacement")
            ok(await composition.plugins.reload("builtin:kobrixa.device-ev3"));
          else if (event === "suspend-wake") await desktopLifecycle(composition).suspend(sessionId);
          else if (event === "feature-disable")
            ok(await composition.plugins.setEnabled(`builtin:kobrixa.${feature}`, false));
          else if (event === "renderer-freeze") {
            win.webContents.debugger.attach("1.3");
            win.webContents.debugger.on("message", (_, method) => {
              if (["Debugger.paused", "Debugger.resumed"].includes(method))
                native.push({ event: method, ...stamp() });
            });
            win.webContents.debugger.on("detach", () =>
              native.push({ event: "detach", ...stamp() }),
            );
            await win.webContents.debugger.sendCommand("Debugger.enable");
            await win.webContents.debugger.sendCommand("Debugger.pause");
            await until(
              () => native.some((r) => r.event === "Debugger.paused"),
              "Debugger acknowledged sustained pause",
            );
          } else if (event === "renderer-crash") {
            win.webContents.forcefullyCrashRenderer();
            await until(
              () => native.some((r) => r.event === "render-process-gone"),
              "Actual renderer crash",
            );
            await retiring;
          } else if (event === "window-destroyed") {
            win.destroy();
            await until(
              () => native.some((r) => r.event === "destroyed"),
              "Actual window destruction",
            );
            await retiring;
          } else if (event === "consumer-kill" || event === "device-kill-lab-recording") {
            const slug = event === "consumer-kill" ? feature : "device-ev3";
            const owner = currentOwner(slug);
            assert.ok(owner);
            processes.get(`kobrixa.${slug}`)!.forceKill();
            await until(
              () => exits.some((r) => JSON.stringify(r.owner) === JSON.stringify(owner)),
              "Actual consumer exit",
            );
          } else throw new Error(`Unknown event ${event}`);
          if (feature === "sensor-lab") {
            if (
              [
                "hide",
                "close",
                "blur",
                "minimize",
                "window-hide",
                "renderer-freeze",
                "device-kill-lab-recording",
              ].includes(event)
            ) {
              await until(
                () =>
                  pairs("devices/recording/read", injection.sequence).some(
                    (p) => (p.value.frames as unknown[]).length,
                  ),
                "Background recording after lifetime event",
              );
            } else if (event !== "consumer-kill")
              await until(
                () =>
                  drains.some(
                    (r) => r.sequence > injection.sequence && r.report?.state === "saved",
                  ),
                "Final bounded drain",
                25_000,
              );
          }
          if (feature === "motor-test")
            await until(() => {
              syncTrace();
              return providerTrace.some(
                (r) => r.step === "stop" && Number(r.sequence) > injection.sequence,
              );
            }, "Main stop after injected event");
          await pause(1000);
          checkpoints.settled = await snapshot();
          if (event === "renderer-freeze") {
            await win.webContents.debugger.sendCommand("Debugger.resume");
            await until(
              () => native.some((r) => r.event === "Debugger.resumed"),
              "Deliberate resume",
            );
            win.webContents.debugger.detach();
          }
          if (event === "close") {
            await click('[role="tabpanel"] > button', "Open");
            await until(
              () => binding()?.panelInstance !== oldBinding.panelInstance && binding(),
              "Explicit panel reopen",
            );
            checkpoints.reopened = await snapshot();
          }
          if (["renderer-crash", "consumer-kill"].includes(event)) {
            // Reload uses a blank document first: generic UI mounting must not stand in for explicit open.
            if (event === "renderer-crash") {
              openAuthority();
              await win.loadURL("about:blank");
            }
            await pause(1000);
            checkpoints.beforeReopen = await snapshot();
            checkpoints.stale = {
              ...stamp(),
              result: await ui.bridge.snapshot({ binding: oldBinding }),
            };
            // Deliver an original accepted patch through the retired channel callback.
            // This is a deliberate late-delivery injection, kept separate from live RPC.
            const patch = pairs("ui/patch")
              .filter(
                (row) =>
                  JSON.stringify(row.request.owner) === JSON.stringify(active.owner) &&
                  row.response.sequence < injection.sequence,
              )
              .at(-1);
            assert.ok(patch, "Original accepted patch before retirement");
            const late: Row = {
              owner: active.owner,
              originalSequence: patch.request.sequence,
              message: patch.request.message,
              ...stamp(),
            };
            for (const receive of originalReceivers.get(JSON.stringify(active.owner)) ?? [])
              receive(JSON.stringify(patch.request.message));
            await pause(100);
            late.result = await ui.bridge.snapshot({ binding: oldBinding });
            late.instances = ui.states.instances(active.owner);
            checkpoints.lateCallback = late;
            const catalog = await ui.bridge.catalog({});
            assert.ok(catalog.ok);
            const descriptor = catalog.value.entries.find(
              (r) => r.id === `kobrixa.${feature}.panel`,
            );
            assert.ok(descriptor);
            const opening: Row = { ...stamp(), input: descriptor };
            checkpoints.explicitOpen = opening;
            const opened = await ui.bridge.open(descriptor);
            assert.ok(opened.ok);
            opening.result = opened;
            opening.finishedSequence = ++sequence;
            checkpoints.reopened = await snapshot();
            assert.ok(binding());
            // Observe no replay after the new process has initialized, not only before reopening.
            const count =
              pairs("devices/motion/start").length + pairs("devices/recording/reserve").length;
            await pause(1000);
            assert.equal(
              pairs("devices/motion/start").length + pairs("devices/recording/reserve").length,
              count,
            );
          }
          if (
            [
              "provider-disable",
              "provider-replacement",
              "provider-loss",
              "feature-disable",
              "suspend-wake",
            ].includes(event)
          ) {
            const count =
              pairs("devices/motion/start").length + pairs("devices/recording/reserve").length;
            checkpoints.beforeRestore = await snapshot();
            if (event === "provider-disable")
              ok(await composition.plugins.setEnabled("builtin:kobrixa.device-ev3", true));
            if (event === "feature-disable")
              ok(await composition.plugins.setEnabled(`builtin:kobrixa.${feature}`, true));
            if (event === "suspend-wake") await desktopLifecycle(composition).resume(sessionId);
            // Registration/reenablement alone must not connect or replay. Reconnection is a later explicit action.
            await pause(1000);
            checkpoints.restored = await snapshot();
            assert.equal(
              pairs("devices/motion/start").length + pairs("devices/recording/reserve").length,
              count,
            );
          }
          checkpoints.finished = await snapshot();
        }
        stage = "cleanup";
        // A killed recorder deliberately leaves recovery blocked. Only after recording
        // that outcome, explicitly discard its abandoned staging through the real core
        // action ledger so fixture teardown does not pretend an interrupted run saved.
        const cleanupRecovery: Row[] = [];
        for (const item of participant.recoverySnapshot().items) {
          if (!item.actions.some((action) => action.kind === "discard")) continue;
          const action = actions.mint(scope(), { kind: "persistence-discard", recovery: item.id });
          const report = await participant.discard(item.id, action);
          cleanupRecovery.push({ before: item, action, report, ...stamp() });
          desktopLifecycle(composition).reconcileRecovery(item.id, report);
        }
        checkpoints.cleanupRecovery = cleanupRecovery;
        await composition.dispose();
        composition.plugins.finishSession();
        await until(
          () => exits.length === launches.length,
          "All original consumer exits after cleanup",
          5000,
        );
        cleanup = { workers: persistenceWorkerCount(handles.backend) };
        assert.equal(cleanup.workers, 0);
        assert.deepEqual(failures, []);
        stage = "complete";
      } catch (error) {
        failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
        if (live) await live.dispose().catch((error) => failures.push(`cleanup: ${String(error)}`));
      } finally {
        clearInterval(traceTimer);
        syncTrace();
        for (const dispose of off.reverse()) dispose();
        for (const name of names) ipcMain.removeHandler(name);
        await writeFile(
          path.join(directory, "producer.json"),
          JSON.stringify(
            {
              schema: 1,
              id,
              stage,
              scope: "acceptance-host",
              syntheticProvider: true,
              versions: process.versions,
              mainPid: process.pid,
              wire,
              launches,
              exits,
              drains,
              native,
              ipc,
              toggles,
              providerTrace,
              ended,
              lost,
              importGates,
              checkpoints,
              cleanup,
              failures,
              logs,
            },
            null,
            2,
          ),
        );
        extraWindow?.destroy();
        if (window && !window.isDestroyed()) window.destroy();
        app.exit(stage === "complete" ? 0 : 1);
      }
    },
    () => {
      window?.focus();
      return !!window;
    },
  );
  assert.ok(primary);
  void primary.ready.catch(async (error) => {
    await writeFile(
      path.join(directory, "producer.json"),
      JSON.stringify({ schema: 1, id, stage, failures: [String(error)] }),
    );
    app.exit(1);
  });
}
run();
