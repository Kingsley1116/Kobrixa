import type {
  Principal as ImportedPrincipal,
  CoreActionReference as ImportedCoreActionReference,
} from "@kobrixa/plugin-runtime";
import type { AuthorityPort as ImportedAuthorityPort } from "./device-broker/authority-port.js";
import type { CorePrincipal as ImportedCorePrincipal } from "./device-broker/broker-port.js";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
const fileDialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: { handle: (key: string, fn: (...args: unknown[]) => unknown) => handlers.set(key, fn) },
  shell: {},
  dialog: fileDialog,
}));
import { registerIpc } from "./ipc.js";
import { DeviceControlGate } from "./collab/device-control.js";
import { AuthorityContexts } from "./device-broker/authority-context.js";
import {
  UpdateOperationGate,
  assertDeviceUpdateAdmission,
  UpdateService,
} from "./updates/service.js";
import { trustedDeviceActions, createLegacyActionAdmission } from "./plugins/controller.js";
import { createLegacyDevice, createLegacyMonitorFeed } from "./device-broker/legacy-device.js";
import { createCoreActionLedger } from "./plugins/core-recovery.js";
import type { DeviceBrokerPort } from "./device-broker/broker-port.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
beforeEach(() => handlers.clear());
function fixture() {
  const renderer = { id: 7, mainFrame: {}, once: vi.fn() };
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const authority = new DeviceControlGate(new AuthorityContexts(id(1)));
  const disconnect = vi.fn(async (_session: string, _principal: ImportedPrincipal) => {}),
    stop = vi.fn(async (_session: string, _principal: ImportedPrincipal) => {}),
    beforeClose = vi.fn(async () => {}),
    finish = vi.fn();
  const motors = { flush: vi.fn(async () => {}) },
    lab = { flush: vi.fn(async () => {}) };
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new UpdateOperationGate(() => undefined),
    finish,
    undefined,
    { monitor: {} as never, lab: lab as never, motors: motors as never },
    [],
    undefined,
    undefined,
    { authority, disconnect, stop, beforeClose },
  );
  return {
    renderer,
    event,
    authority,
    disconnect,
    stop,
    beforeClose,
    finish,
    motors,
    lab,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args),
  };
}
it("BM-04 principal derivation belongs to DeviceControlGate, not AuthorityPort", () => {
  const contexts = new AuthorityContexts(id(1));
  const authority: ImportedAuthorityPort = contexts;
  const gate = new DeviceControlGate(contexts);
  expect(gate.contexts).toBe(authority);
  expectTypeOf<typeof gate.principal>().parameters.toEqualTypeOf<
    [number, ImportedCorePrincipal["adapter"]]
  >();
  expectTypeOf<Extract<"principal", keyof typeof authority>>().toEqualTypeOf<never>();
});
it("F02 rejects foreign/subframe senders before deriving any principal", async () => {
  const f = fixture();
  for (const event of [
    { ...f.event, sender: { ...f.renderer, id: 8 } },
    { ...f.event, senderFrame: {} },
  ])
    expect(() => handlers.get("collab:device-control-context")!(event)).toThrow("untrusted");
  expect(f.disconnect).not.toHaveBeenCalled();
});
it("F03 report needs the main-issued document and cannot carry an owner or scope", async () => {
  const f = fixture();
  const context = f.call("collab:device-control-context") as { document: string };
  const report = {
    document: context.document,
    sequence: 1,
    state: "local",
    roomId: null,
    connected: true,
    synced: true,
    role: null,
    isHolder: true,
  };
  await expect(
    f.call("collab:set-device-control", { ...report, owner: {}, hostEpoch: id(5) }),
  ).rejects.toThrow();
  await f.call("collab:set-device-control", report);
  await f.call("device:disconnect", id(2));
  expect(f.disconnect).toHaveBeenCalledWith(
    id(2),
    expect.objectContaining({ kind: "core", adapter: "recovery", hostEpoch: id(1) }),
  );
});
it("F17 renderer flush success cannot skip legacy or foundation save blockers", async () => {
  const f = fixture();
  f.lab.flush.mockRejectedValueOnce(new Error("legacy disk full"));
  await expect(f.call("workspace:finish-close", id(2), true)).rejects.toThrow("disk full");
  expect(f.finish).not.toHaveBeenCalled();
  f.beforeClose.mockRejectedValueOnce(new Error("journal unconfirmed"));
  await expect(f.call("workspace:finish-close", id(2), true)).rejects.toThrow("journal");
  expect(f.finish).not.toHaveBeenCalled();
  await f.call("workspace:finish-close", id(2), true);
  expect(f.finish).toHaveBeenCalledWith(id(2), true);
});
it("BM-04 sender admission precedes one mint/claim/complete and retry uses a fresh token", async () => {
  const f = fixture();
  const issued = f.call("collab:device-control-context") as { document: string };
  await f.call("collab:set-device-control", {
    document: issued.document,
    sequence: 1,
    state: "local",
    roomId: null,
    connected: true,
    synced: true,
    role: null,
    isHolder: true,
  });
  const principal = f.authority.principal(f.renderer.id, "recovery");
  if (principal.kind !== "core") throw new Error("Expected core principal");
  const ledger = createCoreActionLedger({
    now: () => 0,
    current: (scope) =>
      scope.hostEpoch === principal.hostEpoch &&
      scope.workbenchInstance === principal.workbenchInstance,
  });
  const mint = vi.spyOn(ledger, "mint"),
    claim = vi.spyOn(ledger, "claim"),
    complete = vi.spyOn(ledger, "complete");
  const broker = {
    stopCurrentDevice: vi.fn<DeviceBrokerPort["stopCurrentDevice"]>(
      async ({ sessionId, action }) => {
        expect(ledger.claim(action, { kind: "device-current-stop", sessionId })).toBe(true);
        return {
          ok: true,
          value: { revision: 0, journalHealth: "ready", faults: [], blockers: [] },
        };
      },
    ),
  };
  let fail = true;
  const coordinator = {
    async disconnect(sessionId: string, action: ImportedCoreActionReference) {
      expect(ledger.claim(action, { kind: "device-disconnect", sessionId })).toBe(true);
      if (fail) throw new Error("journal blocked");
    },
  };
  const callbacks = trustedDeviceActions(broker, coordinator, ledger);
  const admission = createLegacyActionAdmission(callbacks);
  const legacy = createLegacyDevice({
    broker: broker as unknown as DeviceBrokerPort,
    principal: () => principal,
    feed: {} as Parameters<typeof createLegacyDevice>[0]["feed"],
    stop: admission.stop,
    disconnect: admission.disconnect,
  });
  const admitted = admission.bind(legacy);
  f.stop.mockImplementation(admitted.stop);
  f.disconnect.mockImplementation(admitted.disconnect);
  // Model each non-IPC entry without handing it the private admitted wrapper.
  const timer = () => legacy.stop(id(2));
  const ready = () => legacy.disconnect(id(2));
  const deviceServiceEvent = () => legacy.stop(id(2));
  for (const callback of [timer, ready, deviceServiceEvent])
    await expect(Promise.resolve().then(callback)).rejects.toThrow("Validated device IPC required");
  expect(broker.stopCurrentDevice).not.toHaveBeenCalled();
  expect(mint).not.toHaveBeenCalled();
  expect(() => handlers.get("device:stop")!({ ...f.event, senderFrame: {} }, id(2))).toThrow(
    "untrusted",
  );
  expect(mint).not.toHaveBeenCalled();
  await f.call("device:stop", id(2));
  expect(mint).toHaveBeenCalledTimes(1);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(mint.mock.calls[0]![1]).toEqual({ kind: "device-current-stop", sessionId: id(2) });
  await expect(f.call("device:disconnect", id(2))).rejects.toThrow("journal blocked");
  fail = false;
  await f.call("device:disconnect", id(2));
  expect(mint).toHaveBeenCalledTimes(3);
  expect(claim).toHaveBeenCalledTimes(3);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(new Set(mint.mock.results.map((result) => result.value.actionToken)).size).toBe(3);
  await expect(legacy.stop(id(2))).rejects.toThrow("Validated device IPC required");
  await expect(legacy.disconnect(id(2))).rejects.toThrow("Validated device IPC required");
  expect(mint).toHaveBeenCalledTimes(3);
});

