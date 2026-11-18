import { expect, it, vi } from "vitest";
import type { LegacyDevice, LegacyMonitorFeed } from "./legacy-device.js";
import { LegacyLab } from "./legacy-lab.js";
it("F12/F19 pins selected channels, publishes first frame and releases the original reservation once", async () => {
  const channel = {
    channelId: "c",
    kind: "input",
    portId: "input:0",
    typeId: "ev3:29",
    modeId: "mode:0",
    component: 0,
    name: "Touch",
    modeName: "Touch",
    unit: "raw",
    decimals: 0,
    state: "ready",
  };
  const frame = {
    sequence: 1,
    sampledAt: 1,
    elapsedMs: 0,
    sourceRevision: 1,
    status: "ok",
    program: "stopped",
    values: [{ channelId: "c", value: 1 }],
  };
  const request = vi.fn(async (method: string) => {
    if (method === "devices/session")
      return { sources: { sessionId: "s", sourceRevision: 1, channels: [channel], actuators: [] } };
    if (method === "devices/recording/reserve")
      return {
        reservation: { reservationId: "r", sessionId: "s", channels: [channel] },
        firstFrame: frame,
      };
    if (method === "devices/recording/release")
      return { reservation: { reservationId: "r", lastSequence: 1 } };
    if (method === "devices/recording/read")
      return { frames: [], gap: null, nextSequence: 1, hasMore: false };
    throw new Error(method);
  });
  const remove = vi.fn(async () => {}),
    publish = vi.fn();
  const lab = new LegacyLab(
    {
      request,
      watch: async () => remove,
      descriptor: () => ({ id: "s", name: "EV3", transport: "usb" }),
    } as unknown as LegacyDevice,
    publish,
  );
  await lab.acquire("s", [
    {
      id: "old",
      kind: "input",
      port: 0,
      type: 29,
      mode: 0,
      channel: 0,
      name: "Touch",
      modeName: "Touch",
      unit: "raw",
      decimals: 0,
    },
  ]);
  expect(request).toHaveBeenCalledWith("devices/recording/reserve", {
    sessionId: "s",
    channelIds: ["c"],
    expectedSourceRevision: 1,
  });
  expect(publish).toHaveBeenCalledOnce();
  await lab.release("s");
  await lab.release("s");
  expect(
    request.mock.calls.filter(([method]) => method === "devices/recording/release"),
  ).toHaveLength(1);
  expect(remove).toHaveBeenCalledOnce();
});
it.each(["coalesced", "overflow", "unavailable"])(
  "F12/F19 consumes original ring evidence on %s without a second sampling timer",
  async (kind) => {
    const channel = {
      channelId: "c",
      kind: "input" as const,
      portId: "input:0",
      typeId: "ev3:29",
      modeId: "mode:0",
      component: 0,
      name: "Touch",
      modeName: "Touch",
      unit: "raw",
      decimals: 0,
      state: "ready" as const,
    };
    const sources = { sessionId: "s", sourceRevision: 1, channels: [channel], actuators: [] };
    const frame = (sequence: number) => ({
      sequence,
      sampledAt: sequence * 500,
      elapsedMs: sequence * 500,
      sourceRevision: 1,
      status: "ok" as const,
      program: "stopped" as const,
      values: [{ channelId: "c", value: sequence }],
    });
    const lastSequence = kind === "unavailable" ? 1 : kind === "overflow" ? 4 : 3;
    let receive!: Parameters<LegacyMonitorFeed["subscribe"]>[0]["receive"];
    const request = vi.fn(async (method: string) => {
      if (method === "devices/session") return { sources };
      if (method === "devices/recording/reserve")
        return { reservation: { reservationId: "r", channels: [channel] }, firstFrame: frame(1) };
      if (method === "devices/recording/release")
        return { reservation: { reservationId: "r", lastSequence } };
      if (method === "devices/recording/read")
        return {
          reservation: { reservationId: "r", lastSequence },
          frames: kind === "overflow" ? [frame(4)] : [frame(2), frame(3)],
          gap: kind === "overflow" ? { fromSequence: 2, toSequence: 3, reason: "overflow" } : null,
          nextSequence: lastSequence,
          hasMore: false,
        };
      throw new Error(method);
    });
    const publish = vi.fn(),
      remove = vi.fn(async () => {});
    const lab = new LegacyLab(
      {
        request,
        watch: async (_id: string, _interval: number, listener: typeof receive) => {
          receive = listener;
          return remove;
        },
        descriptor: () => ({ id: "s", name: "EV3", transport: "usb" }),
      } as unknown as LegacyDevice,
      publish,
    );
    await lab.acquire("s", [
      {
        id: "old",
        kind: "input",
        port: 0,
        type: 29,
        mode: 0,
        channel: 0,
        name: "Touch",
        modeName: "Touch",
        unit: "raw",
        decimals: 0,
      },
    ]);
    receive(
      {
        sessionId: "s",
        revision: 2,
        status: kind === "unavailable" ? "unavailable" : "fresh",
        ageMs: 0,
        frame: kind === "unavailable" ? null : frame(lastSequence),
      },
      sources,
    );
    await lab.release("s");
    const updates = publish.mock.calls.map(([update]) => update);
    expect(updates.map((value) => value.status)).toEqual(
      kind === "unavailable"
        ? ["live", "paused"]
        : kind === "overflow"
          ? ["live", "waiting", "live"]
          : ["live", "live", "live"],
    );
    if (kind !== "unavailable")
      expect(request).toHaveBeenCalledWith("devices/recording/read", {
        reservationId: "r",
        afterSequence: 1,
        limit: 64,
      });
    expect(remove).toHaveBeenCalledOnce();
  },
);

