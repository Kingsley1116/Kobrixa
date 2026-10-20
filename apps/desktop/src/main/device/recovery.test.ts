import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Principal } from "@kobrixa/plugin-runtime";
import type {
  DeviceBrokerPort,
  LegacyOperation,
  LegacyOperationPort,
} from "../device-broker/broker-port.js";
import { LegacyDevice } from "../device-broker/legacy-device.js";
import { LegacyFiles } from "../device-broker/legacy-files.js";
import { DeviceService } from "./device.js";
import type { BuildService } from "../workspace/build.js";
import type { DevicePreferencesStore } from "./preferences.js";
function fixture() {
  const principal: Principal = {
    kind: "core",
    adapter: "deployment",
    hostEpoch: randomUUID(),
    workbenchInstance: randomUUID(),
    authorityContext: { ref: randomUUID(), epoch: randomUUID() },
  };
  const execute = vi.fn<LegacyOperation["execute"]>(async (request) => ({
    value:
      request.kind === "list"
        ? { kind: "entries", entries: [] }
        : request.kind === "run"
          ? { kind: "launch", sent: true }
          : { kind: "transfer", transferred: request.kind === "upload" ? request.size : 0 },
    dispatch: "sent",
    stopConfirmation: "not-required",
    error: null,
  }));
  const operation: LegacyOperation = {
    operationId: randomUUID(),
    execute,
    renewConfirmation() {},
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const begin = vi.fn<LegacyOperationPort["begin"]>(async () => operation);
  const request = vi.fn(
    async (_principal: Principal, _method: string, _params: unknown, _signal: AbortSignal) => ({
      ok: true,
      value: { candidates: [] },
    }),
  );
  const stop = vi.fn(async () => {}),
    disconnect = vi.fn(async () => {});
  const legacy = new LegacyDevice({
    broker: { request } as unknown as DeviceBrokerPort,
    principal: () => principal,
    stop,
    disconnect,
    feed: { subscribe: async () => async () => {} },
  });
  const artifacts = vi.fn(async () => [
    { path: "/asset", remotePath: "asset.rgf", role: "deploy-asset", bytes: Uint8Array.of(1) },
    { path: "/main", remotePath: "main.rbf", role: "deploy-main", bytes: Uint8Array.of(2) },
  ]);
  const builds = {
    artifactBytes: async () => Uint8Array.of(1),
    deployableArtifacts: artifacts,
  } as unknown as BuildService;
  const preferences = {
    get: () => ({ skipUnchangedAssets: false }),
    set: async () => ({}),
  } as unknown as DevicePreferencesStore;
  const service = new DeviceService(builds, () => undefined, preferences, {
    device: legacy,
    files: new LegacyFiles({ begin }, () => principal),
  });
  return { service, execute, begin, operation, request, stop, disconnect, artifacts, principal };
}
it("F11 stale descriptor/native path cannot reconnect or replay deployment/run", async () => {
  const f = fixture();
  await f.service.discover();
  await expect(
    f.service.connect({ id: "old", name: "EV3", transport: "usb", metadata: { path: "old-path" } }),
  ).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.request.mock.calls).toHaveLength(1);
});

