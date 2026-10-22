// Test-only Node composition: real entry + SDK transport, broker/router and generic UI state.
// This is deliberately distinct from composeDesktopMain/native/product acceptance.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  RpcPeer,
  pluginManifestSchema,
  contextCommandDeclarationSchema,
  validateUiResource,
  unwrap,
  type CommandInvocation,
  type PluginManifest,
  type PanelResourceV1,
  type StatusResourceV1,
} from "@kobrixa/plugin-protocol";
import { UiStateRegistry, UiSubscriptions } from "@kobrixa/plugin-runtime";
import {
  createDeviceBroker,
  uiEventLedgerPort,
} from "../../apps/desktop/src/main/device-broker/broker-port.js";
import { createCoreActionLedger } from "../../apps/desktop/src/main/plugins/core-recovery.js";
import { AuthorityContexts } from "../../apps/desktop/src/main/device-broker/authority-context.js";
import { attachDeviceRpc } from "../../apps/desktop/src/main/device-broker/rpc-router.js";
import {
  operationHarness,
  pluginPrincipal,
  createFakeDeviceProvider,
  ID,
} from "../../apps/desktop/src/main/device-broker/fake-provider.js";

export async function composeMotor(input: {
  manifest: PluginManifest;
  panel: PanelResourceV1;
  status: StatusResourceV1;
  launch(
    parent: { once(event: string, callback: (event: unknown) => void): void },
    owner: unknown,
  ): void;
}) {
  const manifest = pluginManifestSchema.parse(input.manifest);
  assert.equal(manifest.id, "kobrixa.motor-test");
  assert.equal(manifest.runtime.kind, "node");
  assert.equal(manifest.runtime.entry, "main.cjs");
  const context = {
    pluginId: manifest.id,
    commands: manifest.contributes!.commands!.map((command) =>
      contextCommandDeclarationSchema.parse(command),
    ),
    panels: manifest.contributes!.panels!,
  };
  for (const resource of [input.panel, input.status])
    assert.ok(
      validateUiResource(resource, context, Buffer.byteLength(JSON.stringify(resource))).ok,
    );
  const h = operationHarness();
  const principal = pluginPrincipal();
  principal.owner.pluginId = "kobrixa.motor-test";
  principal.owner.sourceKey = "dev:0000000000000001";
  const owner = principal.owner;
  const authority = new AuthorityContexts(ID);
  const document = authority.open(1);
  let authoritySequence = 0;
  const setWritable = (writable: boolean) =>
    authority.report(1, {
      document,
      sequence: ++authoritySequence,
      state: writable ? "local" : "room",
      roomId: writable ? null : "acceptance-room",
      connected: true,
      synced: true,
      role: writable ? null : "viewer",
      isHolder: writable,
    });
  setWritable(true);
  principal.authorityContext = authority.plugin(1, owner).authorityContext;
  const contextRef = principal.authorityContext!.ref;
  const core = authority.core(1, "recovery");
  const scope = { hostEpoch: ID, workbenchInstance: core.workbenchInstance };
  const actions = createCoreActionLedger({
    now: () => performance.now(),
    current: (candidate) =>
      candidate.hostEpoch === scope.hostEpoch &&
      candidate.workbenchInstance === scope.workbenchInstance,
  });
  let busy = false;
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: () => performance.now(),
    authority,
    coreActions: actions,
    hasPermission: (p, permission) =>
      p.kind === "core" || !!manifest.permissions?.includes(permission),
    requirements: () => manifest.requires?.devices ?? [],
    operationGate: () =>
      busy
        ? {
            ok: false,
            error: {
              code: "PLUGIN_E_DEVICE_BUSY",
              message: "Recording/program host gate owns device",
              detail: {
                kind: "device",
                reason: "foreground",
                dispatch: "not-sent",
                stopConfirmation: "not-required",
              },
            },
          }
        : { ok: true, value: null },
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  const fake = createFakeDeviceProvider({
    catalog: broker.providerCatalog("kobrixa.device-ev3"),
    now: () => performance.now(),
    motionProfile: "staged",
  });
  const unregister = broker.registerProvider(fake.provider);
  // Host establishes a session explicitly; the motor plugin has no connect permission.
  unwrap(
    await broker.request(
      core,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: fake.provider.id, address: "127.0.0.1" } },
      new AbortController().signal,
    ),
  );
  const states = new UiStateRegistry({ current: () => true });
  const subscriptions = new UiSubscriptions(states, uiEventLedgerPort(broker.events), () =>
    broker.intent.revokeScope(motionScope, "resource-retired"),
  );
  const uiOwner = { sourceKey: owner.sourceKey, pluginId: owner.pluginId, uiResourceGeneration: 1 };

  const open = async (resource: PanelResourceV1 | StatusResourceV1, id: string) =>
    unwrap(
      await states.open({
        owner: uiOwner,
        id,
        scope,
        resource,
        activateInitialized: async () => ({
          owner,
          peer: host,
          principal: () => principal,
          requirements: [],
        }),
      }),
    );
  const wire: { direction: string; at: number; message: Record<string, unknown> }[] = [];
  const { port1, port2 } = new MessageChannel();
  const requests = new Map<unknown, string>();
  const routeErrors: { event: unknown; error: string }[] = [];
  let heldMethod: string | undefined;
  let release: (() => void) | undefined;
  let drop = false;
  const host = new RpcPeer(
    {
      onMessage(listener) {
        const receive = (text: string) => {
          const message = JSON.parse(text);
          requests.set(message.id, message.method);
          wire.push({ direction: "plugin-host", at: performance.now(), message });
          listener(text);
        };
        port1.on("message", receive);
        return () => port1.off("message", receive);
      },
      send(text) {
        const message = JSON.parse(text);
        wire.push({ direction: "host-plugin", at: performance.now(), message });
        if (heldMethod && requests.get(message.id) === heldMethod && !release) {
          heldMethod = undefined;
          release = () => {
            release = undefined;
            if (!drop) port1.postMessage(text);
          };
        } else port1.postMessage(text);
      },
    },
    { timeoutMs: 1000 },
  );
  let attachment: ReturnType<typeof broker.attachChannel> | undefined;
  const routed = new Proxy(broker, {
    get(target, property, receiver) {
      if (property === "attachChannel")
        return (args: Parameters<typeof broker.attachChannel>[0]) =>
          (attachment = target.attachChannel({
            ...args,
            send(event) {
              try {
                args.send(event);
              } catch (error) {
                routeErrors.push({ event, error: String(error) });
                throw error;
              }
            },
          }));
      return Reflect.get(target, property, receiver);
    },
  });
  const detach = attachDeviceRpc({
    peer: host,
    principal: () => authority.plugin(1, owner),
    broker: routed,
  });
  assert.ok(attachment);
  const channel = attachment;
  host.handle("ui/instances", () => ({ ok: true, value: { instances: states.instances(owner) } }));
  host.handle("ui/state", ({ binding }) => states.state(owner, binding));
  host.handle("ui/patch", (params, request) => {
    const result = states.patch(owner, params);
    request.afterReply(
      () => states.flush(),
      () => states.flush(),
    );
    return result;
  });
  host.handle("ui/subscribe", (params, request) => {
    const result = subscriptions.subscribe(owner, params);
    if (result.ok)
      request.afterReply(
        () => channel.activate(result.value.subscriptionId),
        () => channel.abandon(result.value.subscriptionId),
      );
    return result;
  });
  host.handle("ui/snapshot", ({ subscriptionId }) => subscriptions.snapshot(owner, subscriptionId));
  const panel = await open(input.panel, "kobrixa.motor-test.panel");
  await open(input.status, "kobrixa.motor-test.status");
  states.visibility(owner, panel.binding, true);
  const motionScope = broker.intent.bindMotionScope({
    owner,
    contextRef,
    panelInstance: panel.binding.panelInstance,
    uiResourceGeneration: 1,
    workbenchInstance: core.workbenchInstance,
  });
  let sequence = 0;
  let gesture: string | undefined;
  const pulse = () => {
    broker.intent.pulsePanel(motionScope, ++sequence);
    if (gesture) broker.intent.pulseGesture(gesture, sequence);
  };
  pulse();
  const heartbeat = setInterval(pulse, 100);
  // Only adapts Node's MessagePort event shape to Electron's existing parentPort transport.
  input.launch(
    {
      once(_event, callback) {
        callback({
          ports: [
            {
              start() {},
              postMessage: (text: string) => port2.postMessage(text),
              on(_name: string, listener: (event: { data: unknown }) => void) {
                port2.on("message", (data) => listener({ data }));
              },
              off() {},
            },
          ],
        });
      },
    },
    owner,
  );
  await host.request("initialize", {
    apiVersion: "1.6.0",
    pluginId: owner.pluginId,
    locale: "en",
    grantedPermissions: manifest.permissions ?? [],
  });
  unwrap(
    await host.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [1] }),
  );
  channel.negotiated("ui", 1);
  unwrap(await host.request("ui/ready", {}));
  const invoke = async (
    command: string,
    values = panel.form,
    phase?: "begin" | "end" | "cancel",
  ) => {
    if (phase === "begin") {
      gesture = broker.intent.beginGesture(motionScope, ++sequence);
      pulse();
    }
    const invocation: CommandInvocation = {
      version: 1,
      invocationId: randomUUID(),
      command: `kobrixa.motor-test.${command}`,
      arguments: command === "jog" ? { direction: "1" } : {},
      context: {
        contextRef,
        motionScopeRef: motionScope,
        origin: "panel",
        locale: "en",
        binding: panel.binding,
        form: { revision: 1, values },
        trigger: phase ? { kind: "hold", phase, gestureRef: gesture! } : { kind: "activate" },
      },
    };
    if (phase && phase !== "begin" && gesture)
      broker.intent.endGesture(gesture, phase === "end" ? "released" : "cancelled");
    return host.request("command/invoke", invocation);
  };
  return {
    broker,
    fake,
    owner,
    principal,
    panel,
    states,
    wire,
    routeErrors,
    invoke,
    async coreStop(sessionId: string) {
      const action = actions.mint(scope, { kind: "device-current-stop", sessionId });
      return broker.stopCurrentDevice({ sessionId, action });
    },
    setWritable,
    setBusy(value: boolean) {
      busy = value;
    },
    hold(method: "prepare" | "start", lost = false) {
      heldMethod = `devices/motion/${method}`;
      drop = lost;
    },
    held: () => !!release,
    release: () => release?.(),
    hide() {
      broker.intent.revokeScope(motionScope, "hidden");
      states.visibility(owner, panel.binding, false);
    },
    async dispose() {
      clearInterval(heartbeat);
      release?.();
      await host.request("shutdown", {}, { timeoutMs: 3000 });
      subscriptions.dispose();
      broker.intent.revokeScope(motionScope, "resource-retired");
      detach();
      host.close();
      port1.close();
      port2.close();
      await broker.resources.beginShutdown();
      unregister();
      actions.retire(scope);
      assert.equal(actions.count(), 0);
      assert.equal(
        broker.events.diagnostics().subscriptions,
        0,
        "No surviving common subscriptions",
      );
    },
  };
}

