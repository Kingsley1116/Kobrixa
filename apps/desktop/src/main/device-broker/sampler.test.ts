import { expect, it, vi } from "vitest";
import { Sampler } from "./sampler.js";
import { frame, ID } from "./fake-provider.js";
it("F07/F12 one in-flight poll serves monitor, battery and recording demand", async () => {
  let now = 0,
    release!: (value: ReturnType<typeof frame>) => void;
  const read = vi.fn(
    () =>
      new Promise<ReturnType<typeof frame>>((resolve) => {
        release = resolve;
      }),
  );
  const sampler = new Sampler({ sessionId: ID, now: () => now, read, busy: () => false });
  const a = sampler.fresh(),
    b = sampler.fresh();
  expect(read).toHaveBeenCalledTimes(1);
  release({ ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 });
  await Promise.all([a, b]);
  now = 2500;
  expect(sampler.snapshot().status).toBe("fresh");
  now = 2501;
  expect(sampler.snapshot().status).toBe("stale");
  sampler.dispose();
});
it("F07 battery-only waits 30 seconds after completion; busy never aborts a read", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 }));
  let busy = false;
  const sampler = new Sampler({ sessionId: ID, now: () => Date.now(), read, busy: () => busy });
  sampler.demand("battery", 30000);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29999);
  expect(read).toHaveBeenCalledTimes(1);
  busy = true;
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(1);
  sampler.dispose();
  vi.useRealTimers();
});

it("provider frames have one receipt origin and mode snapshots use the same sequence", async () => {
  let now = 100;
  const raw = { ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 };
  const sampler = new Sampler({
    sessionId: ID,
    now: () => now,
    busy: () => false,
    read: async () => raw,
  });
  expect((await sampler.fresh()).frame).toMatchObject({ sequence: 1, elapsedMs: 0 });
  now = 150;
  expect(sampler.receive(raw).frame).toMatchObject({ sequence: 2, elapsedMs: 50 });
  expect(() => sampler.receive({ ...raw, sequence: 9 })).toThrow();
  sampler.dispose();
});

import { EventLedger } from "./registry.js";
import { pluginPrincipal } from "./fake-provider.js";
it("terminal telemetry and throwing consumers cannot break shared fresh reads", async () => {
  const owner = pluginPrincipal().owner,
    ledger = new EventLedger(
      () => 0,
      () => {},
      () => {},
    );
  const created = ledger.create(owner);
  if (!created.ok) throw new Error("create");
  const id = created.value.subscriptionId;
  ledger.publish(
    owner,
    id,
    { kind: "devices.catalog", data: { revision: 0, providers: [], sessions: [] } },
    "control",
  );
  ledger.closeAfterControl(owner, id);
  const sampler = new Sampler({
    sessionId: ID,
    now: () => 0,
    busy: () => false,
    read: async () => ({ ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 }),
  });
  sampler.subscribe((sample) => {
    ledger.publish(
      owner,
      id,
      {
        kind: "devices.telemetry",
        data: { sessionId: ID, frames: [sample], snapshot: sampler.snapshot() },
      },
      "telemetry",
    );
  });
  const healthy = vi.fn();
  sampler.subscribe(healthy);
  await expect(sampler.fresh()).resolves.toMatchObject({ status: "fresh" });
  expect(healthy).toHaveBeenCalledTimes(1);
  sampler.dispose();
  ledger.dispose();
});
it.each(["busy", "read-error"] as const)("isolates listeners on %s frames", async (mode) => {
  const failure = new Error("read failed");
  const sampler = new Sampler({
    sessionId: ID,
    now: () => 0,
    busy: () => mode === "busy",
    read: async () => {
      throw failure;
    },
  });
  sampler.subscribe(() => {
    throw new Error("consumer failed");
  });
  const healthy = vi.fn();
  sampler.subscribe(healthy);
  const result = Promise.resolve().then(() => sampler.fresh());
  if (mode === "busy")
    await expect(result).rejects.toMatchObject({
      result: { error: { code: "PLUGIN_E_DEVICE_BUSY" } },
    });
  else await expect(result).rejects.toBe(failure);
  expect(healthy).toHaveBeenCalledTimes(1);
  sampler.dispose();
});

import { randomUUID } from "node:crypto";
import { EV3DeviceSession, type DeviceMonitorSnapshot } from "@kobrixa/device";
import { buildEv3Provider } from "../device-providers/ev3/provider.js";
import { createDeviceBroker } from "./broker-port.js";
import { createContexts, ExchangeLane } from "./provider.js";
import { operationHarness } from "./fake-provider.js";