import { createDeviceBroker, type DeviceBrokerOptions } from "../device-broker/broker-port.js";
import { operationHarness, ID } from "../device-broker/fake-provider.js";
import { createLegacyMonitorFeed } from "../device-broker/legacy-device.js";
async function realFixture(autoReconnect = false, transport: "usb" | "wifi" = "usb") {
  const h = operationHarness();
  const principal: Principal = {
    kind: "core",
    adapter: "deployment",
    hostEpoch: ID,
    workbenchInstance: ID,
    authorityContext: { ref: ID, epoch: ID },
  };
  let policy: ReturnType<DeviceBrokerOptions["connectionPolicy"]> = {
    wifiConnectTimeoutMs: 5000,
    wifiHandshakeTimeoutMs: 3000,
    usbAutoReconnect: autoReconnect,
    usbRetryInterval: 1000,
    usbRetryLimit: 3,
  };
  let authorityValid = true;
  let gateOpen = true;
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: authorityValid ? "local" : "invalid",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: { claim: () => true, isClaimed: () => true, complete() {} },
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () =>
      gateOpen
        ? { ok: true, value: null }
        : {
            ok: false,
            error: {
              code: "PLUGIN_E_DEVICE_UNAVAILABLE",
              message: "Gate closed",
              detail: {
                kind: "device",
                reason: "disconnected",
                dispatch: "not-sent",
                stopConfirmation: "not-required",
              },
            },
          },
    connectionPolicy: () => policy,
  });
  h.provider.describe = () => ({
    key: h.provider.session,
    descriptor: { ...h.provider.descriptor, transport },
    physical: h.provider.physical,
    capabilities: [...h.provider.capabilities],
  });
  h.provider.discover = async () => ({
    value: [
      {
        key: h.provider.candidate,
        descriptor: { ...h.provider.descriptor, transport },
        physical: h.provider.physical,
      },
    ],
    dispatch: "not-sent",
    error: null,
    stopConfirmation: "not-required",
  });
  const unregister = broker.registerProvider(h.provider);
  const disconnect = vi.fn(async (sessionId: string) => {
    const result = await broker.request(
      principal,
      "devices/disconnect",
      { sessionId },
      new AbortController().signal,
    );
    if (!result.ok) throw new Error(result.error.message);
  });
  const legacy = new LegacyDevice({
    broker,
    principal: () => principal,
    disconnect,
    stop: async () => {},
    feed: createLegacyMonitorFeed(broker),
  });
  const service = new DeviceService(
    {} as BuildService,
    () => undefined,
    {} as DevicePreferencesStore,
    { device: legacy, files: new LegacyFiles(broker, () => principal) },
  );
  const events = vi.fn(),
    teardown = vi.fn(async () => {});
  service.subscribe(events);
  service.setBeforeDisconnect(teardown);
  const [candidate] = await service.discover();
  const id = await service.connect(candidate!);
  return {
    ...h,
    broker,
    invalidateAuthority: () => {
      authorityValid = false;
    },
    closeGate: () => {
      gateOpen = false;
    },
    enableRecovery: () => {
      policy = { ...policy, usbAutoReconnect: true };
    },
    cancelRecovery: () => {
      policy = { ...policy, usbAutoReconnect: false };
    },
    legacy,
    service,
    id,
    events,
    teardown,
    disconnect,
    unregister,
  };
}
it.each(["usb", "wifi"] as const)(
  "T5fix2 %s loss preserves exact events without stopping gone motors",
  async (transport) => {
    const f = await realFixture(false, transport);
    try {
      f.events.mockClear();
      f.teardown.mockRejectedValue(new Error("stale motor stop"));
      f.provider.lose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.events.mock.calls.map(([event]) => event)).toEqual([
        transport === "usb"
          ? {
              type: "usb-recovery",
              state: "unavailable",
              previousSessionId: f.id,
              descriptor: expect.objectContaining({ transport }),
            }
          : { type: "state", state: "disconnected", sessionId: f.id, message: expect.any(String) },
      ]);
      expect(f.teardown).not.toHaveBeenCalled();
      expect(() => f.service.descriptor(f.id)).toThrow();
    } finally {
      f.unregister();
    }
  },
);
it("T5fix connect emits connecting/error and disconnects the existing session first", async () => {
  const f = await realFixture();
  try {
    await expect(
      f.service.connect({ id: "stale", name: "EV3", transport: "usb" }),
    ).rejects.toThrow();
    expect(f.teardown).toHaveBeenCalledWith(f.id);
    expect(f.disconnect).toHaveBeenCalledWith(f.id);
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connecting",
      "error",
      undefined,
    ]);
  } finally {
    f.unregister();
  }
});
it("T5fix USB auto-recovery translates waiting, connecting and restored with no deployment replay", async () => {
  vi.useFakeTimers();
  const f = await realFixture(true);
  try {
    f.events.mockClear();
    f.provider.lose();
    await vi.advanceTimersByTimeAsync(1000);
    const recovery = f.events.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "usb-recovery");
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual([
      "waiting",
      "connecting",
      "restored",
    ]);
    expect(recovery.map((event) => event.state)).toEqual(["waiting", "connecting", "restored"]);
    expect(recovery.at(-1)).toMatchObject({
      previousSessionId: f.id,
      deployment: "none",
      sessionId: expect.any(String),
    });
    expect(f.service.descriptor(recovery.at(-1).sessionId).transport).toBe("usb");
    expect(f.provider.calls).not.toContain("run");
  } finally {
    f.unregister();
    vi.useRealTimers();
  }
});
it("T5fix reset attempts every descriptor through disconnect even if one hook fails", async () => {
  const descriptors = new Set(["first", "second"]);
  const disconnect = vi.fn(async (id: string) => {
    descriptors.delete(id);
  });
  const legacy = {
    sessionIds: () => [...descriptors],
    disconnect,
    subscribe: () => () => {},
  } as unknown as LegacyDevice;
  const service = new DeviceService(
    {} as BuildService,
    () => undefined,
    {} as DevicePreferencesStore,
    { device: legacy, files: {} as LegacyFiles },
  );
  const before = vi.fn(async (id: string) => {
    if (id === "first") throw new Error("stop failed");
  });
  const events = vi.fn();
  service.setBeforeDisconnect(before);
  service.subscribe(events);
  await service.reset();
  expect(before.mock.calls.map(([id]) => id)).toEqual(["first", "second"]);
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("second");
  expect(events).toHaveBeenCalledWith({
    type: "state",
    state: "disconnected",
    sessionId: "second",
  });
});
it.each(["cancelled", "exhausted"])(
  "T5fix USB recovery reports %s without replay",
  async (state) => {
    vi.useFakeTimers();
    const f = await realFixture(true);
    try {
      f.provider.lose();
      if (state === "cancelled") f.cancelRecovery();
      else
        f.provider.discover = async () => ({
          value: [],
          dispatch: "not-sent",
          error: null,
          stopConfirmation: "not-required",
        });
      await vi.advanceTimersByTimeAsync(state === "cancelled" ? 1000 : 3000);
      const states = f.events.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "usb-recovery")
        .map((event) => event.state);
      expect(states.at(-1)).toBe(state);
      if (state === "exhausted") expect(states).toEqual(["waiting", "exhausted"]);
      expect(states).not.toContain("restored");
    } finally {
      f.unregister();
      vi.useRealTimers();
    }
  },
);