import { createDeviceBroker, type CorePrincipal } from "./broker-port.js";
import { operationHarness, createFakeDeviceProvider, FakeProvider, ID } from "./fake-provider.js";
import { LegacyDevice as RealLegacyDevice, createLegacyMonitorFeed } from "./legacy-device.js";
import { MonitorService } from "../device/monitor-service.js";
it.each(["release", "loss", "epoch"])(
  "T5fix2 core Lab drain and Monitor/Lab epoch closure: %s",
  async (scenario) => {
    const lost = scenario === "loss";
    let epoch = ID;
    const h = operationHarness();
    const principal: CorePrincipal = {
      kind: "core",
      adapter: "lab",
      hostEpoch: ID,
      workbenchInstance: ID,
      authorityContext: { ref: ID, epoch: ID },
    };
    const broker = createDeviceBroker({
      journal: h.dependencies.journal,
      profile: h.dependencies.profile,
      now: h.dependencies.now,
      authority: {
        current: () => ({
          ref: ID,
          epoch,
          workbenchInstance: ID,
          state: "local",
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
      operationGate: () => ({ ok: true, value: null }),
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 5000,
        wifiHandshakeTimeoutMs: 3000,
        usbAutoReconnect: false,
        usbRetryInterval: "backoff",
        usbRetryLimit: 3,
      }),
    });
    const { provider } = createFakeDeviceProvider({
      catalog: broker.providerCatalog(h.provider.id),
      now: h.dependencies.now,
    });
    // The formal provider's channels use portable IDs; adapt only its legacy EV3 metadata.
    const sources = provider.sources.bind(provider);
    vi.spyOn(provider, "sources").mockImplementation(async (...args) => {
      const result = await sources(...args);
      result.value!.channels[0] = {
        ...result.value!.channels[0]!,
        portId: "input:0",
        typeId: "ev3:29",
        modeId: "mode:0",
      };
      return result;
    });
    const unregister = broker.registerProvider(provider);
    const device = new RealLegacyDevice({
      broker,
      principal: () => principal,
      stop: async () => {},
      disconnect: async () => {},
      feed: createLegacyMonitorFeed(broker),
    });
    const publish = vi.fn();
    const lab = new LegacyLab(device, publish);
    const monitor = new MonitorService(device, vi.fn());
    try {
      const id = await device.connectWifi("127.0.0.1");
      const request = vi.spyOn(device, "request");
      await lab.acquire(id, [
        {
          id: "old",
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
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "live",
          snapshot: expect.objectContaining({
            inputs: [expect.objectContaining({ values: [42] })],
          }),
        }),
      );
      const reserve = request.mock.results.find(
        (_, i) => request.mock.calls[i]![0] === "devices/recording/reserve",
      )!;
      const { reservation } = await reserve.value;
      expect(
        await device.request("devices/recording/query", {
          reservationId: reservation.reservationId,
        }),
      ).toMatchObject({ reservation: { state: "active" } });
      expect(
        await device.request("devices/recording/read", {
          reservationId: reservation.reservationId,
          afterSequence: 0,
          limit: 1,
        }),
      ).toMatchObject({
        frames: [
          expect.objectContaining({ values: [{ channelId: expect.any(String), value: 42 }] }),
        ],
      });
      if (scenario === "epoch") {
        await monitor.watch(id, true);
        epoch = "00000000-0000-4000-8000-000000000002";
        await new Promise((resolve) => setTimeout(resolve, 550));
        expect(monitor.latest(id)?.status).toBe("paused");
        expect(lab.latest(id)?.status).toBe("paused");
        return;
      }
      if (lost) {
        if (!(provider instanceof FakeProvider)) throw new Error("Expected fake provider");
        provider.lose();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await device.connectWifi("127.0.0.1");
        expect(
          await device.request("devices/recording/read", {
            reservationId: reservation.reservationId,
            afterSequence: 0,
            limit: 64,
          }),
        ).toMatchObject({ frames: expect.arrayContaining([expect.any(Object)]) });
      }
      await lab.release(id);
      expect(
        await device.request("devices/recording/query", {
          reservationId: reservation.reservationId,
        }),
      ).toMatchObject({
        reservation: { state: "ended", reason: lost ? "disconnected" : "released" },
      });
      h.setNow(10000);
      await expect(
        device.request("devices/recording/read", {
          reservationId: reservation.reservationId,
          afterSequence: 0,
          limit: 64,
        }),
      ).rejects.toThrow();
    } finally {
      await monitor.dispose();
      unregister();
      await broker.resources.beginShutdown();
    }
  },
);

function cleanupFixture() {
  const sources = { sessionId: "s", sourceRevision: 1, channels: [], actuators: [] };
  const frame = {
    sequence: 1,
    sampledAt: 1,
    elapsedMs: 0,
    sourceRevision: 1,
    status: "ok",
    program: "stopped",
    values: [],
  };
  const request = vi.fn(async (method: string) => {
    if (method === "devices/session") return { sources };
    if (method === "devices/recording/reserve")
      return { reservation: { reservationId: "r", channels: [] }, firstFrame: frame };
    if (method === "devices/recording/release") return { reservation: { lastSequence: 1 } };
    throw new Error(method);
  });
  const remove = vi.fn(async () => {});
  let closed: ((reason: string) => void) | undefined;
  const watch = vi.fn(
    async (_id: string, _interval: number, _receive: unknown, onClosed?: typeof closed) => {
      closed = onClosed;
      return remove;
    },
  );
  const publish = vi.fn();
  const lab = new LegacyLab({ request, watch } as unknown as LegacyDevice, publish);
  return { lab, request, watch, remove, publish, close: () => closed?.("overflow") };
}
it("T5fix Lab emits paused when its feed closes", async () => {
  const f = cleanupFixture();
  await f.lab.acquire("s", []);
  f.close();
  expect(f.lab.latest("s")?.status).toBe("paused");
  await f.lab.release("s");
});
it("T5fix failed feed removal does not leave Lab permanently ending", async () => {
  const f = cleanupFixture();
  await f.lab.acquire("s", []);
  f.remove.mockRejectedValueOnce(new Error("remove failed"));
  await expect(f.lab.release("s")).rejects.toThrow("remove failed");
  await expect(f.lab.acquire("s", [])).resolves.toBeUndefined();
  await f.lab.release("s");
});
it("T5fix failed acquisition cleanup preserves the original failure", async () => {
  const f = cleanupFixture();
  const failure = new Error("watch failed");
  f.watch.mockRejectedValueOnce(failure);
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method) => {
    if (method === "devices/recording/release") throw new Error("release failed");
    return original(method);
  });
  await expect(f.lab.acquire("s", [])).rejects.toBe(failure);
});