import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  readSource,
  type FoundationDiagnosticEvent,
  type PluginLauncher,
} from "@kobrixa/plugin-runtime";
import { type ResourceOwner, type MotionSnapshot } from "@kobrixa/plugin-protocol";
import {
  composeDesktopMain,
  desktopUi,
  createWindowRetirementHandler,
  trustedDeviceActions,
} from "../../apps/desktop/src/main/plugins/controller.js";
import {
  createDesktopFoundation,
  CleanupBlocked,
  type DesktopMainComposition,
  type DesktopMainCompositionInput,
} from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import { type FakeProviderControl } from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import type { ProviderStep } from "../../apps/desktop/src/main/device-broker/provider.js";
import { createJournal } from "../../apps/desktop/src/main/device-broker/journal.js";
import { createJournalFilesystem } from "../../apps/desktop/src/main/device-broker/journal-filesystem.js";
import { startPrimary } from "../../apps/desktop/src/main/plugins/profile-writer-lock.js";
import {
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

export type NativeMotorScenario = {
  boundary: "prepare" | "start" | "arm" | "pulse";
  position: "before" | "after";
  fault:
    | "hide"
    | "close"
    | "blur"
    | "authority-loss"
    | "renderer-crash"
    | "renderer-freeze"
    | "plugin-kill"
    | "release"
    | "cancel"
    | "stop"
    | "motor-disable"
    | "provider-disable"
    | "suspend"
    | "disconnect"
    | "second-launch"
    | "source-loss"
    | "complete";
  safeMode?: boolean;
  parity?: "drafts" | "layout" | "invalid-stop";
  mode?: "jog" | "timed" | "relative-angle";
  key?: "Space" | "Enter";
  stress?: "lost-start" | "withheld-readback";
};
// Test-only composition overrides: fake physical provider and RPC reply barriers.
// The consumer, resources, utilityProcess transport, UI bridge and intent are production code.
export function runNativeMotor() {
  const inputPath = app.commandLine.getSwitchValue("motor-input");
  const output = app.commandLine.getSwitchValue("motor-output");
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
  const inputReceipts: Array<{
    at: number;
    type: string;
    isTrusted: boolean;
    node?: string;
    key?: string;
    repeat?: boolean;
  }> = [];
  const presentationSamples: Array<{ at: number; snapshots: unknown[] }> = [];
  let observePresentation = () => {};
  const expectedCleanupReports: string[] = [];
  let allowBlockedCleanup = false;
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
  let loseProvider: (() => void) | undefined;
  const childPids = new Set<number>();
  let owner: ResourceOwner | undefined;
  let pid: number | undefined;
  let releaseReply: (() => void) | undefined;
  let replyReached = false;
  let blocked: { point: "before-exchange" | "after-exchange"; step: ProviderStep } | undefined;
  let operationId: string | undefined;
  let scenario: NativeMotorScenario;

  function observingLauncher(hooks: Parameters<typeof createDesktopLauncher>[0]): PluginLauncher {
    const launch = createDesktopLauncher({
      ...hooks,
      onOutput(plugin, line) {
        hooks.onOutput?.(plugin, line);
        logs.push(line);
        const match = /MOTOR_PID:(\d+)/.exec(line);
        if (match) {
          pid = Number(match[1]);
          childPids.add(pid);
        }
      },
    });
    return async (plugin) => {
      owner = plugin.channelOwner;
      const child = await launch(plugin);
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
            listener(text);
          });
        },
        send(text) {
          const message = JSON.parse(text) as Record<string, unknown>;
          wire.push({ at: wall(), direction: "host-plugin", message });
          const method = requests.get(message.id);
          if (method === "ui/patch") queueMicrotask(observePresentation);
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
    scenario = JSON.parse(await readFile(inputPath, "utf8")) as NativeMotorScenario;
    console.log("Motor native case", JSON.stringify(scenario));
    const primary = startPrimary(
      app,
      async (profile) => {
        const directory = await realpath(path.join(root, "source"));
        const sources = [await readSource({ kind: "development", directory }, { safeMode: false })];
        const sourceFor = (sourceKey: string) =>
          sources.find((source) => source.sourceKey === sourceKey);
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
                assert.ok("lose" in fake.provider && typeof fake.provider.lose === "function");
                const lose = fake.provider.lose;
                loseProvider = () => lose.call(fake.provider);
                return fake.provider;
              },
            });
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
                : !!sourceFor(principal.owner.sourceKey)?.manifest?.permissions?.includes(
                    permission,
                  ),
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
              developmentDirectories: [directory],
              safeMode: scenario.safeMode ?? false,
            },
            dialogs: {
              confirmDeveloperMode: async () => true,
              chooseFolder: async () => undefined,
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
        observePresentation = () => {
          if (!owner) return;
          presentationSamples.push({
            at: wall(),
            snapshots: ui.states
              .instances(owner)
              .map((binding) => ui.states.state(owner!, binding)),
          });
        };
        const diagnostics = diagnosticsFor(ui.bridge);
        const counterSamples = [
          { at: wall(), label: "composed", counters: diagnostics.snapshot() },
        ];
        const offDiagnostics = diagnostics.onEvent((event) => {
          events.push(event);
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
                ipc.push({ ...row, result: value });
              },
              (error) => {
                ipc.push({ ...row, error: String(error) });
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
        const offDevice = composition.foundation.broker.recovery.subscribe(() =>
          recovery.changed(),
        );
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
        window.webContents.on("console-message", (detail) => {
          logs.push(`renderer:${detail.message}`);
          const prefix = "NATIVE_INPUT:";
          if (detail.message.startsWith(prefix))
            inputReceipts.push(JSON.parse(detail.message.slice(prefix.length)));
        });
        let closed = false;
        let refusedClose: CleanupBlocked | undefined;
        window.on("close", (event) => {
          if (closed) return;
          event.preventDefault();
          native.push({ at: wall(), type: "window-close-attempt" });
          void composition.dispose().then(
            () => {
              closed = true;
              window.close();
            },
            (error) => {
              if (allowBlockedCleanup && error instanceof CleanupBlocked) refusedClose = error;
              else failures.push(String(error));
            },
          );
        });
        if (scenario.safeMode) {
          await window.loadFile(path.join(root, "renderer/index.html"));
          window.show();
          window.focus();
          native.push({ at: wall(), type: "cold-safe-mode-window" });
          const recovery = await window.webContents.executeJavaScript(
            "window.kobrixa.plugins.recovery.snapshot({})",
          );
          const plugins = composition.plugins.state();
          assert.equal(plugins.safeMode, true);
          assert.equal(wire.length, 0, "Safe mode must not launch the optional motor");
          assert.equal(pid, undefined);
          assert.ok(recovery, "Core recovery remains accessible");
          await composition.dispose();
          const final = diagnostics.snapshot();
          counterSamples.push({ at: wall(), label: "disposed", counters: final });
          assert.ok(Object.values(final).every((v) => v === 0));
          offEvents();
          offRecovery();
          offDevice();
          offDiagnostics();
          await writeFile(
            output,
            JSON.stringify(
              {
                kind: "motor-public-native-cold",
                composition: "composeDesktopMain/createDesktopFoundation",
                scenario,
                plugins,
                recovery,
                wire,
                native,
                final,
                failures,
                versions: process.versions,
              },
              null,
              2,
            ),
          );
          closed = true;
          window.close();
          app.quit();
          return;
        }
        unwrap(
          await composition.foundation.broker.request(
            authority.core(senderId, "recovery"),
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
        const js = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
        const target = async (selector: string) =>
          until(
            async () =>
              js<{ x: number; y: number } | null>(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e || e.disabled || e.closest('[hidden]')) return null;
        e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect();
        return r.width && r.height ? {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} : null;
      })()`),
            `native target ${selector}`,
          );
        const mouse = (type: "mouseDown" | "mouseUp", bounds: { x: number; y: number }) => {
          native.push({ at: wall(), type, detail: bounds });
          window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...bounds });
        };
        const click = async (selector: string) => {
          const bounds = await target(selector);
          mouse("mouseDown", bounds);
          mouse("mouseUp", bounds);
        };
        const key = (type: "keyDown" | "keyUp", keyCode: string, repeat = false) => {
          native.push({ at: wall(), type, detail: { keyCode, repeat } });
          window.webContents.sendInputEvent({
            type,
            keyCode,
            modifiers: repeat ? ["isautorepeat"] : [],
          });
        };
        await click('.plugin-tools-pane [role="tabpanel"] > button');
        await until(
          () =>
            owner &&
            pid &&
            ui.states
              .instances(owner)
              .some((binding) => binding.kind === "panel" && ui.intent.scope(binding)),
          "actual SDK panel scope and PID",
        );
        assert.ok(owner && control && pid);
        assert.equal(
          wire.filter(
            (row) => row.direction === "plugin-host" && row.message.method === "devices/connect",
          ).length,
          0,
        );
        const cold = wire.filter(
          (row) =>
            row.direction === "plugin-host" && row.message.method === "devices/motion/prepare",
        ).length;
        assert.equal(cold, 0, "Opening actual motor must not move");
        await click('[data-ui-node="select-current"] button');
        const mode = scenario.mode ?? (scenario.boundary === "arm" ? "relative-angle" : "jog");
        if (mode !== "jog") {
          await click('[data-ui-node="a-mode"] select');
          key("keyDown", "Home");
          key("keyUp", "Home");
          for (let i = 0; i < (mode === "timed" ? 1 : 2); i++) {
            key("keyDown", "Down");
            key("keyUp", "Down");
          }
          key("keyDown", "Return");
          key("keyUp", "Return");
          await until(
            () =>
              js<boolean>(
                `document.querySelector('[data-ui-node="a-mode"] select')?.value === ${JSON.stringify(mode)}`,
              ),
            "native mode selection",
          );
        }
        const parity: Record<string, unknown> = {};
        const field = (node: string) => `[data-ui-node="${node}"] input[type="text"]`;
        const readField = (node: string) =>
          js<string>(`document.querySelector(${JSON.stringify(field(node))})?.value`);
        const edit = async (node: string, value: string) => {
          await click(field(node));
          window.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "A",
            modifiers: [process.platform === "darwin" ? "meta" : "control"],
          });
          window.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "A",
            modifiers: [process.platform === "darwin" ? "meta" : "control"],
          });
          key("keyDown", "Backspace");
          key("keyUp", "Backspace");
          native.push({ at: wall(), type: "insertText", detail: { node, value } });
          window.webContents.insertText(value);
          await until(async () => (await readField(node)) === value, `native field ${node}`);
        };
        if (scenario.parity === "drafts") {
          const defaults = await js<Record<string, unknown>[]>(`['a','b','c','d'].map(port=>{
            const element=field=>document.querySelector('[data-ui-node="'+port+'-'+field+'"] '+(field==='mode'||field==='direction'?'select':field==='brake'?'input[type="checkbox"]':'input[type="text"]'));
            return {port,mode:element('mode').value,power:element('power').value,seconds:element('seconds').value,degrees:element('degrees').value,direction:element('direction').value,brake:element('brake').checked};
          })`);
          assert.deepEqual(
            defaults,
            ["a", "b", "c", "d"].map((port) => ({
              port,
              mode: "jog",
              power: "20",
              seconds: "1",
              degrees: "90",
              direction: "1",
              brake: true,
            })),
          );
          parity.defaults = defaults;
          assert.equal(await readField("a-power"), "20");
          await edit("a-power", "31");
          await click('[data-ui-node="port"] label:nth-of-type(2)');
          await until(async () => (await readField("b-power")) === "20", "B default");
          await edit("b-power", "bad");
          assert.ok(
            await js<boolean>(
              `document.querySelector('[data-ui-node="b-forward"] button').disabled`,
            ),
            "Invalid raw blocks generic hold action",
          );
          assert.equal(
            wire.filter(
              (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/prepare",
            ).length,
            0,
          );
          await click('[data-close-contribution="true"]');
          await click('.plugin-tools-pane [role="tabpanel"] > button');
          await until(
            async () => (await readField("b-power")) === "bad",
            "invalid raw draft after close/reopen",
          );
          const bRaw = await readField("b-power");
          await click('[data-ui-node="port"] label:nth-of-type(1)');
          await until(async () => (await readField("a-power")) === "31", "independent A draft");
          parity.drafts = {
            a: await readField("a-power"),
            bRaw,
            note: "B raw observed after reopen; never restores motion",
          };
        }
        if (scenario.parity === "layout") {
          await click('[data-harness="layout"]');
          const layouts = [];
          for (const locale of ["en", "zh-TW"] as const) {
            if (locale === "zh-TW") await click('[data-harness="locale"]');
            await until(
              () => js<boolean>(`document.documentElement.lang === ${JSON.stringify(locale)}`),
              `locale ${locale}`,
            );
            ui.states.setEnvironment(locale, "dark");
            await pause(150);
            const layout = await js<{
              width: number;
              scroll: number;
              client: number;
              text: string;
            }>(
              `(()=>{const e=document.querySelector('.plugin-tools-pane');return {width:e.getBoundingClientRect().width,scroll:e.scrollWidth,client:e.clientWidth,text:e.innerText}})()`,
            );
            assert.ok(layout.scroll <= layout.client, `${locale} narrow overflow`);
            assert.ok(
              layout.text.includes(locale === "en" ? "Use current connection" : "使用目前連線"),
            );
            const screenshot = path.join(root, `motor-${locale}-320px-125.png`);
            await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
            layouts.push({ locale, ...layout, screenshot });
          }
          parity.layouts = layouts;
          await click('[data-harness="locale"]');
        }
        const rendererBefore = await js(
          "({text:document.body.innerText, fields:[...document.querySelectorAll('[data-ui-node] input,[data-ui-node] select')].map(e=>({node:e.closest('[data-ui-node]').dataset.uiNode,value:e.value,checked:e.checked}))})",
        );
        const principal = authority.plugin(senderId, owner);
        const hostQueries: Array<{ at: number; operationId: string; result: unknown }> = [];
        const traceBefore = control.trace().length,
          eventBefore = events.length;
        const step: ProviderStep =
          scenario.boundary === "arm"
            ? "helper-arm"
            : scenario.boundary === "pulse"
              ? "motion-pulse"
              : "preflight";
        blocked = {
          point: ["prepare", "start"].includes(scenario.boundary)
            ? "before-exchange"
            : scenario.position === "before"
              ? "before-exchange"
              : "after-exchange",
          step,
        };
        control.block(blocked.point, step);
        if (scenario.stress === "withheld-readback") control.block("before-exchange", "readback");
        const bounds = await target(
          `[data-ui-node="${mode === "jog" ? "a-forward" : "a-start"}"] button`,
        );
        if (scenario.key) {
          // Cycle real keyboard focus; reading activeElement does not dispatch input.
          for (let i = 0; i < 100; i++) {
            if (
              await js<boolean>(
                `document.activeElement?.closest('[data-ui-node]')?.dataset.uiNode === 'a-forward'`,
              )
            )
              break;
            key("keyDown", "Tab");
            key("keyUp", "Tab");
            await pause(10);
          }
          assert.ok(
            await js<boolean>(
              `document.activeElement?.closest('[data-ui-node]')?.dataset.uiNode === 'a-forward'`,
            ),
            "Native Tab reached hold",
          );
          key("keyDown", scenario.key);
          for (let i = 0; i < 3; i++) key("keyDown", scenario.key, true);
        } else {
          mouse("mouseDown", bounds);
          if (mode !== "jog") mouse("mouseUp", bounds);
        }
        if (["prepare", "start"].includes(scenario.boundary) || scenario.stress === "lost-start")
          await until(() => replyReached, `${scenario.boundary} actual RPC reply`);
        else await bounded(control.reached(blocked.point, step), `${blocked.point}/${step}`);
        assert.ok(operationId, "Original prepared ID required");
        // For delivered replies, wait until the consumer has crossed the reply boundary.
        if (
          ["prepare", "start"].includes(scenario.boundary) &&
          scenario.position === "after" &&
          !scenario.stress
        )
          await bounded(
            control.reached("before-exchange", "preflight"),
            "delivered reply -> preflight",
          );
        if (scenario.parity === "invalid-stop") {
          await edit("a-power", "bad");
          const invalid = await js<boolean>(
            `Boolean(document.querySelector('[data-ui-node="a-power"] [role="alert"]'))`,
          );
          parity.invalidStop = { raw: await readField("a-power"), fieldErrorVisible: invalid };
          assert.equal(await readField("a-power"), "bad");
        }
        const motionPrepare = wire.find(
          (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/prepare",
        )!;
        const sessionId = (motionPrepare.message.params as { sessionId: string }).sessionId;
        let lifecycleWork: Promise<unknown> | undefined;
        const lifecycleReceipt: Record<string, unknown> = {};
        const deferLifecycle = (work: Promise<unknown>) => {
          lifecycleWork = work.then(
            (value) => {
              lifecycleReceipt.result = value;
            },
            (error) => {
              lifecycleReceipt.error = String(error);
              failures.push(String(error));
            },
          );
        };
        const sourceKey = owner.sourceKey;
        counterSamples.push({ at: wall(), label: "boundary", counters: diagnostics.snapshot() });
        const faultAt = wall();
        native.push({ at: faultAt, type: scenario.fault });
        const traceAtFault = control.trace().length;
        switch (scenario.fault) {
          case "complete":
            releaseReply?.();
            control.release(blocked!.point, blocked!.step);
            blocked = undefined;
            await until(
              async () => {
                const result = await composition.foundation.broker.request(
                  principal,
                  "devices/motion/query",
                  { operationId: operationId! },
                  new AbortController().signal,
                );
                hostQueries.push({ at: wall(), operationId: operationId!, result });
                return (
                  result.ok &&
                  result.value.operation.phase === "completed" &&
                  result.value.operation.stopConfirmation === "confirmed"
                );
              },
              "actual operation completion before hide",
              20_000,
            );
            await until(
              () =>
                presentationSamples.some((sample) =>
                  sample.snapshots.some((snapshot) => {
                    const result = snapshot as {
                      ok?: boolean;
                      value?: { data?: Record<string, unknown> };
                    };
                    return (
                      result.ok &&
                      result.value?.data?.phase === "Completed" &&
                      typeof result.value.data.progress === "number" &&
                      result.value.data.progress >= 0 &&
                      result.value.data.progress <= 1
                    );
                  }),
                ),
              "actual generic completion presentation",
            );
            window.hide();
            break;
          case "source-loss":
            assert.ok(loseProvider);
            loseProvider();
            break;
          case "motor-disable":
            deferLifecycle(composition.plugins.setEnabled(sourceKey, false));
            break;
          case "provider-disable":
            deferLifecycle(composition.plugins.setEnabled("builtin:kobrixa.device-ev3", false));
            break;
          case "suspend":
            deferLifecycle(ui.coordinator.suspend(sessionId));
            break;
          case "disconnect":
            deferLifecycle(
              trustedDeviceActions(
                composition.foundation.broker,
                ui.coordinator,
                actions,
              ).trustedCoreDisconnect(sessionId, authority.core(senderId, "recovery")),
            );
            break;
          case "second-launch": {
            const child = spawn(
              process.execPath,
              [
                process.argv[1]!,
                `--motor-input=${inputPath}`,
                `--motor-output=${output}.secondary`,
              ],
              { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
            );
            const outputLines: string[] = [];
            child.stdout.on("data", (data) => outputLines.push(String(data)));
            child.stderr.on("data", (data) => outputLines.push(String(data)));
            const result = await bounded(
              new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
                child.once("error", reject);
                child.once("exit", (code, signal) => resolve({ code, signal }));
              }),
              "actual second instance exit",
            );
            lifecycleReceipt.secondInstance = {
              pid: child.pid,
              ...result,
              output: outputLines.join(""),
            };
            assert.equal(result.code, 0);
            assert.doesNotMatch(
              outputLines.join(""),
              /MOTOR_PID:/,
              "Second instance must not launch a motor utility process",
            );
            if (scenario.key) key("keyUp", scenario.key);
            else mouse("mouseUp", bounds);
            break;
          }
          case "hide":
            window.hide();
            break;
          case "close":
            await click('[data-close-contribution="true"]');
            break;
          case "blur": {
            const other = new BrowserWindow({
              width: 200,
              height: 150,
              show: true,
              webPreferences: { sandbox: true },
            });
            other.focus();
            await until(() => !window.isFocused(), "native window blur");
            other.destroy();
            break;
          }
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
          case "renderer-crash":
            window.webContents.forcefullyCrashRenderer();
            break;
          case "renderer-freeze":
            window.webContents.debugger.attach("1.3");
            await window.webContents.debugger.sendCommand("Debugger.enable");
            await window.webContents.debugger.sendCommand("Debugger.pause");
            break;
          case "plugin-kill":
            process.kill(pid, "SIGKILL");
            break;
          case "release":
            if (scenario.key) key("keyUp", scenario.key);
            else mouse("mouseUp", bounds);
            break;
          case "cancel":
            // Escape is the production generic hold cancellation input.
            key("keyDown", "Escape");
            key("keyUp", "Escape");
            break;
          case "stop":
            await click('[data-ui-node="stop"] button');
            break;
        }
        const hostLifecycle = [
          "motor-disable",
          "provider-disable",
          "suspend",
          "disconnect",
          "source-loss",
        ].includes(scenario.fault);
        if (scenario.fault === "source-loss")
          await until(
            () =>
              composition.foundation.broker.recovery
                .snapshot()
                .faults.some((f) => f.operationId === operationId),
            "source loss durable fault",
          );
        else if (hostLifecycle)
          await until(
            () =>
              control!
                .trace()
                .slice(traceAtFault)
                .some((r) => r.step === "stop" && r.dispatch === "sent"),
            "host lifecycle stop dispatch",
          );
        else {
          await until(
            () =>
              events
                .slice(eventBefore)
                .filter((e) => e.time >= faultAt)
                .some(
                  (e) =>
                    e.kind ===
                    (["release", "cancel", "stop", "second-launch"].includes(scenario.fault)
                      ? "stop-dispatch"
                      : "revoke"),
                ),
            "observed host cancellation/revocation",
          );
        }
        const cancellation = events
          .slice(eventBefore)
          .filter((e) => e.time >= faultAt)
          .find(
            (e) =>
              e.kind ===
              (["release", "cancel", "stop", "second-launch"].includes(scenario.fault)
                ? "stop-dispatch"
                : "revoke"),
          );
        assert.ok(cancellation || hostLifecycle);
        const revokedAt = cancellation ? cancellation.time : faultAt,
          traceAtRevoke = control.trace().length;
        if (scenario.stress === "lost-start") {
          const heldAt = wire.find(
            (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/start",
          )!.at;
          await until(
            () =>
              wire.some(
                (r) =>
                  r.at > heldAt + 4500 &&
                  r.direction === "plugin-host" &&
                  r.message.method === "devices/motion/query" &&
                  (r.message.params as { operationId?: string }).operationId === operationId,
              ),
            "SDK lost start timeout queries original ID",
            8000,
          );
        }
        releaseReply?.();
        if (blocked) {
          control.release(blocked.point, blocked.step);
          blocked = undefined;
        }
        if (scenario.fault === "renderer-freeze") {
          await window.webContents.debugger.sendCommand("Debugger.resume");
          window.webContents.debugger.detach();
        }
        let terminal: MotionSnapshot | undefined;
        await until(
          async () => {
            const result = await composition.foundation.broker.request(
              principal,
              "devices/motion/query",
              { operationId: operationId! },
              new AbortController().signal,
            );
            hostQueries.push({ at: wall(), operationId: operationId!, result });
            if (!result.ok) return false;
            terminal = result.value.operation;
            return (
              ["completed", "stopped", "timeout", "failed", "unconfirmed"].includes(
                terminal.phase,
              ) &&
              !composition.foundation.broker.recovery
                .snapshot()
                .faults.some((f) => f.operationId === operationId && f.state === "pending")
            );
          },
          "original operation terminal and durable stop result",
          25_000,
        );
        const stoppedAt = wall();
        if (scenario.key)
          assert.equal(
            wire.filter(
              (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/prepare",
            ).length,
            1,
            "Native repeat cannot create another operation",
          );
        assert.ok(terminal);
        let trace = control.trace().slice(traceBefore);
        const consequential = new Set<ProviderStep>([
          "helper-upload",
          "helper-run",
          "helper-arm",
          "motion-pulse",
        ]);
        assert.deepEqual(
          control
            .trace()
            .slice(traceAtRevoke)
            .filter((r) => consequential.has(r.step) && r.dispatch !== "not-sent"),
          [],
        );
        await lifecycleWork;
        if (["motor-disable", "provider-disable"].includes(scenario.fault)) {
          const before = composition.plugins.state();
          lifecycleReceipt.disabled = before;
          const disabledKey =
            scenario.fault === "motor-disable" ? sourceKey : "builtin:kobrixa.device-ev3";
          assert.equal(before.plugins.find((p) => p.sourceKey === disabledKey)?.status, "disabled");
          const otherKey =
            scenario.fault === "motor-disable" ? "builtin:kobrixa.device-ev3" : sourceKey;
          assert.equal(
            before.plugins.find((p) => p.sourceKey === otherKey)?.status,
            "enabled",
            "Independent toggle",
          );
          lifecycleReceipt.persistedDisabled = JSON.parse(
            await readFile(path.join(app.getPath("userData"), "plugins", "state.json"), "utf8"),
          );
          assert.ok(
            (lifecycleReceipt.persistedDisabled as { disabled: string[] }).disabled.includes(
              disabledKey,
            ),
          );
          const result = await composition.plugins.setEnabled(disabledKey, true);
          lifecycleReceipt.reenabled = result;
          assert.equal(
            composition.plugins.state().plugins.find((p) => p.sourceKey === disabledKey)?.status,
            "enabled",
          );
          lifecycleReceipt.persistedSettings = JSON.parse(
            await readFile(path.join(app.getPath("userData"), "plugins", "state.json"), "utf8"),
          );
        }
        if (scenario.fault === "suspend") {
          await ui.coordinator.resume(sessionId);
          lifecycleReceipt.wokeAt = wall();
        }
        if (scenario.fault === "disconnect") {
          lifecycleReceipt.reconnected = await composition.foundation.broker.request(
            authority.core(senderId, "recovery"),
            "devices/connect",
            {
              target: {
                kind: "wifi-address",
                providerId: "kobrixa.device-ev3",
                address: "127.0.0.1",
              },
            },
            new AbortController().signal,
          );
        }
        await pause(500);
        assert.equal(
          wire.filter(
            (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/prepare",
          ).length,
          1,
          "Lifecycle restore must never replay motion",
        );
        const recoverySnapshot = composition.foundation.broker.recovery.snapshot();
        let expectedBlockedClose: { name: string; message: string; device: unknown } | undefined;
        if (
          scenario.stress === "withheld-readback" ||
          (scenario.fault === "source-loss" && terminal.stopConfirmation === "unconfirmed")
        ) {
          assert.equal(terminal.stopConfirmation, "unconfirmed");
          assert.equal(terminal.phase, "unconfirmed");
          allowBlockedCleanup = true;
          window.close();
          const blockedClose = await until(
            () => refusedClose,
            "actual native window close refused",
            25_000,
          );
          assert.equal(window.isDestroyed(), false, "Unconfirmed normal close keeps window alive");
          expectedBlockedClose = {
            name: blockedClose.name,
            message: blockedClose.message,
            device: blockedClose.device,
          };
          assert.ok(expectedBlockedClose, "Unconfirmed operation must block normal close");
          if (scenario.stress === "withheld-readback") {
            const originalFault = recoverySnapshot.faults.find(
              (f) => f.operationId === operationId,
            );
            assert.ok(originalFault && originalFault.state === "unconfirmed");
            control.release("before-exchange", "readback");
            await pause(100);
            assert.deepEqual(
              composition.foundation.broker.recovery
                .snapshot()
                .faults.find((f) => f.operationId === operationId),
              originalFault,
              "Late readback cannot rewrite durable uncertainty",
            );
          }
        } else await bounded(composition.dispose(), "real composition cleanup", 25_000);
        await retirement;
        trace = control.trace().slice(traceBefore);
        assert.deepEqual(
          trace
            .slice(traceAtRevoke - traceBefore)
            .filter((r) => consequential.has(r.step) && r.dispatch !== "not-sent"),
          [],
          "No late write through restore and disposal",
        );
        const final = diagnostics.snapshot();
        counterSamples.push({ at: wall(), label: "disposed", counters: final });
        if (!expectedBlockedClose)
          assert.ok(
            Object.values(final).every((v) => v === 0),
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
              kind: "motor-public-native",
              composition: "composeDesktopMain/createDesktopFoundation",
              scenario,
              faultAt,
              revokedAt,
              stoppedAt,
              operationId,
              terminal,
              trace: trace.map((r) => ({ ...r, time: performance.timeOrigin + r.time })),
              traceAtRevoke: traceAtRevoke - traceBefore,
              events,
              wire,
              deliveries,
              ipc,
              logs,
              native,
              inputReceipts,
              counterSamples,
              lifecycleReceipt,
              hostQueries,
              presentationSamples,
              rendererBefore,
              parity,
              recoverySnapshot,
              final,
              failures,
              pid,
              childPids: [...childPids],
              expectedBlockedClose,
              expectedCleanupReports,
              versions: process.versions,
            },
            null,
            2,
          ),
        );
        assert.deepEqual(failures, []);
        if (expectedBlockedClose) {
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
    if (!primary) return; // Real second instance exits without composing or starting a plugin.
    await primary.ready;
  }
  const deadline = setTimeout(() => {
    console.error("Motor native deadline");
    app.exit(2);
  }, 85_000);
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
      if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) {
        await win.webContents.debugger.sendCommand("Debugger.resume").catch(() => {});
        win.webContents.debugger.detach();
      }
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
                ? await bounded(
                    win.webContents.executeJavaScript("document.body.innerText"),
                    "failed renderer inspection",
                    1500,
                  ).catch(String)
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
}