it("AM-05/06 real EV3 receipts share one origin and cancelled uploads retain occupancy through close", async () => {
  for (const closeFails of [false, true]) {
    const h = operationHarness();
    const broker = createDeviceBroker({
      journal: h.dependencies.journal,
      profile: h.dependencies.profile,
      now: h.dependencies.now,
      authority: { current: () => null, assertContinuation() {}, subscribe: () => () => {} },
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
    const descriptor = {
      id: "usb:integration",
      name: "Brick",
      transport: "usb" as const,
      serialNumber: "integration",
    };
    const reading: DeviceMonitorSnapshot = {
      sampledAt: 123,
      battery: { percent: 80, voltage: 7.5 },
      program: { status: "stopped", rawStatus: 64, result: 0 },
      inputs: [
        {
          port: 0,
          type: 29,
          connection: 122,
          mode: 0,
          state: "ready",
          name: "Touch",
          modeName: "Touch",
          unit: "raw",
          decimals: 0,
          values: [1],
          switchable: true,
        },
      ],
      outputs: Array.from({ length: 4 }, (_, port) => ({
        port,
        type: 7,
        state: "ready",
        name: "Motor",
        angle: 0,
      })),
    };
    let chunkReached!: () => void,
      releaseChunk!: () => void,
      closeReached!: () => void,
      releaseClose!: () => void;
    const chunkStarted = new Promise<void>((resolve) => {
      chunkReached = resolve;
    });
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      closeReached = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const commands: number[] = [];
    const raw = new EV3DeviceSession(descriptor, {
      async exchange(payload, signal) {
        commands.push(payload[1]!);
        if (payload[1] === 0x92) return Uint8Array.of(3, 0x92, 0, 7);
        if (payload[1] === 0x93) {
          chunkReached();
          await chunkGate;
          return Uint8Array.of(3, 0x93, 0, 7);
        }
        expect(payload).toEqual(Uint8Array.of(1, 0x98, 7));
        expect(signal.aborted).toBe(false);
        closeReached();
        await closeGate;
        if (closeFails) throw new Error("readback-failed");
        return Uint8Array.of(3, 0x98, 0);
      },
      transmit: async () => {},
      close: async () => {},
    });
    const bind = raw.bindIo.bind(raw);
    vi.spyOn(raw, "bindIo").mockImplementation((binding) => {
      const view = bind(binding);
      vi.spyOn(view, "readMonitor").mockResolvedValue(reading);
      vi.spyOn(view, "setInputMode").mockResolvedValue(reading);
      return view;
    });
    const transport = { discover: async () => [descriptor], connect: async () => raw };
    const provider = buildEv3Provider(broker.providerCatalog("kobrixa.device-ev3"), {
      usb: transport,
      wifi: transport,
    });
    const connectSpy = vi.spyOn(provider, "connect");
    const legacySpy = vi.spyOn(provider, "legacy");
    const unregister = broker.registerProvider(provider);
    const principal = pluginPrincipal(),
      signal = new AbortController().signal;
    const connected = await broker.request(
      principal,
      "devices/connect",
      {
        target: { kind: "wifi-address", providerId: provider.id, address: "192.0.2.1" },
      },
      signal,
    );
    expect(connected.ok).toBe(true);
    if (!connected.ok) throw new Error("connect");
    const sessionId = connected.value.session.sessionId;
    const key = (await connectSpy.mock.results[0]!.value).value!.key;
    const ctx = createContexts({
      id: randomUUID(),
      sessionId,
      generation: 1,
      operationClass: "mode-write",
      deadline: 600000,
      now: h.dependencies.now,
      lane: new ExchangeLane(h.dependencies.now),
      check() {},
      progress() {},
      onStop() {},
    });
    const sources = await provider.sources(key, ctx.work);
    const read = await provider.read(key, ctx.work);
    const changed = await provider.setInputMode(
      key,
      {
        portId: "input:0",
        modeId: "mode:0",
        expectedSourceRevision: sources.value!.sourceRevision,
      },
      ctx.work,
    );
    expect(read.value).toMatchObject({ sequence: 0, sampledAt: 0, elapsedMs: 0 });
    const sampler = new Sampler({
      sessionId,
      now: h.dependencies.now,
      busy: () => false,
      read: async () => read.value!,
    });
    const core = vi.fn(),
      plugin = vi.fn();
    sampler.subscribe(core);
    sampler.subscribe(plugin);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1000000);
    try {
      h.setNow(25);
      expect((await sampler.fresh()).frame).toMatchObject({
        sequence: 1,
        sampledAt: 1000000,
        elapsedMs: 25,
      });
      h.setNow(50);
      wall.mockReturnValue(1000100);
      expect(sampler.receive(changed.value!.snapshot.frame!).frame).toMatchObject({
        sequence: 2,
        sampledAt: 1000100,
        elapsedMs: 50,
      });
      expect(core.mock.calls).toEqual(plugin.mock.calls);
      expect(() => sampler.receive({ ...read.value!, sequence: 9 })).toThrow(
        expect.objectContaining({
          result: expect.objectContaining({
            error: expect.objectContaining({
              detail: expect.objectContaining({ reason: "provider-contract" }),
            }),
          }),
        }),
      );
      expect(core).toHaveBeenCalledTimes(2);
    } finally {
      wall.mockRestore();
      sampler.dispose();
    }
    const input = { principal, sessionId, operationClass: "file-write" as const, signal };
    const operation = await broker.begin(input);
    const work = operation.execute({
      kind: "upload",
      remotePath: "/home/root/lms2012/prjs/integration",
      size: 1801,
      chunks: (async function* () {
        yield new Uint8Array(1801);
      })(),
      progress() {},
    });
    const failure = work.catch((error: unknown) => error);
    const rejected = expect(work).rejects.toThrow();
    await chunkStarted;
    let cancelled = false;
    const cancel = operation.cancel().then(() => {
      cancelled = true;
    });
    await expect(broker.begin(input)).rejects.toThrow();
    releaseChunk();
    await closeStarted;
    expect(cancelled).toBe(false);
    await expect(broker.begin(input)).rejects.toThrow();
    releaseClose();
    await rejected;
    await cancel;
    const evidence = await legacySpy.mock.results[0]!.value;
    expect(commands).toEqual([0x92, 0x93, 0x98]);
    if (closeFails) {
      expect(evidence).toMatchObject({
        dispatch: "unknown",
        error: { message: expect.stringContaining("close failed") },
      });
      expect(await failure).toMatchObject({
        result: {
          error: {
            detail: {
              kind: "device",
              dispatch: "unknown",
              stopConfirmation: "unconfirmed",
              reason: "readback-failed",
            },
          },
        },
      });
    } else expect(evidence.error).not.toBeNull();
    const next = await broker.begin(input);
    await next.finish();
    await raw.disconnect();
    unregister();
  }
});