import { ExecutionController } from "../../renderer/execution/execution.js";
import type { KobrixaApi } from "../../shared/api.js";
it("T5fix2 DeviceService waiting -> restored is adopted by ExecutionController", async () => {
  vi.useFakeTimers();
  const f = await realFixture(true);
  const controller = new ExecutionController({
    build: { onEvent: () => () => {} },
    device: {
      onEvent: (listener: Parameters<DeviceService["subscribe"]>[0]) =>
        f.service.subscribe(listener),
      connect: async () => f.id,
    },
  } as unknown as KobrixaApi);
  const detach = controller.attach();
  try {
    await controller.connect(f.service.descriptor(f.id));
    f.provider.lose();
    expect(controller.getSnapshot().recovery?.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getSnapshot().recovery).toBeUndefined();
    const restored = f.events.mock.calls
      .map(([event]) => event)
      .find((event) => event.state === "restored");
    expect(controller.getSnapshot().session?.id).toBe(restored.sessionId);
    expect(controller.getSnapshot().session?.id).not.toBe(f.id);
  } finally {
    detach();
    f.unregister();
    vi.useRealTimers();
  }
});

it("T5fix2 ambiguous USB recovery is terminal and emits unavailable once", async () => {
  vi.useFakeTimers();
  const f = await realFixture(true);
  try {
    const discover = f.provider.discover.bind(f.provider);
    f.provider.discover = async (ctx) => {
      const result = await discover(ctx);
      return { ...result, value: [...result.value!, ...result.value!] };
    };
    f.events.mockClear();
    f.provider.lose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.events.mock.calls.map(([event]) => [event.type, event.state])).toEqual([
      ["usb-recovery", "waiting"],
      ["usb-recovery", "unavailable"],
    ]);
  } finally {
    f.unregister();
    vi.useRealTimers();
  }
});