import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceService } from "./device/device.js";
import { LegacyFiles } from "./device-broker/legacy-files.js";
import type { LegacyOperation } from "./device-broker/broker-port.js";
afterEach(() => vi.useRealTimers());
async function renewalFixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const root = await mkdtemp(join(tmpdir(), "kobrixa-renew-"));
  const file = join(root, "sample.rbf");
  await writeFile(file, "test");
  fileDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
  const renderer = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const authority = new DeviceControlGate(new AuthorityContexts(id(1)));
  const original = authority.open(renderer as never);
  const report = {
    document: original.document,
    sequence: 1,
    state: "local",
    roomId: null,
    connected: true,
    synced: true,
    role: null,
    isHolder: true,
  };
  authority.set(renderer as never, report);
  const principal = () => authority.principal(renderer.id, "recovery");
  const operation: LegacyOperation = {
    operationId: id(9),
    execute: vi.fn(async () => ({
      value: { kind: "entries" as const, entries: [] },
      dispatch: "sent" as const,
      stopConfirmation: "not-required" as const,
      error: null,
    })),
    renewConfirmation: vi.fn(),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const legacy = createLegacyDevice({
    broker: {} as DeviceBrokerPort,
    principal,
    feed: {} as never,
    stop: async () => {},
    disconnect: async () => {},
  });
  const files = new LegacyFiles(
    { begin: async () => operation },
    () => ({ ...principal(), adapter: "remote-files" }) as ImportedCorePrincipal,
  );
  const devices = new DeviceService({} as never, () => renderer as never, undefined, {
    device: legacy,
    files,
  });
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    devices,
    {} as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    { authority, stop: async () => {}, disconnect: async () => {}, beforeClose: async () => {} },
  );
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args);
  const plan = await devices.prepareFiles(
    {
      sessionId: id(2),
      requestId: id(3),
      action: "upload",
      path: "/home/root/lms2012/prjs",
      paths: [],
      source: "files",
      locale: "en",
    },
    renderer as never,
  );
  expect(plan.phase).toBe("ready");
  vi.mocked(operation.renewConfirmation).mockClear();
  const ref = { sessionId: plan.sessionId, requestId: plan.requestId, planId: plan.planId };
  return {
    authority,
    renderer,
    event,
    report,
    operation,
    call,
    ref,
    devices,
    cleanup: async () => {
      await devices.stopFiles(ref, renderer.id).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
it("D150 renews a real retained file plan only for its original sender/ref at 119 seconds", async () => {
  const f = await renewalFixture();
  try {
    await vi.advanceTimersByTimeAsync(119000);
    for (const bad of [
      { ...f.ref, planId: id(90) },
      { ...f.ref, scope: {} },
      { ...f.ref, actionToken: id(80) },
    ])
      await expect(
        Promise.resolve().then(() => f.call("device:files-renew", bad)),
      ).rejects.toThrow();
    for (const event of [
      { ...f.event, sender: { id: 8 } },
      { ...f.event, senderFrame: {} },
    ])
      expect(() => handlers.get("device:files-renew")!(event, f.ref)).toThrow("untrusted");
    expect(f.operation.renewConfirmation).not.toHaveBeenCalled();
    await f.call("device:files-renew", f.ref);
    expect(f.operation.renewConfirmation).toHaveBeenCalledOnce();
  } finally {
    await f.cleanup();
  }
});
it.each(["replacement", "authority", "cancelled"])(
  "D150 %s cannot renew a retained plan",
  async (kind) => {
    const f = await renewalFixture();
    try {
      if (kind === "replacement") {
        f.authority.invalidate(f.renderer.id);
        f.authority.open(f.renderer as never);
      }
      if (kind === "authority")
        f.authority.set(f.renderer as never, {
          ...f.report,
          sequence: 2,
          state: "invalid",
          isHolder: false,
        });
      if (kind === "cancelled") await f.devices.stopFiles(f.ref, f.renderer.id);
      vi.mocked(f.operation.renewConfirmation).mockClear();
      await expect(
        Promise.resolve().then(() => f.call("device:files-renew", f.ref)),
      ).rejects.toThrow();
      expect(f.operation.renewConfirmation).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  },
);
it("D150 explicit 100/200/300/400/500 second renewals retain the original 600 second deadline", async () => {
  const f = await renewalFixture();
  try {
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(100000);
      await f.call("device:files-renew", f.ref);
    }
    expect(f.operation.renewConfirmation).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(100000);
    const exchanges = vi.mocked(f.operation.execute).mock.calls.length;
    await expect(
      Promise.resolve().then(() => f.call("device:files-renew", f.ref)),
    ).rejects.toThrow();
    expect(f.operation.renewConfirmation).toHaveBeenCalledTimes(5);
    expect(vi.mocked(f.operation.execute).mock.calls.length).toBe(exchanges);
    expect(f.operation.cancel).toHaveBeenCalledOnce();
  } finally {
    await f.cleanup();
  }
});

import { mkdir, realpath } from "node:fs/promises";
import {
  composeDesktopMain,
  desktopLifecycle,
  desktopDeviceAccess,
  type PluginController,
} from "./plugins/controller.js";
import { createDesktopFoundation } from "./device-broker/lifecycle-coordinator.js";
import { createJournal } from "./device-broker/journal.js";
import { createJournalFilesystem } from "./device-broker/journal-filesystem.js";
import {
  createFakeDeviceProvider,
  type FakeProviderControl,
} from "./device-broker/fake-provider.js";
import { BUILTIN_PLUGIN_SOURCES } from "./plugins/builtin.js";
import { registerPluginIpc } from "./plugins/ipc.js";
import type { ResourceOwner, RpcPeer } from "@kobrixa/plugin-protocol";
import { memoryPlugin } from "../../../../packages/plugin-runtime/src/test-process.js";

async function foundationIpc(legacyMetadata = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kobrixa-d150-ipc-")));
  const directory = join(root, "consumer");
  await mkdir(directory);
  await writeFile(join(directory, "index.cjs"), "");
  await writeFile(
    join(directory, "kobrixa-plugin.json"),
    JSON.stringify({
      id: "test.consumer",
      version: "1.0.0",
      apiVersion: "^1.5.0",
      displayName: "Consumer",
      runtime: { kind: "node", entry: "index.cjs" },
      permissions: ["devices.read", "devices.connect", "devices.control"],
      requires: {
        devices: [
          { capability: "connection.v1", required: true },
          { capability: "telemetry.v1", required: true },
          { capability: "finiteMotion.v1", required: true },
        ],
      },
      contributes: { commands: [{ id: "test.consumer.start", title: "Start" }] },
    }),
  );
  const renderer = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const contexts = new AuthorityContexts(id(1)),
    authority = new DeviceControlGate(contexts);
  const document = authority.open(renderer as never).document;
  const report = {
    document,
    sequence: 1,
    state: "local" as const,
    roomId: null,
    connected: true,
    synced: true,
    role: null,
    isHolder: true,
  };
  authority.set(renderer as never, report);
  const principal = contexts.core(renderer.id, "recovery");
  const scope = { hostEpoch: principal.hostEpoch, workbenchInstance: principal.workbenchInstance };
  let elapsed = 0;
  const installer = vi.fn();
  const update = new UpdateService({
    version: "1.0.0",
    platform: "win32",
    arch: "x64",
    preferences: { enabled: true, channel: "stable" },
    list: async () => [
      {
        tag_name: "v1.1.0",
        draft: false,
        prerelease: false,
        assets: [updateArtifactName("1.1.0", "win32", "x64"), updateMetadataName("win32")].map(
          (name) => ({ name, size: 20, state: "uploaded" }),
        ),
      },
    ],
    backend: { download: async () => {}, install: installer },
    persist: async () => {},
    publish: () => {},
    open: async () => {},
    busy: () => false,
  });
  const profile = { hostEpoch: id(1), assertHeld: vi.fn() },
    now = () => performance.now() + elapsed;
  const fs = createJournalFilesystem(root),
    journal = createJournal(fs, profile);
  const ledger = createCoreActionLedger({
    now,
    current: (value) => {
      try {
        return (
          contexts.core(renderer.id, "recovery").workbenchInstance === value.workbenchInstance &&
          value.hostEpoch === profile.hostEpoch
        );
      } catch {
        return false;
      }
    },
  });
  const controllerRef: { current?: PluginController } = {};
  let control!: FakeProviderControl, peer!: RpcPeer, owner!: ResourceOwner;
  let dropStartReply = false,
    droppedReplies = 0;
  const connectionBudgets: number[] = [];
  const catalogs: ProviderCatalogPort[] = [];
  const controls: FakeProviderControl[] = [];
  const shutdown = vi.fn(() => null),
    commands = vi.fn(() => null);
  const legacyFlush = vi.fn(async () => {});
  const composition = await composeDesktopMain({
    createFoundation: createDesktopFoundation,
    foundationOptions: {
      profile,
      authority: contexts,
      journal,
      coreActions: ledger,
      now,
      hasPermission: (candidate, permission) =>
        candidate.kind === "core"
          ? candidate.hostEpoch === scope.hostEpoch &&
            candidate.workbenchInstance === scope.workbenchInstance &&
            ["devices.read", "devices.connect", "devices.control"].includes(permission)
          : !!controllerRef.current &&
            desktopDeviceAccess(controllerRef.current).hasPermission(candidate.owner, permission),
      requirements: (candidate) =>
        controllerRef.current
          ? desktopDeviceAccess(controllerRef.current).requirements(candidate)
          : null,
      operationGate: ({ operationClass }) => {
        try {
          assertDeviceUpdateAdmission(update, operationClass);
          return { ok: true, value: null };
        } catch {
          return {
            ok: false,
            error: {
              code: "PLUGIN_E_DEVICE_BUSY",
              message: "update preparing",
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
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 3000,
        wifiHandshakeTimeoutMs: 1000,
        usbAutoReconnect: false,
        usbRetryInterval: 2000,
        usbRetryLimit: 3,
      }),
      providerFactory(catalog) {
        catalogs.push(catalog);
        expect(() =>
          catalog.identify({
            sessionId: id(99),
            portId: "1",
            typeId: "29",
            modeId: "0",
            component: 0,
            unit: "%",
          }),
        ).toThrow();
        const fake = createFakeDeviceProvider({ catalog, now });
        control = fake.control;
        controls.push(control);
        const connect = fake.provider.connect.bind(fake.provider);
        vi.spyOn(fake.provider, "connect").mockImplementation((target, ctx) =>
          connect(target, {
            ...ctx,
            exchange: (step, invoke) =>
              ctx.exchange(step, (signal, timeout) => {
                connectionBudgets.push(timeout);
                return invoke(signal, timeout);
              }),
          }),
        );
        if (legacyMetadata) {
          // Formal transport and barriers are unchanged; supply the EV3 metadata the
          // legacy Lab adapter expects, as in the T5 compatibility fixture.
          const sources = fake.provider.sources.bind(fake.provider);
          vi.spyOn(fake.provider, "sources").mockImplementation(async (...args) => {
            const value = await sources(...args);
            if (value.value)
              for (const channel of value.value.channels)
                Object.assign(channel, { portId: "input:0", typeId: "ev3:29", modeId: "mode:0" });
            return value;
          });
        }
        return fake.provider;
      },
    },
    plugins: {
      userData: root,
      builtins: BUILTIN_PLUGIN_SOURCES,
      commandLine: { developmentDirectories: [directory], safeMode: false },
      locale: "en",
      dialogs: {
        confirmDeveloperMode: async () => false,
        chooseFolder: async () => undefined,
        confirmLink: async () => false,
        confirmUnlink: async () => false,
        choosePython: async () => undefined,
      },
      launcher: () => async (plugin) => {
        owner = plugin.channelOwner!;
        const memory = memoryPlugin((remote, process) => {
          peer = remote;
          remote.handle("initialize", () => ({
            apiVersion: "1.5.0",
            sdk: { name: "test", version: "1" },
          }));
          remote.handle("command/execute", commands);
          remote.handle("shutdown", shutdown);
          remote.onNotification("exit", () => process.exit());
        });
        const send = memory.process.send.bind(memory.process);
        return {
          ...memory.process,
          send(text) {
            const message = JSON.parse(text);
            if (dropStartReply && message.result?.value?.operation) {
              dropStartReply = false;
              droppedReplies++;
              return;
            }
            send(text);
          },
        };
      },
    },
    principal: (candidate) => contexts.plugin(renderer.id, candidate),
    scope: () => scope,
    currentScope: (value) => value.workbenchInstance === scope.workbenchInstance,
    legacyFlush,
    report: vi.fn(),
  });
  const controller = composition.plugins;
  controllerRef.current = controller;
  expect(await controller.execute("test.consumer.start")).toMatchObject({ ok: true });
  expect((await peer.request("devices/negotiate", {})).ok).toBe(true);
  const connected = await peer.request("devices/connect", {
    target: { kind: "wifi-address", providerId: "kobrixa.device-ev3", address: "127.0.0.1" },
  });
  if (!connected.ok) throw new Error(connected.error.message);
  const sessionId = connected.value.session.sessionId;
  const broker = composition.foundation.broker,
    coordinator = desktopLifecycle(composition);
  for (const adapter of ["recovery", "remote-files", "monitor", "battery", "lab"] as const)
    await broker.request(
      { ...principal, adapter },
      "devices/list",
      {},
      new AbortController().signal,
    );
  const callbacks = trustedDeviceActions(broker, coordinator, ledger);
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    update,
    new UpdateOperationGate(() => update),
    undefined,
    undefined,
    undefined,
    [
      (handle) => {
        registerPluginIpc(handle, controller!, () => {});
      },
    ],
    () => coordinator.close("update"),
    controller,
    {
      authority,
      stop: callbacks.trustedCoreStop,
      disconnect: callbacks.trustedCoreDisconnect,
      beforeClose: () => coordinator.close("close"),
    },
  );
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  return {
    composition,
    controller,
    broker,
    coordinator,
    control,
    peer,
    owner,
    principal,
    scope,
    providerGeneration: connected.value.session.providerGeneration,
    ledger,
    journal,
    fs,
    legacyFlush,
    shutdown,
    commands,
    authority,
    report,
    renderer,
    event,
    sessionId,
    root,
    update,
    installer,
    connectionBudgets,
    catalogs,
    controls,
    advance: (ms: number) => {
      elapsed += ms;
    },
    dropStartResponse: () => {
      dropStartReply = true;
    },
    droppedReplies: () => droppedReplies,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args),
    async cleanup(blocked = false) {
      try {
        if (blocked) {
          await expect(composition.dispose()).rejects.toThrow("disposition");
          expect(shutdown).not.toHaveBeenCalled();
          await controller.shutdown(); // Dispose the in-memory test process only.
          coordinator.dispose();
        } else await composition.dispose();
      } finally {
        update.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
it("D150 real IPC stops an external program through device-current-stop and rejects replay", async () => {
  const f = await foundationIpc();
  try {
    expect(f.journal.snapshot().faults).toEqual([]);
    const mint = vi.spyOn(f.ledger, "mint");
    f.control.block("before-stop-readback", "stop");
    const stopped = f.call("device:stop", f.sessionId);
    await f.control.reached("before-stop-readback", "stop");
    expect(mint.mock.calls[0]![1]).toEqual({ kind: "device-current-stop", sessionId: f.sessionId });
    expect(f.journal.snapshot().faults).toMatchObject([
      { operationClass: "safety-stop", state: "pending" },
    ]);
    f.control.release("before-stop-readback", "stop");
    await stopped;
    expect(f.journal.snapshot().blockers).toEqual([]);
    expect(f.journal.snapshot().faults).toMatchObject([
      { state: "resolved", stopConfirmation: "confirmed" },
    ]);
    const before = f.control.trace().length;
    expect(
      (
        await f.broker.stopCurrentDevice({
          sessionId: f.sessionId,
          action: mint.mock.results[0]!.value,
        })
      ).ok,
    ).toBe(false);
    expect(f.control.trace()).toHaveLength(before);
  } finally {
    await f.cleanup();
  }
});
it("D150 initial journal failure prevents actual stop dispatch", async () => {
  const f = await foundationIpc();
  const sync = vi.spyOn(f.fs, "sync").mockRejectedValueOnce(new Error("disk failure"));
  try {
    await expect(f.call("device:stop", f.sessionId)).rejects.toThrow();
    expect(f.control.trace().some((row) => row.step === "stop")).toBe(false);
    expect(f.journal.snapshot().journalHealth).not.toBe("ready");
  } finally {
    sync.mockRestore();
    await f.cleanup(true);
  }
});
it("D150 final journal failure retains real stop evidence and rejects replay", async () => {
  const f = await foundationIpc();
  try {
    f.control.block("after-exchange", "readback");
    const work = f.call("device:stop", f.sessionId);
    const rejected = expect(work).rejects.toThrow();
    await f.control.reached("after-exchange", "readback");
    const sync = vi.spyOn(f.fs, "sync").mockRejectedValueOnce(new Error("final sync failed"));
    f.control.release("after-exchange", "readback");
    await rejected;
    sync.mockRestore();
    expect(f.journal.snapshot().blockers).toHaveLength(1);
    expect(f.journal.snapshot().faults[0]!.stopConfirmation).not.toBe("confirmed");
    await expect(f.call("device:disconnect", f.sessionId)).rejects.toThrow("disposition");
    expect(f.control.trace().some((row) => row.step === "disconnect")).toBe(false);
    expect(await f.fs.read("faults.json")).not.toBeNull();
  } finally {
    await f.cleanup(true);
  }
});
it("D150 legacy save failure blocks physical Disconnect; a new click claims a new token and retries", async () => {
  const f = await foundationIpc();
  try {
    const mint = vi.spyOn(f.ledger, "mint");
    f.legacyFlush.mockRejectedValueOnce(new Error("Lab save failed"));
    await expect(f.call("device:disconnect", f.sessionId)).rejects.toThrow("Lab save failed");
    expect(f.control.trace().some((row) => row.step === "disconnect")).toBe(false);
    expect(f.shutdown).not.toHaveBeenCalled();
    await f.call("device:disconnect", f.sessionId);
    expect(
      f.control.trace().filter((row) => row.step === "disconnect" && row.dispatch === "sent"),
    ).toHaveLength(1);
    expect(mint.mock.results[0]!.value.actionToken).not.toBe(
      mint.mock.results[1]!.value.actionToken,
    );
    expect(f.shutdown).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
it("D150 real plugin IPC refuses foreign/subframe senders and forged policy fields", async () => {
  const f = await foundationIpc();
  try {
    for (const event of [
      { ...f.event, sender: { id: 8 } },
      { ...f.event, senderFrame: {} },
    ])
      expect(() =>
        handlers.get("plugins:set-enabled")!(event, "builtin:kobrixa.device-ev3", false),
      ).toThrow("untrusted");
    for (const policy of [
      { enabled: false, required: false },
      { enabled: false, safeMode: false },
      { enabled: false, developerMode: true },
    ])
      await expect(
        Promise.resolve().then(() =>
          f.call("plugins:set-enabled", "builtin:kobrixa.device-ev3", policy),
        ),
      ).rejects.toThrow();
    expect(
      f.controller.state().plugins.find((row) => row.sourceKey === "builtin:kobrixa.device-ev3")
        ?.status,
    ).toBe("enabled");
    expect(await f.call("plugins:set-enabled", "builtin:kobrixa.basic-plus", false)).toMatchObject({
      ok: false,
    });
  } finally {
    await f.cleanup();
  }
});
async function prepareMotion(f: Awaited<ReturnType<typeof foundationIpc>>) {
  const contextRef = f.principal.authorityContext!.ref;
  const motionScopeRef = f.broker.intent.bindMotionScope({
    owner: f.owner,
    contextRef,
    panelInstance: id(81),
    uiResourceGeneration: 1,
    workbenchInstance: f.scope.workbenchInstance,
  });
  f.broker.intent.pulsePanel(motionScopeRef, 1);
  const result = await f.peer.request("devices/motion/prepare", {
    sessionId: f.sessionId,
    contextRef,
    motionScopeRef,
    motion: {
      mode: "timed",
      actuatorId: id(2),
      power: 10,
      direction: 1,
      brake: true,
      durationMs: 100,
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.operation.operationId;
}
it("D150 stop/readback and durable final journal precede physical Disconnect and manager shutdown", async () => {
  const f = await foundationIpc();
  try {
    const operationId = await prepareMotion(f);
    f.control.block("after-exchange", "motion-pulse");
    expect((await f.peer.request("devices/motion/start", { operationId })).ok).toBe(true);
    await f.control.reached("after-exchange", "motion-pulse");
    f.control.block("before-stop-readback", "stop");
    const disconnected = f.call("device:disconnect", f.sessionId);
    await f.control.reached("before-stop-readback", "stop");
    expect(f.control.trace().some((row) => row.step === "disconnect")).toBe(false);
    f.control.release("after-exchange", "motion-pulse");
    const synced = deferredIpc<void>(),
      allowSync = deferredIpc<void>();
    const original = f.fs.syncDirectory.bind(f.fs);
    const sync = vi.spyOn(f.fs, "syncDirectory").mockImplementation(async () => {
      synced.resolve();
      await allowSync.promise;
      await original();
    });
    f.control.release("before-stop-readback", "stop");
    await synced.promise;
    expect(
      f.control.trace().some((row) => row.step === "readback" && row.dispatch === "sent"),
    ).toBe(true);
    expect(f.control.trace().some((row) => row.step === "disconnect")).toBe(false);
    expect(f.shutdown).not.toHaveBeenCalled();
    allowSync.resolve();
    await disconnected;
    sync.mockRestore();
    expect(f.journal.snapshot().blockers).toEqual([]);
    const sent = f.control
      .trace()
      .filter((row) => row.dispatch === "sent")
      .map((row) => row.step);
    expect(sent.indexOf("readback")).toBeLessThan(sent.indexOf("disconnect"));
    expect(f.shutdown).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
function deferredIpc<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("D150 authority revocation beats late motion ACK; retained query never replays start", async () => {
  const f = await foundationIpc();
  try {
    const operationId = await prepareMotion(f);
    f.control.block("after-exchange", "motion-pulse");
    // Lose only the serialized start response while retaining the original live channel.
    f.dropStartResponse();
    const lost = new AbortController();
    const start = f.peer.request("devices/motion/start", { operationId }, { signal: lost.signal });
    const cancelled = expect(start).rejects.toThrow();
    await f.control.reached("after-exchange", "motion-pulse");
    expect(f.droppedReplies()).toBe(1);
    lost.abort();
    await cancelled;
    f.control.block("before-stop-readback", "stop");
    f.authority.set(f.renderer as never, {
      ...f.report,
      sequence: 2,
      state: "invalid",
      isHolder: false,
    });
    await f.control.reached("before-stop-readback", "stop");
    const settled = f.coordinator.suspend(f.sessionId);
    f.control.release("after-exchange", "motion-pulse");
    f.control.release("before-stop-readback", "stop");
    await settled;
    const result = await f.peer.request("devices/motion/query", { operationId });
    expect(result).toMatchObject({
      ok: true,
      value: { operation: { stopConfirmation: "confirmed", stage: "terminal" } },
    });
    expect(
      f.control.trace().filter((row) => row.step === "motion-pulse" && row.dispatch === "sent"),
    ).toHaveLength(1);
    expect(f.journal.snapshot().blockers).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
it("D150 readback deadline keeps the original pending journal blocker", async () => {
  const f = await foundationIpc();
  try {
    f.control.block("before-exchange", "readback");
    const rejected = expect(f.call("device:stop", f.sessionId)).rejects.toThrow();
    await f.control.reached("before-exchange", "readback");
    f.advance(15_001);
    f.control.release("before-exchange", "readback");
    await rejected;
    expect(f.journal.snapshot().blockers).toHaveLength(1);
    expect(
      f.control.trace().some((row) => row.step === "readback" && row.dispatch === "sent"),
    ).toBe(false);
  } finally {
    await f.cleanup(true);
  }
});
it("D150 successfully completed formal-provider transfer cannot renew or perform more I/O", async () => {
  const f = await foundationIpc();
  try {
    const file = join(f.root, "sample.rbf");
    await writeFile(file, "test");
    fileDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    const legacy = createLegacyDevice({
      broker: f.broker,
      principal: () => f.principal,
      feed: {} as never,
      stop: async () => {},
      disconnect: async () => {},
    });
    const files = new LegacyFiles(f.broker, () => ({ ...f.principal, adapter: "remote-files" }));
    const devices = new DeviceService({} as never, () => f.renderer as never, undefined, {
      device: legacy,
      files,
    });
    const plan = await devices.prepareFiles(
      {
        sessionId: f.sessionId,
        requestId: id(90),
        action: "upload",
        path: "/home/root/lms2012/prjs",
        paths: [],
        source: "files",
        locale: "en",
      },
      f.renderer as never,
    );
    const ref = { sessionId: f.sessionId, requestId: plan.requestId, planId: plan.planId };
    const result = await devices.executeFiles(ref, "replace", f.renderer.id);
    expect(result.phase).toBe("complete");
    expect(result.items.every((item) => item.status === "succeeded")).toBe(true);
    expect(
      f.control.trace().some((row) => row.step === "file-close" && row.dispatch === "sent"),
    ).toBe(true);
    const before = f.control.trace().length;
    await expect(
      Promise.resolve().then(() =>
        devices.renewFilePlan(ref, { ...f.principal, adapter: "remote-files" }),
      ),
    ).rejects.toThrow();
    expect(f.control.trace()).toHaveLength(before);
  } finally {
    await f.cleanup();
  }
});
it("D150 update denies the next held-transfer continuation, retains close and direct safety with four pending public calls", async () => {
  const f = await foundationIpc();
  try {
    const operation = await f.broker.begin({
      principal: f.principal,
      sessionId: f.sessionId,
      operationClass: "file-write",
      signal: new AbortController().signal,
    });
    f.control.block("after-exchange", "file-chunk");
    const transfer = operation.execute({
      kind: "upload",
      remotePath: "/test",
      size: 2,
      chunks: (async function* () {
        yield new Uint8Array([1]);
        yield new Uint8Array([2]);
      })(),
      progress() {},
    });
    const failedTransfer = expect(transfer).rejects.toThrow();
    await f.control.reached("after-exchange", "file-chunk");
    f.control.block("before-exchange", "discover");
    const requests = vi.spyOn(f.broker, "request");
    let replies = 0;
    const publicCalls = Array.from({ length: 4 }, () =>
      f.peer.request("devices/discover", { providerId: "kobrixa.device-ev3" }).then((value) => {
        replies++;
        return value;
      }),
    );
    await f.control.reached("before-exchange", "discover");
    expect(requests.mock.calls.filter((row) => row[1] === "devices/discover")).toHaveLength(4);
    expect(replies).toBe(0);
    await f.call("updates:check");
    await f.call("updates:prepare");
    expect(f.update.preparing).toBe(true);
    expect(f.installer).not.toHaveBeenCalled();
    f.control.release("after-exchange", "file-chunk");
    await failedTransfer;
    await operation.finish();
    expect(
      f.control.trace().filter((row) => row.step === "file-chunk" && row.dispatch === "sent"),
    ).toHaveLength(1);
    expect(
      f.control.trace().filter((row) => row.step === "file-close" && row.dispatch === "sent"),
    ).toHaveLength(1);
    // Core safety bypasses the still-held public request lane and ordinary update gate.
    await f.call("device:stop", f.sessionId);
    expect(
      f.control.trace().some((row) => row.step === "readback" && row.dispatch === "sent"),
    ).toBe(true);
    expect(f.shutdown).not.toHaveBeenCalled();
    f.control.release("before-exchange", "discover");
    expect(replies).toBe(0);
    const results = await Promise.all(publicCalls);
    expect(results.every((result) => !result.ok)).toBe(true);
    f.installer.mockImplementation(() => {
      expect(f.shutdown).toHaveBeenCalledOnce();
    });
    await f.call("updates:install");
    expect(f.installer).toHaveBeenCalledOnce();
  } finally {
    await f.cleanup();
  }
});
import { MonitorService } from "./device/monitor-service.js";
it("D150 battery/monitor/Lab share one sampler; slow or throwing consumers and window loss cannot retain demand", async () => {
  const f = await foundationIpc();
  const feed = createLegacyMonitorFeed(f.broker);
  const core = (adapter: ImportedCorePrincipal["adapter"]): ImportedCorePrincipal => ({
    ...f.principal,
    adapter,
  });
  const legacy = createLegacyDevice({
    broker: f.broker,
    principal: () => core("monitor"),
    feed,
    stop: async () => {},
    disconnect: async () => {},
  });
  const monitor = new MonitorService(legacy, vi.fn());
  const remove: Array<() => Promise<void>> = [];
  try {
    const session = await f.peer.request("devices/session", { sessionId: f.sessionId });
    if (!session.ok) throw new Error("session");
    const channelIds = session.value.sources.channels.map((channel) => channel.channelId);
    const read = () =>
      f.peer.request("devices/read", { sessionId: f.sessionId, channelIds, freshness: "fresh" });
    await read();
    const battery = vi.fn(),
      lab = vi.fn(),
      closed = vi.fn();
    remove.push(
      await feed.subscribe({
        principal: core("battery"),
        sessionId: f.sessionId,
        intervalMs: 30000,
        receive: battery,
      }),
    );
    remove.push(
      await feed.subscribe({
        principal: core("lab"),
        sessionId: f.sessionId,
        intervalMs: 500,
        receive: lab,
        onClosed: closed,
      }),
    );
    expect(battery).toHaveBeenCalledOnce();
    expect(lab).toHaveBeenCalledOnce();
    expect(battery.mock.calls[0]![0]).toMatchObject({
      status: "fresh",
      frame: { values: [{ value: 42 }] },
    });
    await monitor.watch(f.sessionId, true, 7);
    let throwing = false;
    const failedConsumer = vi.fn();
    remove.push(
      await feed.subscribe({
        principal: core("monitor"),
        sessionId: f.sessionId,
        intervalMs: 500,
        receive: () => {
          if (throwing) throw new Error("consumer");
        },
        onClosed: failedConsumer,
      }),
    );
    const slow = vi.fn();
    const slowDemand = await f.broker.subscribeCoreTelemetry({
      principal: core("battery"),
      sessionId: f.sessionId,
      channelIds,
      intervalMs: 30000,
      receive: slow,
    });
    slowDemand.activate();
    remove.push(() => slowDemand.dispose());
    const before = f.control
      .trace()
      .filter((row) => row.step === "read" && row.dispatch === "sent").length;
    f.control.block("before-exchange", "read");
    const one = read(),
      two = read();
    await f.control.reached("before-exchange", "read");
    throwing = true;
    f.control.release("before-exchange", "read");
    await Promise.all([one, two]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      f.control.trace().filter((row) => row.step === "read" && row.dispatch === "sent").length,
    ).toBe(before + 1);
    expect(failedConsumer).toHaveBeenCalledExactlyOnceWith("consumer-error");
    expect(slow).toHaveBeenCalled();
    await slowDemand.dispose();
    slowDemand.ack(slow.mock.calls[0]![0].sequence); // A late ACK cannot revive a retired subscription.
    await monitor.watch(f.sessionId, false, 7);
    const previousLab = lab.mock.calls.length;
    await read();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lab.mock.calls.length).toBeGreaterThan(previousLab);
    const work = f.coordinator.suspend(f.sessionId);
    await work;
    f.authority.invalidate(f.renderer.id);
    await monitor.pause();
    await Promise.all(remove.map((dispose) => dispose()));
    const after = f.control.trace().length;
    await f.coordinator.resume(f.sessionId);
    expect(f.control.trace()).toHaveLength(after);
    expect(f.commands).toHaveBeenCalledOnce();
  } finally {
    await monitor.dispose();
    await Promise.all(remove.map((dispose) => dispose()));
    await f.cleanup();
  }
});
import { LegacyLab } from "./device-broker/legacy-lab.js";
it("D150 actual legacy Lab recording overlaps monitor and battery; release preserves the healthy channel", async () => {
  const f = await foundationIpc(true);
  const feed = createLegacyMonitorFeed(f.broker);
  const device = createLegacyDevice({
    broker: f.broker,
    principal: () => ({ ...f.principal, adapter: "lab" }),
    feed,
    stop: async () => {},
    disconnect: async () => {},
  });
  const lab = new LegacyLab(device, vi.fn()),
    monitor = new MonitorService(device, vi.fn());
  let battery: (() => Promise<void>) | undefined;
  try {
    await monitor.watch(f.sessionId, true, 7);
    const batteryFrames = vi.fn();
    battery = await feed.subscribe({
      principal: { ...f.principal, adapter: "battery" },
      sessionId: f.sessionId,
      intervalMs: 30000,
      receive: batteryFrames,
    });
    await lab.acquire(f.sessionId, [
      {
        id: "light",
        kind: "input",
        port: 0,
        type: 29,
        mode: 0,
        channel: 0,
        name: "Light",
        modeName: "Reflect",
        unit: "%",
        decimals: 0,
      },
    ]);
    expect(lab.latest(f.sessionId)?.status).toBe("live");
    expect(lab.latest(f.sessionId)?.snapshot?.inputs[0]?.values).toEqual([42]);
    const before = batteryFrames.mock.calls.length;
    await lab.release(f.sessionId);
    const session = await f.peer.request("devices/session", { sessionId: f.sessionId });
    if (!session.ok) throw new Error("session");
    expect(session.value.session.recording).toBe(false);
    await f.peer.request("devices/read", {
      sessionId: f.sessionId,
      channelIds: session.value.sources.channels.map((channel) => channel.channelId),
      freshness: "fresh",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(batteryFrames.mock.calls.length).toBeGreaterThan(before);
    expect(monitor.latest(f.sessionId)?.status).toBe("live");
    expect(desktopDeviceAccess(f.controller).requirements(f.owner)).not.toBeNull();
    expect(f.shutdown).not.toHaveBeenCalled();
    expect(f.commands).toHaveBeenCalledOnce();
  } finally {
    await lab.release(f.sessionId);
    await monitor.dispose();
    await battery?.();
    await f.cleanup();
  }
});
it("D150 non-default connect policy clamps the real exchange to the remaining four-second attempt", async () => {
  const f = await foundationIpc();
  try {
    expect(f.connectionBudgets).toHaveLength(1);
    expect(f.connectionBudgets[0]).toBeGreaterThan(0);
    expect(f.connectionBudgets[0]).toBeLessThanOrEqual(4000);
  } finally {
    await f.cleanup();
  }
});
it.each(["wrong-scope", "wrong-target", "expired", "retired"] as const)(
  "D150 real current-stop rejects %s before provider I/O",
  async (kind) => {
    const f = await foundationIpc();
    try {
      const action = f.ledger.mint(f.scope, {
        kind: "device-current-stop",
        sessionId: f.sessionId,
      });
      const candidate =
        kind === "wrong-scope"
          ? { ...action, scope: { ...f.scope, workbenchInstance: id(80) } }
          : action;
      if (kind === "expired") f.advance(5000);
      if (kind === "retired") f.ledger.retire(f.scope);
      const before = f.control.trace().length;
      expect(
        await f.broker.stopCurrentDevice({
          sessionId: kind === "wrong-target" ? id(80) : f.sessionId,
          action: candidate,
        }),
      ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED" } });
      expect(f.control.trace()).toHaveLength(before);
      expect(f.journal.snapshot().faults).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
);
it("D150 same claimed Disconnect action remains valid during cleanup beyond its five-second mint window", async () => {
  const f = await foundationIpc();
  try {
    const operationId = await prepareMotion(f);
    f.control.block("after-exchange", "motion-pulse");
    await f.peer.request("devices/motion/start", { operationId });
    await f.control.reached("after-exchange", "motion-pulse");
    f.control.block("before-stop-readback", "stop");
    const disconnected = f.call("device:disconnect", f.sessionId);
    await f.control.reached("before-stop-readback", "stop");
    f.advance(6000);
    f.control.release("after-exchange", "motion-pulse");
    f.control.release("before-stop-readback", "stop");
    await disconnected;
    expect(
      f.control.trace().filter((row) => row.step === "disconnect" && row.dispatch === "sent"),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
it("D150 window invalidation ends core telemetry demand while a late ACK cannot revive it", async () => {
  const f = await foundationIpc();
  const feed = createLegacyMonitorFeed(f.broker);
  const closed = vi.fn();
  let dispose: (() => Promise<void>) | undefined;
  try {
    const session = await f.peer.request("devices/session", { sessionId: f.sessionId });
    if (!session.ok) throw new Error("session");
    const channelIds = session.value.sources.channels.map((channel) => channel.channelId);
    const values = vi.fn();
    dispose = await feed.subscribe({
      principal: { ...f.principal, adapter: "lab" },
      sessionId: f.sessionId,
      intervalMs: 500,
      receive: values,
      onClosed: closed,
    });
    f.control.block("before-exchange", "read");
    const pending = f.peer.request("devices/read", {
      sessionId: f.sessionId,
      channelIds,
      freshness: "fresh",
    });
    await f.control.reached("before-exchange", "read");
    f.authority.invalidate(f.renderer.id);
    f.control.release("before-exchange", "read");
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toHaveBeenCalledExactlyOnceWith("broker-ended");
    const count = values.mock.calls.length;
    await dispose();
    await dispose();
    expect(values).toHaveBeenCalledTimes(count);
  } finally {
    await dispose?.();
    await f.cleanup();
  }
});

import { updateArtifactName, updateMetadataName } from "../shared/updates.js";
it("D150 Disconnect also waits for a concurrent current-stop's final journal publication", async () => {
  const f = await foundationIpc();
  try {
    f.control.block("after-exchange", "readback");
    const stop = f.call("device:stop", f.sessionId);
    await f.control.reached("after-exchange", "readback");
    const synced = deferredIpc<void>(),
      allowSync = deferredIpc<void>();
    const original = f.fs.syncDirectory.bind(f.fs);
    const sync = vi.spyOn(f.fs, "syncDirectory").mockImplementation(async () => {
      synced.resolve();
      await allowSync.promise;
      await original();
    });
    const physical = vi.spyOn(f.broker.sessions, "disconnect");
    const disconnect = Promise.resolve(f.call("device:disconnect", f.sessionId));
    void disconnect.catch(() => {});
    f.control.release("after-exchange", "readback");
    await synced.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Release even on assertion failure, so the regression never hangs test teardown.
    try {
      expect(physical).not.toHaveBeenCalled();
    } finally {
      allowSync.resolve();
      await Promise.all([stop, disconnect]);
      sync.mockRestore();
    }
    expect(f.journal.snapshot().blockers).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it.each(["shutdown", "disconnect", "provider"] as const)(
  "D150 later recovery after blocked Disconnect keeps %s pending through its final journal",
  async (teardown) => {
    const f = await foundationIpc();
    const quiesce = vi.spyOn(f.broker.sessions, "quiesce");
    const physical = vi.spyOn(f.broker.sessions, "disconnect");
    const synced = deferredIpc<void>(),
      allowSync = deferredIpc<void>();
    let stop: Promise<unknown> | undefined, pending: Promise<unknown> | undefined;
    let releaseReadback = false;
    let restoreSync = () => {};
    try {
      f.legacyFlush.mockRejectedValueOnce(new Error("Lab save failed"));
      await expect(f.call("device:disconnect", f.sessionId)).rejects.toThrow("Lab save failed");
      const first = quiesce.mock.results[0]!.value;
      await expect(first.settled).resolves.toMatchObject({
        stopConfirmed: true,
        journalCommitted: true,
      });
      f.control.block("after-exchange", "readback");
      releaseReadback = true;
      stop = Promise.resolve(f.call("device:stop", f.sessionId));
      await f.control.reached("after-exchange", "readback");
      const original = f.fs.syncDirectory.bind(f.fs);
      const sync = vi.spyOn(f.fs, "syncDirectory").mockImplementation(async () => {
        synced.resolve();
        await allowSync.promise;
        await original();
      });
      restoreSync = () => sync.mockRestore();
      let settled = false;
      pending = Promise.resolve(
        teardown === "shutdown"
          ? f.composition.dispose()
          : teardown === "provider"
            ? f.broker.resources.retireProvider("kobrixa.device-ev3", f.providerGeneration)
            : f.call("device:disconnect", f.sessionId),
      ).finally(() => {
        settled = true;
      });
      void pending.catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.shutdown).not.toHaveBeenCalled();
      f.control.release("after-exchange", "readback");
      releaseReadback = false;
      await synced.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(physical).not.toHaveBeenCalled();
      expect(f.shutdown).not.toHaveBeenCalled();
      expect(f.journal.snapshot().blockers).toHaveLength(1);
      if (teardown === "disconnect") expect(quiesce.mock.results[1]!.value).toBe(first);
      allowSync.resolve();
      await stop;
      await pending;
      expect(f.journal.snapshot().blockers).toEqual([]);
      expect(
        f.control.trace().filter((row) => row.step === "stop" && row.dispatch === "sent"),
      ).toHaveLength(1);
      if (teardown === "shutdown") expect(f.shutdown).toHaveBeenCalledOnce();
      else if (teardown === "disconnect") expect(physical).toHaveBeenCalledOnce();
      else
        await expect(pending).resolves.toMatchObject({
          stopConfirmed: true,
          journalCommitted: true,
        });
    } finally {
      if (releaseReadback) f.control.release("after-exchange", "readback");
      allowSync.resolve();
      await Promise.allSettled([stop, pending]);
      restoreSync();
      await f.cleanup();
    }
  },
);
it("D150 later failed recovery after blocked Disconnect prevents actual composition disposal", async () => {
  const f = await foundationIpc();
  let blocked = false;
  try {
    f.legacyFlush.mockRejectedValueOnce(new Error("Lab save failed"));
    await expect(f.call("device:disconnect", f.sessionId)).rejects.toThrow("Lab save failed");
    f.control.block("after-exchange", "readback");
    const stop = expect(f.call("device:stop", f.sessionId)).rejects.toThrow();
    await f.control.reached("after-exchange", "readback");
    const sync = vi.spyOn(f.fs, "sync").mockRejectedValueOnce(new Error("final sync failed"));
    f.control.release("after-exchange", "readback");
    await stop;
    sync.mockRestore();
    expect(f.journal.snapshot().journalHealth).toBe("unwritable");
    expect(f.journal.snapshot().blockers).toHaveLength(1);
    const outcome = await f.composition.dispose().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    blocked = !outcome.ok;
    expect(outcome.ok).toBe(false);
    expect(f.shutdown).not.toHaveBeenCalled();
    await expect(
      f.broker.resources.retireProvider("kobrixa.device-ev3", f.providerGeneration),
    ).resolves.toMatchObject({
      stopConfirmed: false,
      journalCommitted: false,
      faultIds: f.journal.snapshot().blockers,
    });
    await expect(f.call("device:disconnect", f.sessionId)).rejects.toThrow("disposition");
    expect(f.control.trace().some((row) => row.step === "disconnect")).toBe(false);
    expect(await f.fs.read("faults.json")).not.toBeNull();
  } finally {
    await f.cleanup(blocked);
  }
});
it("D150 a clean teardown receipt fences new recovery while legacy saving is pending", async () => {
  const f = await foundationIpc();
  const saving = deferredIpc<void>();
  let dispose: Promise<void> | undefined;
  try {
    f.legacyFlush.mockImplementationOnce(() => saving.promise);
    const shutdown = vi.spyOn(f.broker.resources, "beginShutdown");
    dispose = f.composition.dispose();
    await expect(shutdown.mock.results[0]!.value).resolves.toMatchObject({
      stopConfirmed: true,
      journalCommitted: true,
    });
    expect(f.shutdown).not.toHaveBeenCalled();
    const before = f.control.trace().length;
    await expect(f.call("device:stop", f.sessionId)).rejects.toThrow();
    expect(f.control.trace()).toHaveLength(before);
    expect(f.journal.snapshot().faults).toEqual([]);
    saving.resolve();
    await dispose;
    expect(f.shutdown).toHaveBeenCalledOnce();
  } finally {
    saving.resolve();
    await dispose;
    await f.cleanup();
  }
});

import type { ProviderCatalogPort } from "./device-broker/provider.js";
it("D150 catalog rejects foreign sessions and invalidates its allocator on real optional-provider reload", async () => {
  const f = await foundationIpc();
  try {
    const catalog = f.catalogs[0]!;
    const tuple = {
      sessionId: f.sessionId,
      portId: "1",
      typeId: "29",
      modeId: "0",
      component: 0,
      unit: "%",
    };
    expect(catalog.identify(tuple)).toBe(catalog.identify(tuple));
    expect(() => catalog.identify({ ...tuple, sessionId: id(99) })).toThrow();
    expect(await f.controller.reload("builtin:kobrixa.device-ev3")).toMatchObject({ ok: true });
    expect(f.catalogs).toHaveLength(2);
    expect(f.catalogs[1]).not.toBe(catalog);
    expect(() => catalog.identify(tuple)).toThrow();
    expect(f.controls[1]!.trace()).toEqual([]); // Replacement does not reconnect or replay.
    expect(f.commands).toHaveBeenCalledOnce();
  } finally {
    await f.cleanup();
  }
});

import { WorkbenchLifecycle } from "./window/workbench-lifecycle.js";
import { UpdateInstallation } from "./updates/installation.js";
import { desktopUi } from "./plugins/controller.js";
it.each(["window", "update"] as const)(
  "real composition %s retirement preserves the host for safe lazy readmission",
  async (reason) => {
    const f = await foundationIpc();
    const ui = desktopUi(f.composition);
    const shutdown = vi.spyOn(f.broker.resources, "beginShutdown");
    const workbench = new WorkbenchLifecycle({
      sessions: () => [f.sessionId],
      suspend: (id) => f.coordinator.suspend(id),
      verify: (id) => f.coordinator.confirmSuspended(id),
      retire: (mode) => (mode === "update" ? ui.prepareUpdate() : ui.prepareWindowClose()),
      resume: (id) => f.coordinator.resume(id),
      readmit: () => f.controller.resume(),
    });
    try {
      const operationId = await prepareMotion(f);
      f.control.block("after-exchange", "motion-pulse");
      expect((await f.peer.request("devices/motion/start", { operationId })).ok).toBe(true);
      await f.control.reached("after-exchange", "motion-pulse");
      const closing = workbench.close(reason);
      f.control.release("after-exchange", "motion-pulse");
      await closing;
      expect(f.shutdown).toHaveBeenCalledOnce();
      expect(shutdown).not.toHaveBeenCalled();
      expect(f.controller.acceptingUi).toBe(false);
      expect(f.journal.snapshot().blockers).toEqual([]);
      expect(
        f.control.trace().some((row) => row.step === "readback" && row.dispatch === "sent"),
      ).toBe(true);
      const commands = f.commands.mock.calls.length;
      await workbench.reopen();
      expect(f.controller.acceptingUi).toBe(true);
      expect(f.commands).toHaveBeenCalledTimes(commands);
      expect(
        await f.broker.request(f.principal, "devices/list", {}, new AbortController().signal),
      ).toMatchObject({
        ok: true,
        value: { sessions: [{ sessionId: f.sessionId, state: "connected" }] },
      });
      expect(await f.controller.execute("test.consumer.start")).toMatchObject({ ok: true });
      expect(f.commands).toHaveBeenCalledTimes(commands + 1);
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  },
);
it("real update backend failure can readmit after stop/save/process exit without reviving old consumers", async () => {
  const f = await foundationIpc();
  const ui = desktopUi(f.composition);
  const shutdown = vi.spyOn(f.broker.resources, "beginShutdown");
  const workbench = new WorkbenchLifecycle({
    sessions: () => [f.sessionId],
    suspend: (id) => f.coordinator.suspend(id),
    verify: (id) => f.coordinator.confirmSuspended(id),
    retire: () => ui.prepareUpdate(),
    resume: (id) => f.coordinator.resume(id),
    readmit: () => f.controller.resume(),
  });
  const installation = new UpdateInstallation(
    f.update,
    () => ui.prepareUpdate(),
    () => workbench.close("update"),
    async () => {
      await workbench.reopen();
      await f.controller.resume();
    },
  );
  const off = f.update.onInstallationFailed(() => {
    void installation.failed();
  });
  try {
    await f.update.check();
    await installation.prepare();
    f.installer.mockImplementationOnce(() => {
      expect(f.shutdown).toHaveBeenCalledOnce();
      expect(f.journal.snapshot().blockers).toEqual([]);
      throw new Error("installer failed");
    });
    await expect(installation.install()).rejects.toThrow("installer failed");
    await installation.failed();
    expect(shutdown).not.toHaveBeenCalled();
    expect(f.controller.acceptingUi).toBe(true);
    expect(f.commands).toHaveBeenCalledOnce();
    expect(await f.controller.execute("test.consumer.start")).toMatchObject({ ok: true });
  } finally {
    off();
    await f.cleanup();
  }
});
