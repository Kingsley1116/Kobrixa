import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  readSource,
  PluginManager,
  type FoundationDiagnostics,
  type FoundationDiagnosticEvent,
  type PluginLauncher,
} from "@kobrixa/plugin-runtime";
import { unwrap, type ResourceOwner, type MotionSnapshot } from "@kobrixa/plugin-protocol";
import {
  composeDesktopMain,
  desktopUi,
  createWindowRetirementHandler,
} from "../../apps/desktop/src/main/plugins/controller.js";
import {
  createDesktopFoundation,
  CleanupBlocked,
  type DesktopMainComposition,
  type DesktopMainCompositionInput,
} from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import {
  createFakeDeviceProvider,
  type FakeProviderControl,
} from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import type { ProviderStep } from "../../apps/desktop/src/main/device-broker/provider.js";
import { AuthorityContexts } from "../../apps/desktop/src/main/device-broker/authority-context.js";
import { createJournal } from "../../apps/desktop/src/main/device-broker/journal.js";
import { createJournalFilesystem } from "../../apps/desktop/src/main/device-broker/journal-filesystem.js";
import { startPrimary } from "../../apps/desktop/src/main/plugins/profile-writer-lock.js";
import {
  createCoreActionLedger,
  createRecoveryEntries,
  CoreRecovery,
} from "../../apps/desktop/src/main/plugins/core-recovery.js";
import { registerCoreRecoveryIpc } from "../../apps/desktop/src/main/plugins/ipc.js";
import {
  registerUiIpc,
  registerUiEventIpc,
  trustedWorkbench,
  diagnosticsFor,
} from "../../apps/desktop/src/main/plugins/ui-bridge.js";
import { BUILTIN_PLUGIN_SOURCES } from "../../apps/desktop/src/main/plugins/builtin.js";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";
import type { IpcHandle } from "../../apps/desktop/src/main/ipc.js";
import { diagnosticsFor as runtimeDiagnostics } from "../../packages/plugin-runtime/src/ui-lifecycle.js";
import { runUiLoad } from "./declarative-ui-load-main.js";