it.each(["policy", "authority", "provider", "gate"] as const)(
  "T5fix3 USB loss with unavailable %s emits unavailable and tears down once",
  async (cause) => {
    const f = await realFixture(true);
    const teardown = vi.fn();
    // The loss predicate used by index.ts.
    const unsubscribe = f.service.subscribe((event) => {
      if (
        (event.type === "state" && event.state === "disconnected") ||
        (event.type === "usb-recovery" && ["waiting", "unavailable"].includes(event.state))
      )
        teardown();
    });
    try {
      f.events.mockClear();
      if (cause === "policy") f.cancelRecovery();
      if (cause === "authority") f.invalidateAuthority();
      if (cause === "gate") f.closeGate();
      if (cause === "provider") await f.broker.resources.retireProvider(f.provider.id, 1);
      else f.provider.lose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.events.mock.calls.map(([event]) => [event.type, event.state])).toEqual([
        ["usb-recovery", "unavailable"],
      ]);
      expect(teardown).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      f.unregister();
    }
  },
);

it("T5fix3 failed connecting returns to waiting before a successful retry", async () => {
  vi.useFakeTimers();
  const f = await realFixture(true);
  try {
    vi.spyOn(f.provider, "connect").mockRejectedValueOnce(new Error("connect failed"));
    f.events.mockClear();
    f.provider.lose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual([
      "waiting",
      "connecting",
      "waiting",
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual([
      "waiting",
      "connecting",
      "waiting",
      "connecting",
      "restored",
    ]);
  } finally {
    f.unregister();
    vi.useRealTimers();
  }
});

it("T5fix3 journal identity ambiguity is terminal unavailable", async () => {
  vi.useFakeTimers();
  const f = await realFixture(true);
  try {
    const document = await f.dependencies.journal.load();
    vi.spyOn(f.dependencies.journal, "load").mockResolvedValue({
      ...document,
      entries: [
        {
          sessionId: f.id,
          physical: { ...f.provider.physical, digest: "f".repeat(64) },
        } as (typeof document.entries)[number],
      ],
    });
    const discover = vi.spyOn(f.provider, "discover");
    f.events.mockClear();
    f.provider.lose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual(["waiting", "unavailable"]);
    expect(discover).toHaveBeenCalledOnce();
  } finally {
    f.unregister();
    vi.useRealTimers();
  }
});

it("T5fix3 ended core reservation drains before reconnect with no live session", async () => {
  const f = await realFixture(false);
  try {
    const { sources } = await f.legacy.request("devices/session", { sessionId: f.id });
    const { reservation } = await f.legacy.request("devices/recording/reserve", {
      sessionId: f.id,
      channelIds: [sources.channels[0]!.channelId],
      expectedSourceRevision: sources.sourceRevision,
    });
    f.provider.lose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.legacy.sessionIds()).toEqual([]);
    // Finish core cleanup so the broker has no retained session either.
    expect(
      await f.broker.sessions.disconnect(f.id, {
        actionToken: ID,
        scope: { hostEpoch: ID, workbenchInstance: ID },
      }),
    ).toMatchObject({ ok: true });
    const drained = await f.legacy.request("devices/recording/read", {
      reservationId: reservation.reservationId,
      afterSequence: 0,
      limit: 64,
    });
    expect(drained.reservation).toMatchObject({ state: "ended", reason: "disconnected" });
    expect(drained.frames.length).toBeGreaterThan(0);
    await f.legacy.request("devices/recording/release", {
      reservationId: reservation.reservationId,
    });
    f.setNow(10000);
    await expect(
      f.legacy.request("devices/recording/read", {
        reservationId: reservation.reservationId,
        afterSequence: 0,
        limit: 64,
      }),
    ).rejects.toThrow();
  } finally {
    f.unregister();
  }
});

it("T5fix3 USB loss uses policy enabled after connect", async () => {
  vi.useFakeTimers();
  const f = await realFixture(false);
  try {
    f.enableRecovery();
    f.events.mockClear();
    f.provider.lose();
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual(["waiting"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.events.mock.calls.map(([event]) => event.state)).toEqual([
      "waiting",
      "connecting",
      "restored",
    ]);
  } finally {
    f.unregister();
    vi.useRealTimers();
  }
});