type Scenario = {
  load?: { durationMs: number; cycles: number };
  boundary: "prepare" | "start" | "arm" | "pulse";
  position: "before" | "after";
  fault:
    | "hide"
    | "authority-loss"
    | "cancel"
    | "renderer-freeze"
    | "renderer-crash"
    | "plugin-kill"
    | "queue-pressure";
  stress?: "delayed-readback" | "withheld-readback" | "lost-start";
};
const inputPath = app.commandLine.getSwitchValue("motion-input");
const output = app.commandLine.getSwitchValue("motion-output");
const root = path.dirname(inputPath);
app.setPath("userData", path.join(root, "profile"));
const wall = () => performance.timeOrigin + performance.now();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(
  check: () => T | Promise<T>,
  label: string,
  timeout = 10_000,
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    assert.ok(performance.now() < deadline, `Missing observation: ${label}`);
    await pause(10);
  }
}
async function bounded<T>(work: Promise<T>, label: string, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing observation: ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Wire = {
  at: number;
  direction: "plugin-host" | "host-plugin";
  message: Record<string, unknown>;
};
const wire: Wire[] = [],
  logs: string[] = [],
  events: FoundationDiagnosticEvent[] = [];
const native: Array<{ at: number; type: string; detail?: unknown }> = [];
const failures: string[] = [];
const loadPids = new Set<number>();
const expectedCleanupReports: string[] = [];
let allowBlockedCleanup = false;
let holdAcks = false;
const ackDeliveries: Array<{ at: number; message: Record<string, unknown>; disposition: string }> =
  [];
const releaseAcks: Array<() => void> = [];
const ipc: Array<{
  at: number;
  channel: string;
  args: unknown[];
  result?: unknown;
  error?: string;
}> = [];
const deliveries: Array<{
  at: number;
  id: unknown;
  disposition: "held" | "released" | "process-exited";
}> = [];
let win: BrowserWindow | undefined;
let main: DesktopMainComposition | undefined;
let control: FakeProviderControl | undefined;
let owner: ResourceOwner | undefined;
let pid: number | undefined;
let releaseReply: (() => void) | undefined;
let replyReached = false;
let blocked: { point: "before-exchange" | "after-exchange"; step: ProviderStep } | undefined;
let operationId: string | undefined;
let scenario: Scenario;

function observingLauncher(hooks: Parameters<typeof createDesktopLauncher>[0]): PluginLauncher {
  const launch = createDesktopLauncher({
    ...hooks,
    onOutput(plugin, line) {
      hooks.onOutput?.(plugin, line);
      logs.push(line);
      const match = /MOTION_PID:(\d+)/.exec(line);
      if (match) pid = Number(match[1]);
      const loadPid = /UI_PID:(\d+)/.exec(line);
      if (loadPid) loadPids.add(Number(loadPid[1]));
    },
  });
  return async (plugin) => {
    owner = plugin.channelOwner;
    const child = await launch(plugin);
    if (scenario.load) return child;
    let exited = false;
    let offExit = () => {};
    offExit = child.onExit(() => {
      exited = true;
      offExit();
    });
    const requests = new Map<unknown, string>();
    return {
      ...child,
      onMessage(listener) {
        return child.onMessage((text) => {
          const message = JSON.parse(text) as Record<string, unknown>;
          wire.push({ at: wall(), direction: "plugin-host", message });
          if (message.id !== undefined && typeof message.method === "string")
            requests.set(message.id, message.method);
          if (holdAcks && message.method === "events/ack") {
            ackDeliveries.push({ at: wall(), message, disposition: "held" });
            releaseAcks.push(() => {
              ackDeliveries.push({
                at: wall(),
                message,
                disposition: exited ? "process-exited" : "released",
              });
              if (!exited) listener(text);
            });
            return;
          }
          listener(text);
        });
      },
      send(text) {
        const message = JSON.parse(text) as Record<string, unknown>;
        wire.push({ at: wall(), direction: "host-plugin", message });
        const method = requests.get(message.id);
        const result = message.result as
          { ok?: boolean; value?: { operation?: { operationId: string } } } | undefined;
        if (method === "devices/motion/prepare" && result?.ok)
          operationId = result.value?.operation?.operationId;
        if (
          method ===
            `devices/motion/${scenario.stress === "lost-start" ? "start" : scenario.boundary}` &&
          !replyReached &&
          (["prepare", "start"].includes(scenario.boundary) || scenario.stress === "lost-start")
        ) {
          assert.equal(result?.ok, true, `Unsuccessful ${method}: ${text}`);
          replyReached = true;
          if (scenario.position === "before" || scenario.stress === "lost-start") {
            deliveries.push({ at: wall(), id: message.id, disposition: "held" });
            releaseReply = () => {
              releaseReply = undefined;
              deliveries.push({
                at: wall(),
                id: message.id,
                disposition: exited ? "process-exited" : "released",
              });
              if (!exited) child.send(text);
            };
            return;
          }
        }
        child.send(text);
      },
    };
  };
}

async function run() {
  scenario = JSON.parse(await readFile(inputPath, "utf8")) as Scenario;
  const primary = startPrimary(
    app,
    async (profile) => {
      const folders = scenario.load
        ? await Promise.all(
            Array.from({ length: 8 }, (_, n) => realpath(path.join(root, `ui-${n}`))),
          )
        : [await realpath(path.join(root, "source"))];
      const directory = folders[0]!;
      const sources = await Promise.all(
        folders.map((directory) =>
          readSource({ kind: "development", directory }, { safeMode: false }),
        ),
      );
      const sourceFor = (sourceKey: string) =>
        sources.find((source) => source.sourceKey === sourceKey);
      let nextFolder = 0;
      let loadRuntime: FoundationDiagnostics | undefined;
      const authority = new AuthorityContexts(profile.hostEpoch);
      const now = () => performance.now();
      win = new BrowserWindow({
        width: 1000,
        height: 760,
        show: true,
        webPreferences: {
          preload: path.join(root, "preload.cjs"),
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      const window = win;
      const senderId = window.webContents.id;
      const document = authority.open(senderId);
      authority.report(senderId, {
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
        const principal = authority.core(senderId, "recovery");
        return { hostEpoch: principal.hostEpoch, workbenchInstance: principal.workbenchInstance };
      };
      const currentScope: DesktopMainCompositionInput["currentScope"] = (candidate) => {
        if (window.isDestroyed()) return false;
        try {
          const current = scope();
          return (
            candidate.hostEpoch === current.hostEpoch &&
            candidate.workbenchInstance === current.workbenchInstance
          );
        } catch {
          return false;
        }
      };
      const actions = createCoreActionLedger({ now, current: currentScope });
      const journal = createJournal(
        createJournalFilesystem(await realpath(app.getPath("userData"))),
        profile,
      );
      await journal.load();
      main = await composeDesktopMain({
        async createFoundation(options) {
          assert.equal(options.providerFactory, undefined);
          const foundation = await createDesktopFoundation({
            ...options,
            providerFactory(catalog) {
              assert.equal(control, undefined);
              const fake = createFakeDeviceProvider({
                catalog,
                now: options.now,
                motionProfile: "staged",
              });
              control = fake.control;
              return fake.provider;
            },
          });
          if (scenario.load) {
            const attach = foundation.attachProvider.bind(foundation);
            foundation.attachProvider = (manager) => {
              attach(manager);
              assert.ok(manager instanceof PluginManager);
              loadRuntime = runtimeDiagnostics(manager.stage3Runtime());
            };
          }
          return foundation;
        },
        foundationOptions: {
          profile,
          now,
          authority,
          journal,
          coreActions: actions,
          hasPermission: (principal, permission) =>
            principal.kind === "core"
              ? currentScope(principal) &&
                ["devices.read", "devices.connect", "devices.control"].includes(permission)
              : !!sourceFor(principal.owner.sourceKey)?.manifest?.permissions?.includes(permission),
          requirements: (resourceOwner) =>
            sourceFor(resourceOwner.sourceKey)
              ? (sourceFor(resourceOwner.sourceKey)?.manifest?.requires?.devices ?? [])
              : null,
          connectionPolicy: () => ({
            wifiConnectTimeoutMs: 10000,
            wifiHandshakeTimeoutMs: 5000,
            usbAutoReconnect: false,
            usbRetryInterval: 2000,
            usbRetryLimit: 3,
          }),
          operationGate: () => ({ ok: true, value: null }),
        },
        plugins: {
          userData: app.getPath("userData"),
          builtins: BUILTIN_PLUGIN_SOURCES,
          locale: "en",
          commandLine: {
            developmentDirectories: scenario.load ? [] : [directory],
            safeMode: false,
          },
          dialogs: {
            confirmDeveloperMode: async () => true,
            chooseFolder: async () =>
              scenario.load ? folders[nextFolder++ % folders.length] : undefined,
            confirmLink: async () => true,
            confirmUnlink: async () => true,
            choosePython: async () => undefined,
          },
          launcher: observingLauncher,
        },
        principal: (resourceOwner) => authority.plugin(senderId, resourceOwner),
        scope,
        currentScope,
        legacyFlush: async () => {},
        report: (error) => {
          if (allowBlockedCleanup && error instanceof CleanupBlocked)
            expectedCleanupReports.push(String(error));
          else failures.push(String(error));
        },
      });
      const composition = main;
      const ui = desktopUi(composition);
      const diagnostics = diagnosticsFor(ui.bridge);
      const offDiagnostics = diagnostics.onEvent((event) => {
        if (!scenario.load) events.push(event);
      });
      const trusted = (event: { sender: { id: number }; senderFrame: unknown }) =>
        !window.isDestroyed() && trustedWorkbench(event, window.webContents);
      const handle: IpcHandle = (name, action) =>
        ipcMain.handle(name, (...args: Parameters<typeof action>) => {
          assert.ok(trusted(args[0]), "Untrusted native sender");
          const row = { at: wall(), channel: name, args: args.slice(1) };
          const result = action(...args);
          void Promise.resolve(result).then(
            (value) => {
              if (!scenario.load) ipc.push({ ...row, result: value });
            },
            (error) => {
              if (!scenario.load) ipc.push({ ...row, error: String(error) });
            },
          );
          return result;
        });
      registerUiIpc({ handle, bridge: ui.bridge, trusted });
      let rendererAlive = true;
      const send = (channel: string, value: unknown) => {
        if (rendererAlive && !window.isDestroyed()) window.webContents.send(channel, value);
      };
      const offEvents = registerUiEventIpc({ handle, bridge: ui.bridge, trusted, send });
      const recovery = new CoreRecovery({
        scope,
        now,
        actions,
        entries: createRecoveryEntries({
          device: composition.foundation.broker.recovery,
          sessions: async () =>
            unwrap(
              await composition.foundation.broker.request(
                authority.core(senderId, "recovery"),
                "devices/list",
                {},
                new AbortController().signal,
              ),
            ).sessions,
          processes: () => composition.plugins.state().plugins,
          confirmDevice: async () => false,
        }),
        openDetail() {
          throw new Error("No persistence in the P160 motion shell.");
        },
      });
      const offRecovery = registerCoreRecoveryIpc(handle, recovery, () =>
        send("plugins:recovery:changed", null),
      );
      const offDevice = composition.foundation.broker.recovery.subscribe(() => recovery.changed());
      const retire = createWindowRetirementHandler({
        composition,
        scope,
        coreActions: actions,
        invalidate: () => authority.invalidate(senderId),
        flush: async () => {},
        pause: async () => {},
      });
      let retirement: Promise<void> | undefined;
      window.on("blur", () => {
        native.push({ at: wall(), type: "blur" });
        ui.intent.dispose();
      });
      window.on("hide", () => {
        native.push({ at: wall(), type: "hide" });
        ui.intent.dispose();
      });
      window.webContents.on("render-process-gone", (_event, detail) => {
        rendererAlive = false;
        offEvents();
        native.push({ at: wall(), type: "render-process-gone", detail });
        retirement = retire(false)
          .catch((error) => failures.push(String(error)))
          .then(() => {});
      });
      window.webContents.on("console-message", (detail) => logs.push(`renderer:${detail.message}`));
      let closed = false;
      window.on("close", (event) => {
        if (closed) return;
        event.preventDefault();
        void composition.dispose().then(
          () => {
            closed = true;
            window.close();
          },
          (error) => failures.push(String(error)),
        );
      });
      if (scenario.load) {
        assert.ok(loadRuntime);
        const report = await runUiLoad({
          window,
          composition,
          runtime: loadRuntime,
          directory: root,
          folders,
          ...scenario.load,
        });
        assert.deepEqual(failures, []);
        offEvents();
        offRecovery();
        offDevice();
        offDiagnostics();
        await writeFile(
          output,
          JSON.stringify({ ...report, childPids: [...loadPids], failures }, null, 2),
        );
        closed = true;
        window.close();
        app.quit();
        return;
      }
      await window.loadFile(path.join(root, "renderer/index.html"));
      window.show();
      window.focus();
      const openBounds = await until(
        async () =>
          window.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Open');
        if (!button || button.disabled || !document.hasFocus()) return null;
        const r = button.getBoundingClientRect();
        return r.width && r.height ? {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)} : null;
      })()`),
        "native Open control",
      );
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...openBounds,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...openBounds,
      });
      await until(
        () => logs.some((line) => line.includes("MOTION_READY:")),
        "SDK discovery/connect readiness",
      );
      await until(
        () =>
          owner &&
          ui.states
            .instances(owner)
            .some((binding) => binding.kind === "panel" && ui.intent.scope(binding)),
        "first real panel heartbeat",
      );
      await window.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const bounds = await until(
        async () =>
          window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Hold');
      if (!button || button.disabled || !document.hasFocus()) return null;
      const r = button.getBoundingClientRect();
      return r.width && r.height ? { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } : null;
    })()`),
        "native holdAction",
      );
      assert.ok(owner && control);
      const principal = authority.plugin(senderId, owner);
      const traceBefore = control.trace().length;
      const eventBefore = events.length;
      const point = scenario.position === "before" ? "before-exchange" : "after-exchange";
      const step =
        scenario.boundary === "arm"
          ? "helper-arm"
          : scenario.boundary === "pulse"
            ? "motion-pulse"
            : "preflight";
      blocked = {
        point: ["prepare", "start"].includes(scenario.boundary) ? "before-exchange" : point,
        step,
      };
      control.block(blocked.point, step);
      if (scenario.stress) {
        holdAcks = true;
        control.block("before-exchange", "readback");
      }
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...bounds,
      });
      if (["prepare", "start"].includes(scenario.boundary))
        await until(() => replyReached, `${scenario.boundary} actual reply`);
      else await bounded(control.reached(blocked.point, step), `${blocked.point}/${step}`);
      assert.ok(operationId, "Original prepared operation ID absent");
      if (scenario.boundary === "prepare") assert.equal(control.trace().length, traceBefore);
      const faultAt = wall();
      const queueSamples: Array<{
        at: number;
        subscriptions: number;
        queuedEvents: number;
        queuedBytes: number;
      }> = [];
      switch (scenario.fault) {
        case "queue-pressure":
          assert.ok(logs.some((line) => line.includes("MOTION_SUBSCRIPTION:")));
          queueSamples.push({ at: wall(), ...composition.foundation.broker.events.diagnostics() });
          for (let i = 0; i < 8; i++) {
            ui.states.setEnvironment(i % 2 ? "en" : "zh-TW", "dark");
            queueSamples.push({
              at: wall(),
              ...composition.foundation.broker.events.diagnostics(),
            });
          }
          assert.ok(
            queueSamples.some((sample) => sample.queuedEvents >= 7),
            "Real common queue did not fill",
          );
          break;
        case "hide":
          window.hide();
          break;
        case "cancel":
          window.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...bounds,
          });
          break;
        case "authority-loss":
          authority.report(senderId, {
            document,
            sequence: 2,
            state: "room",
            roomId: "acceptance-room",
            connected: true,
            synced: true,
            role: "viewer",
            isHolder: false,
          });
          break;
        case "renderer-freeze":
          window.webContents.debugger.attach("1.3");
          await window.webContents.debugger.sendCommand("Debugger.enable");
          await window.webContents.debugger.sendCommand("Debugger.pause");
          await pause(500);
          break;
        case "renderer-crash":
          window.webContents.forcefullyCrashRenderer();
          break;
        case "plugin-kill":
          assert.ok(pid);
          process.kill(pid, "SIGKILL");
          break;
      }
      // Releasing a hold ends its gesture; it intentionally does not revoke the visible pane.
      await until(
        () =>
          events
            .slice(eventBefore)
            .some(
              (event) => event.kind === (scenario.fault === "cancel" ? "stop-dispatch" : "revoke"),
            ),
        "native cancellation/revocation",
      );
      const traceAtRevoke = control.trace().length;
      if (scenario.stress !== "lost-start") releaseReply?.();
      control.release(blocked.point, blocked.step);
      blocked = undefined;
      if (scenario.stress) {
        await bounded(control.reached("before-exchange", "readback"), "actual held readback");
        await until(() => releaseAcks.length > 0, "actual SDK ACK under pressure");
        assert.ok(
          wire.some(
            (row) =>
              row.direction === "host-plugin" &&
              JSON.stringify(row.message).includes("events.resyncRequired"),
          ),
          "Missing actual overflow notification",
        );
        if (scenario.stress !== "withheld-readback") {
          await pause(150);
          control.release("before-exchange", "readback");
        }
        if (scenario.stress === "lost-start") {
          await until(
            () => logs.some((line) => line.includes("MOTION_START_ERROR:")),
            "public SDK start timeout",
            8000,
          );
          releaseReply?.();
        }
        holdAcks = false;
        for (const release of releaseAcks.splice(0)) release();
      }
      if (scenario.fault === "renderer-freeze") {
        await window.webContents.debugger.sendCommand("Debugger.resume");
        window.webContents.debugger.detach();
      }
      // Host observer queries the original ID with its original principal. It never prepares,
      // starts, binds intent, or substitutes a core principal for a plugin operation.
      let terminal: MotionSnapshot | undefined;
      let queryFailure: unknown;
      await until(
        async () => {
          const result = await composition.foundation.broker.request(
            principal,
            "devices/motion/query",
            { operationId: operationId! },
            new AbortController().signal,
          );
          if (!result.ok) {
            queryFailure = result;
            return false;
          }
          terminal = result.value.operation;
          const durable = composition.foundation.broker.recovery.snapshot();
          return (
            ["completed", "stopped", "timeout", "failed", "unconfirmed"].includes(terminal.phase) &&
            !durable.faults.some(
              (fault) => fault.operationId === operationId && fault.state === "pending",
            )
          );
        },
        `original operation terminal (${JSON.stringify(queryFailure)})`,
        20_000,
      );
      assert.ok(terminal);
      const trace = control.trace().slice(traceBefore);
      const late = control.trace().slice(traceAtRevoke);
      const effects = new Set<ProviderStep>([
        "helper-upload",
        "helper-run",
        "helper-arm",
        "motion-pulse",
      ]);
      assert.deepEqual(
        late.filter((row) => effects.has(row.step) && row.dispatch !== "not-sent"),
        [],
      );
      if (trace.some((row) => effects.has(row.step) && row.dispatch !== "not-sent")) {
        assert.ok(trace.some((row) => row.step === "stop" && row.dispatch === "sent"));
        if (scenario.stress !== "withheld-readback") {
          assert.ok(trace.some((row) => row.step === "readback" && row.dispatch === "sent"));
          assert.equal(terminal.stopConfirmation, "confirmed");
        }
      }
      let afterRetirement: unknown;
      if (scenario.stress === "withheld-readback") {
        assert.equal(terminal.phase, "unconfirmed");
        assert.equal(terminal.stopConfirmation, "unconfirmed");
        const originalFault = composition.foundation.broker.recovery
          .snapshot()
          .faults.find((fault) => fault.operationId === operationId);
        assert.ok(originalFault && originalFault.state === "unconfirmed");
        allowBlockedCleanup = true;
        assert.ok(pid);
        process.kill(pid, "SIGKILL");
        await until(
          () =>
            composition.plugins
              .state()
              .plugins.some((plugin) => plugin.id === owner!.pluginId && !plugin.running),
          "consumer retirement",
        );
        control.release("before-exchange", "readback");
        await pause(100);
        afterRetirement = composition.foundation.broker.recovery.snapshot();
        assert.deepEqual(
          composition.foundation.broker.recovery
            .snapshot()
            .faults.find((fault) => fault.operationId === operationId),
          originalFault,
        );
      }
      const prepared = wire.filter(
        (row) => row.direction === "plugin-host" && row.message.method === "devices/motion/prepare",
      );
      const started = wire.filter(
        (row) => row.direction === "plugin-host" && row.message.method === "devices/motion/start",
      );
      assert.equal(prepared.length, 1);
      assert.ok(started.length <= 1);
      for (const row of started)
        assert.equal((row.message.params as { operationId: string }).operationId, operationId);
      const recoverySnapshot = composition.foundation.broker.recovery.snapshot();
      const rendererRecovery =
        scenario.fault === "renderer-crash"
          ? null
          : await window.webContents.executeJavaScript(
              "window.kobrixa.plugins.recovery.snapshot({})",
            );
      await retirement;
      let expectedBlockedClose: { name: string; message: string; device: unknown } | undefined;
      if (scenario.stress === "withheld-readback") {
        try {
          await bounded(composition.dispose(), "blocked real composition cleanup", 25_000);
        } catch (error) {
          assert.ok(error instanceof CleanupBlocked);
          expectedBlockedClose = { name: error.name, message: error.message, device: error.device };
        }
        assert.ok(expectedBlockedClose, "Unconfirmed stop must block ordinary close");
      } else await bounded(composition.dispose(), "real composition cleanup", 25_000);
      const final = diagnostics.snapshot();
      if (!expectedBlockedClose)
        assert.ok(
          Object.values(final).every((value) => value === 0),
          JSON.stringify(final),
        );
      offEvents();
      offRecovery();
      offDevice();
      offDiagnostics();
      await writeFile(
        output,
        JSON.stringify(
          {
            kind: "ui-motion-race",
            composition: "composeDesktopMain/createDesktopFoundation",
            mockIntent: false,
            testShell: "production pane and window singleton",
            scenario,
            faultAt,
            operationId,
            terminal,
            trace,
            traceAtRevoke: traceAtRevoke - traceBefore,
            events,
            wire,
            deliveries,
            ackDeliveries,
            queueSamples,
            afterRetirement,
            expectedBlockedClose,
            expectedCleanupReports,
            ipc,
            logs,
            native,
            recoverySnapshot,
            rendererRecovery,
            final,
            failures,
            pid,
            versions: process.versions,
          },
          null,
          2,
        ),
      );
      assert.deepEqual(failures, []);
      if (expectedBlockedClose) {
        // Test-only process teardown after retaining the actual refused-close receipt.
        // No product cleanup success or normal-close acceptance is claimed.
        app.exit(0);
        return;
      }
      closed = true;
      window.close();
      app.quit();
    },
    () => {
      if (!win || win.isDestroyed()) return false;
      win.focus();
      return true;
    },
  );
  assert.ok(primary, "Actual profile lock unavailable");
  await primary.ready;
}
const deadline = setTimeout(
  () => {
    console.error("Motion runner deadline");
    app.exit(2);
  },
  app.commandLine.hasSwitch("ui-load") ? 600_000 : 65_000,
);
void run()
  .then(() => clearTimeout(deadline))
  .catch(async (error: unknown) => {
    clearTimeout(deadline);
    console.error(error);
    if (control && blocked) {
      control.release(blocked.point, blocked.step);
      blocked = undefined;
    }
    releaseReply?.();
    await writeFile(
      `${output}.failure.json`,
      JSON.stringify(
        {
          error: String(error),
          stack: error instanceof Error ? error.stack : null,
          scenario,
          wire,
          deliveries,
          ipc,
          logs,
          events,
          native,
          trace: control?.trace(),
          pid,
          failures,
          plugins: main?.plugins.state(),
          renderer:
            win && !win.isDestroyed()
              ? await win.webContents.executeJavaScript("document.body.innerText").catch(String)
              : null,
        },
        null,
        2,
      ),
    );
    try {
      await bounded(main?.dispose() ?? Promise.resolve(), "failed-run cleanup", 25_000);
    } catch (cleanup) {
      console.error(cleanup);
    }
    app.exit(1);
  });
