import { randomUUID } from "node:crypto";
import { expect, it, vi, onTestFinished } from "vitest";
import { EV3DeviceSession, type DeviceMonitorSnapshot } from "@kobrixa/device";
import {
  unavailableUi150,
  type Principal,
  type Stage3EventEnvelope,
} from "@kobrixa/plugin-runtime";
import {
  LifecycleCoordinator,
  createResourceFreePersistence,
} from "../../device-broker/lifecycle-coordinator.js";
import { createContexts, ExchangeLane } from "../../device-broker/provider.js";
import { createDeviceBroker } from "../../device-broker/broker-port.js";
import { journalDocument } from "../../device-broker/journal.js";
import { createLegacyMonitorFeed } from "../../device-broker/legacy-device.js";
import { buildEv3Provider } from "./provider.js";
import { EV3_PROVIDER_ID } from "./catalog.js";
function reading(): DeviceMonitorSnapshot {
  return {
    sampledAt: 100,
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
        values: [42],
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
}
async function fixture(auto = false) {
  const hostEpoch = randomUUID(),
    context = randomUUID(),
    workbench = randomUUID();
  const principal: Extract<Principal, { kind: "plugin" }> = {
    kind: "plugin",
    owner: {
      sourceKey: "builtin:test.ev3",
      pluginId: "test.ev3",
      generation: 1,
      hostEpoch,
      processEpoch: randomUUID(),
    },
    authorityContext: { ref: context, epoch: context },
  };
  const core: Extract<Principal, { kind: "core" }> = {
    kind: "core",
    adapter: "monitor",
    hostEpoch,
    workbenchInstance: workbench,
    authorityContext: principal.authorityContext,
  };
  let document = journalDocument(0, []);
  const health: { value: "ready" | "unwritable" } = { value: "ready" };
  const commit = vi.fn(async (next: typeof document) => {
    document = structuredClone(next);
  });
  const broker = createDeviceBroker({
    profile: { hostEpoch, assertHeld() {} },
    now: () => performance.now(),
    journal: {
      load: async () => structuredClone(document),
      commit,
      snapshot: () => ({
        revision: document.revision,
        journalHealth: health.value,
        faults: document.entries,
        blockers: document.entries.filter((r) => r.state !== "resolved").map((r) => r.id),
      }),
      subscribe: () => () => {},
    },
    authority: {
      current: () => ({
        ref: context,
        epoch: context,
        workbenchInstance: workbench,
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
      usbAutoReconnect: auto,
      usbRetryInterval: 1000,
      usbRetryLimit: 3,
    }),
  });
  const descriptor = {
    id: "usb:native",
    name: "EV3",
    transport: "usb" as const,
    serialNumber: "original-brick",
  };
  const observed = reading();
  let nativeLoss: ((error: Error) => void) | undefined;
  const closes = vi.fn(async () => {}),
    removed = vi.fn(),
    modeWrites = vi.fn();
  const stop = vi.fn(async () => {}),
    motorStop = vi.fn(async () => {});
  const monitor = vi.fn(async () => structuredClone(observed));
  const modeQueries = vi.fn(async (port: number, type: number) => ({
    port,
    type,
    currentMode: observed.inputs[0]!.mode,
    modes: [
      { mode: 0, name: "Touch" },
      { mode: 1, name: "Other" },
    ],
  }));
  const connect = vi.fn(async () => {
    const raw = new EV3DeviceSession(descriptor, {
      exchange: async () => Uint8Array.of(2),
      transmit: async () => {},
      close: closes,
      onDisconnect(listener) {
        nativeLoss = listener;
        return removed;
      },
    });
    // Native-session seam already used by provider.test.ts; broker, provider,
    // catalog, native connection-loss callback and close remain real.
    vi.spyOn(raw, "bindIo").mockReturnValue(raw);
    vi.spyOn(raw, "readMonitor").mockImplementation(monitor);
    vi.spyOn(raw, "setInputMode").mockImplementation(async (_port, _type, mode) => {
      modeWrites(mode);
      observed.inputs[0]!.mode = mode;
      return structuredClone(observed);
    });
    vi.spyOn(raw, "readInputModes").mockImplementation(modeQueries);
    vi.spyOn(raw, "stop").mockImplementation(stop);
    vi.spyOn(raw, "motorStop").mockImplementation(motorStop);
    vi.spyOn(raw, "readMotorTest").mockResolvedValue({
      sampledAt: 100,
      programStopped: true,
      outputs: Array.from({ length: 4 }, (_, port) => ({
        port,
        type: 7,
        angle: 0,
        busy: false,
        speed: 0,
      })),
    });
    return raw;
  });
  const catalogPort = broker.providerCatalog(EV3_PROVIDER_ID);
  const provider = buildEv3Provider(catalogPort, {
    usb: { discover: async () => [descriptor], connect },
    wifi: { discover: async () => [], connect },
  });
  const providerConnect = vi.spyOn(provider, "connect");
  const unregister = broker.registerProvider(provider),
    signal = new AbortController().signal;
  const events: Stage3EventEnvelope[] = [];
  const channel = broker.attachChannel({
    owner: principal.owner,
    principal: () => principal,
    send: (event) => {
      events.push(event);
    },
  });
  channel.negotiated("devices", 1);
  const discoverConnect = async () => {
    const discovered = await broker.request(
      principal,
      "devices/discover",
      { providerId: provider.id },
      signal,
    );
    if (!discovered.ok) throw new Error("discover");
    return broker.request(
      principal,
      "devices/connect",
      { target: { kind: "candidate", candidateId: discovered.value.candidates[0]!.candidateId } },
      signal,
    );
  };
  const connected = await discoverConnect();
  if (!connected.ok) throw new Error("initial connect");
  const sessionId = connected.value.session.sessionId;
  const catalog = async (id = sessionId) => {
    const result = await broker.request(principal, "devices/session", { sessionId: id }, signal);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
  };
  const first = await catalog();
  const read = (ids = first.sources.channels.map((c) => c.channelId), id = sessionId) =>
    broker.request(
      principal,
      "devices/read",
      { sessionId: id, channelIds: ids, freshness: "fresh" },
      signal,
    );
  onTestFinished(async () => {
    channel.dispose();
    await broker.resources.beginShutdown();
    unregister();
    vi.restoreAllMocks();
  });
  return {
    broker,
    provider,
    providerConnect,
    catalogPort,
    principal,
    core,
    context,
    signal,
    sessionId,
    first,
    read,
    catalog,
    discoverConnect,
    connect,
    closes,
    removed,
    modeWrites,
    modeQueries,
    monitor,
    health,
    commit,
    stop,
    motorStop,
    unregister,
    events,
    observed,
    channel,
    lose: () => nativeLoss!(new Error("native loss")),
  };
}
it("A-final mode set preserves preflight identity and publishes one stable EV3 catalog", async () => {
  const f = await fixture();
  const set = await f.broker.request(
    f.principal,
    "devices/inputModes/set",
    {
      sessionId: f.sessionId,
      portId: "input:0",
      expectedSourceRevision: f.first.sources.sourceRevision,
      modeId: "mode:1",
      contextRef: f.context,
    },
    f.signal,
  );
  expect(set.ok).toBe(true);
  if (!set.ok) return;
  expect(f.modeWrites).toHaveBeenCalledExactlyOnceWith(1);
  expect(set.value.sources.sourceRevision).toBe(f.first.sources.sourceRevision + 1);
  expect(set.value.sources.channels[0]!.channelId).not.toBe(f.first.sources.channels[0]!.channelId);
  for (let i = 0; i < 2; i++) {
    expect((await f.read(set.value.sources.channels.map((c) => c.channelId))).ok).toBe(true);
    expect((await f.catalog()).sources).toEqual(set.value.sources);
    expect(
      await f.broker.request(
        f.principal,
        "devices/inputModes/query",
        {
          sessionId: f.sessionId,
          portId: "input:0",
          expectedSourceRevision: set.value.sources.sourceRevision,
        },
        f.signal,
      ),
    ).toMatchObject({
      ok: true,
      value: { currentModeId: "mode:1", sourceRevision: set.value.sources.sourceRevision },
    });
  }
  expect((await f.read([f.first.sources.channels[0]!.channelId])).ok).toBe(false);
});
it("A-final observed source change updates catalog, notification, reservation and legacy feed", async () => {
  const f = await fixture();
  await f.broker.request(f.core, "devices/list", {}, f.signal);
  const subscribed = await f.broker.request(
    f.principal,
    "devices/subscribe",
    { topic: "session", sessionId: f.sessionId },
    f.signal,
  );
  expect(subscribed.ok).toBe(true);
  if (subscribed.ok) f.channel.activate(subscribed.value.subscriptionId);
  const reservation = await f.broker.request(
    f.principal,
    "devices/recording/reserve",
    {
      sessionId: f.sessionId,
      channelIds: [f.first.sources.channels[0]!.channelId],
      expectedSourceRevision: f.first.sources.sourceRevision,
    },
    f.signal,
  );
  expect(reservation.ok).toBe(true);
  const receive = vi.fn();
  const remove = await createLegacyMonitorFeed(f.broker).subscribe({
    principal: f.core,
    sessionId: f.sessionId,
    intervalMs: 500,
    receive,
  });
  try {
    f.observed.inputs[0]!.unit = "new-unit";
    expect((await f.read()).ok).toBe(false);
    const fresh = await f.catalog();
    expect(fresh.sources.sourceRevision).toBe(f.first.sources.sourceRevision + 1);
    expect(fresh.sources.channels[0]!.unit).toBe("new-unit");
    expect(fresh.sources.channels[0]!.channelId).not.toBe(f.first.sources.channels[0]!.channelId);
    expect(f.events.some((e) => e.kind === "devices.session" && e.data.sourcesChanged)).toBe(true);
    if (reservation.ok)
      expect(
        await f.broker.request(
          f.principal,
          "devices/recording/query",
          { reservationId: reservation.value.reservation.reservationId },
          f.signal,
        ),
      ).toMatchObject({
        ok: true,
        value: { reservation: { state: "ended", reason: "source-changed" } },
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await f.read(fresh.sources.channels.map((c) => c.channelId))).ok).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      receive.mock.calls.some(
        ([snapshot, sources]) =>
          sources.sourceRevision === fresh.sources.sourceRevision &&
          snapshot.frame?.values.some(
            (v: { channelId: string; value: number }) =>
              v.channelId === fresh.sources.channels[0]!.channelId && v.value === 42,
          ),
      ),
    ).toBe(true);
    expect((await f.catalog()).sources).toEqual(fresh.sources);
  } finally {
    await remove();
  }
});
it.each([false, true])(
  "A-final native loss closes the old EV3 record and permits fresh recovery (%s)",
  async (automatic) => {
    const f = await fixture(automatic);
    f.lose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.closes).toHaveBeenCalledOnce();
    expect(f.removed).toHaveBeenCalledOnce();
    const result = automatic
      ? await f.broker.reconnectForRecovery({ previousSessionId: f.sessionId, signal: f.signal })
      : await f.discoverConnect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sessionId =
      "session" in result.value ? result.value.session.sessionId : result.value.sessionId;
    expect(sessionId).not.toBe(f.sessionId);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect((await f.read()).ok).toBe(false);
    const next = await f.catalog(sessionId);
    expect(
      (
        await f.read(
          next.sources.channels.map((c) => c.channelId),
          sessionId,
        )
      ).ok,
    ).toBe(true);
    expect(f.modeWrites).not.toHaveBeenCalled();
  },
);
it("A-final clean pure suspend reopens the EV3 sampler without restoring the old reservation", async () => {
  const f = await fixture();
  const reservation = await f.broker.request(
    f.principal,
    "devices/recording/reserve",
    {
      sessionId: f.sessionId,
      channelIds: [f.first.sources.channels[0]!.channelId],
      expectedSourceRevision: f.first.sources.sourceRevision,
    },
    f.signal,
  );
  expect(reservation.ok).toBe(true);
  const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
  expect(await q.settled).toMatchObject({ stopConfirmed: true, journalCommitted: true });
  f.broker.sessions.resume(f.sessionId);
  expect((await f.catalog()).session.state).toBe("connected");
  expect(await f.read([f.first.sources.channels[0]!.channelId])).toMatchObject({
    ok: true,
    value: { status: "fresh", frame: { values: [{ value: 42 }] } },
  });
  if (reservation.ok)
    expect(
      f.broker.reservations.validate(
        f.principal.owner,
        reservation.value.reservation.reservationId,
      ),
    ).toBeNull();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.modeWrites).not.toHaveBeenCalled();
});

it.each(["pending", "failed"] as const)(
  "A-final native close %s blocks explicit and host recovery without replay",
  async (state) => {
    const f = await fixture(true);
    let release!: () => void;
    if (state === "pending")
      f.closes.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    else f.closes.mockRejectedValueOnce(new Error("native close failed"));
    f.lose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.closes).toHaveBeenCalledOnce();
    expect((await f.discoverConnect()).ok).toBe(false);
    expect(
      (await f.broker.reconnectForRecovery({ previousSessionId: f.sessionId, signal: f.signal }))
        .ok,
    ).toBe(false);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.closes).toHaveBeenCalledOnce();
    if (state === "pending") {
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await f.discoverConnect()).ok).toBe(true);
      expect(f.connect).toHaveBeenCalledTimes(2);
    } else {
      expect((await f.discoverConnect()).ok).toBe(false);
      expect(f.connect).toHaveBeenCalledOnce();
    }
  },
);
it("A-final suspend revokes old intent and keeps the session sample clock without old deliveries", async () => {
  const f = await fixture();
  const scope = f.broker.intent.bindMotionScope({
    owner: f.principal.owner,
    panelInstance: randomUUID(),
    contextRef: f.context,
    uiResourceGeneration: 1,
    workbenchInstance: f.core.workbenchInstance,
  });
  f.broker.intent.pulsePanel(scope, 1);
  f.broker.intent.beginGesture(scope, 1);
  const first = await f.read([f.first.sources.channels[0]!.channelId]);
  expect(first.ok).toBe(true);
  const subscription = await f.broker.request(
    f.principal,
    "devices/subscribe",
    {
      topic: "telemetry",
      sessionId: f.sessionId,
      channelIds: [f.first.sources.channels[0]!.channelId],
      intervalMs: 500,
    },
    f.signal,
  );
  expect(subscription.ok).toBe(true);
  if (subscription.ok) f.channel.activate(subscription.value.subscriptionId);
  const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
  await q.settled;
  f.broker.sessions.resume(f.sessionId);
  expect(() => f.broker.intent.beginGesture(scope, 2)).toThrow();
  const before = f.events.length;
  const fresh = await f.read([f.first.sources.channels[0]!.channelId]);
  expect(fresh.ok).toBe(true);
  if (first.ok && fresh.ok) {
    expect(fresh.value.frame!.sequence).toBeGreaterThan(first.value.frame!.sequence);
    expect(fresh.value.frame!.elapsedMs).toBeGreaterThanOrEqual(first.value.frame!.elapsedMs);
  }
  expect(f.events.slice(before).filter((e) => e.kind === "devices.telemetry")).toEqual([]);
});

it("A-final a pending mode query keeps wake closed until its original work settles", async () => {
  const f = await fixture();
  let release!: (value: Awaited<ReturnType<typeof f.modeQueries>>) => void;
  f.modeQueries.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const query = f.broker.request(
    f.principal,
    "devices/inputModes/query",
    {
      sessionId: f.sessionId,
      portId: "input:0",
      expectedSourceRevision: f.first.sources.sourceRevision,
    },
    f.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
  await q.settled;
  f.broker.sessions.resume(f.sessionId);
  expect(
    (await f.broker.request(f.principal, "devices/session", { sessionId: f.sessionId }, f.signal))
      .ok,
  ).toBe(false);
  release({ port: 0, type: 29, currentMode: 0, modes: [{ mode: 0, name: "Touch" }] });
  expect((await query).ok).toBe(false);
  f.broker.sessions.resume(f.sessionId);
  expect((await f.read()).ok).toBe(true);
});

it.each(["core-disconnect", "provider-loss", "provider-retired", "shutdown", "journal"] as const)(
  "A-final wake does not reopen mixed or unclean suspend: %s",
  async (cause) => {
    const f = await fixture();
    const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
    await q.settled;
    if (cause === "core-disconnect") {
      expect(
        f.broker.sessions.quiesce(f.sessionId, {
          reason: "core-disconnect",
          action: {
            actionToken: randomUUID(),
            scope: {
              hostEpoch: f.principal.owner.hostEpoch,
              workbenchInstance: f.core.workbenchInstance,
            },
          },
        }),
      ).toBe(q);
    } else if (cause === "provider-loss") f.lose();
    else if (cause === "provider-retired") f.unregister();
    else if (cause === "shutdown") await f.broker.resources.beginShutdown();
    else f.health.value = "unwritable";
    f.broker.sessions.resume(f.sessionId);
    expect(
      (await f.broker.request(f.principal, "devices/session", { sessionId: f.sessionId }, f.signal))
        .ok,
    ).toBe(false);
    expect((await f.read()).ok).toBe(false);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.modeWrites).not.toHaveBeenCalled();
    f.health.value = "ready";
  },
);
it("A-final suspend waits for the original sample and drops its late publication", async () => {
  const f = await fixture();
  let release!: (value: DeviceMonitorSnapshot) => void;
  f.monitor.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const read = f.read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
  const settled = vi.fn();
  const work = q.settled.then(settled);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
  f.broker.sessions.resume(f.sessionId);
  expect(
    (await f.broker.request(f.principal, "devices/session", { sessionId: f.sessionId }, f.signal))
      .ok,
  ).toBe(false);
  release(structuredClone(f.observed));
  expect((await read).ok).toBe(false);
  await work;
  f.broker.sessions.resume(f.sessionId);
  expect((await f.read()).ok).toBe(true);
});
it("A-final EV3 mode preflight still rejects an actually replaced source before any write", async () => {
  const f = await fixture();
  f.observed.inputs[0]!.type = 30;
  const result = await f.broker.request(
    f.principal,
    "devices/inputModes/set",
    {
      sessionId: f.sessionId,
      portId: "input:0",
      expectedSourceRevision: f.first.sources.sourceRevision,
      modeId: "mode:1",
      contextRef: f.context,
    },
    f.signal,
  );
  expect(result.ok).toBe(false);
  expect(f.modeWrites).not.toHaveBeenCalled();
  expect((await f.read()).ok).toBe(false);
  const fresh = await f.catalog();
  expect(fresh.sources.channels[0]!.typeId).toBe("ev3:30");
  expect(fresh.session.sourceRevision).toBe(fresh.sources.sourceRevision);
  expect((await f.read([fresh.sources.channels[0]!.channelId])).ok).toBe(true);
});
it("A-final a second observed change during reconciliation never publishes the mismatched frame", async () => {
  const f = await fixture();
  const intermediate = structuredClone(f.observed);
  intermediate.inputs[0]!.unit = "intermediate";
  f.observed.inputs[0]!.unit = "latest";
  f.monitor.mockResolvedValueOnce(intermediate);
  expect((await f.read()).ok).toBe(false);
  const fresh = await f.catalog();
  expect(fresh.sources.sourceRevision).toBe(f.first.sources.sourceRevision + 2);
  expect(fresh.sources.channels[0]!.unit).toBe("latest");
  expect(await f.read([fresh.sources.channels[0]!.channelId])).toMatchObject({
    ok: true,
    value: {
      frame: {
        sourceRevision: fresh.sources.sourceRevision,
        values: [{ channelId: fresh.sources.channels[0]!.channelId, value: 42 }],
      },
    },
  });
  f.observed.inputs[0]!.unit = "raw";
  expect((await f.read([fresh.sources.channels[0]!.channelId])).ok).toBe(false);
  const reverted = await f.catalog();
  expect(reverted.sources.channels[0]!.channelId).not.toBe(f.first.sources.channels[0]!.channelId);
  expect((await f.read([f.first.sources.channels[0]!.channelId])).ok).toBe(false);
});
it("A-final configured USB timer reconnects through the real EV3 provider without old rights", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture(true);
    f.lose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.connect).toHaveBeenCalledTimes(2);
    const list = await f.broker.request(f.principal, "devices/list", {}, f.signal);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const next = list.value.sessions[0]!;
    expect(next.sessionId).not.toBe(f.sessionId);
    const catalog = await f.catalog(next.sessionId);
    expect((await f.read([catalog.sources.channels[0]!.channelId], next.sessionId)).ok).toBe(true);
    expect((await f.read()).ok).toBe(false);
    expect(f.modeWrites).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["pending", "reject"] as const)(
  "A-final original native close is bounded and cannot be retried into false success: %s",
  async (outcome) => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      const original = await f.providerConnect.mock.results[0]!.value;
      let release!: () => void, reject!: (error: Error) => void;
      f.closes.mockImplementationOnce(
        () =>
          new Promise<void>((done, fail) => {
            release = done;
            reject = fail;
          }),
      );
      f.lose();
      const cleanup = () =>
        createContexts({
          id: randomUUID(),
          sessionId: f.sessionId,
          generation: 1,
          operationClass: "connection",
          deadline: performance.now() + 60000,
          now: () => performance.now(),
          lane: new ExchangeLane(() => performance.now()),
          check() {},
          progress() {},
          onStop() {},
        }).cleanup;
      const settled = vi.fn();
      const close = f.provider.disconnect(original.value!.key, cleanup()).then(settled);
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).not.toHaveBeenCalled();
      expect((await f.discoverConnect()).ok).toBe(false);
      if (outcome === "reject") reject(new Error("native close failed"));
      await vi.advanceTimersByTimeAsync(1);
      await close;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          stopConfirmation: "unconfirmed",
          error: expect.objectContaining({ reason: "connection-lost" }),
        }),
      );
      expect((await f.provider.disconnect(original.value!.key, cleanup())).error).not.toBeNull();
      await expect(f.provider.dispose(cleanup())).rejects.toThrow();
      expect((await f.discoverConnect()).ok).toBe(false);
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.closes).toHaveBeenCalledOnce();
      expect(() => f.provider.describe(original.value!.key)).toThrow("disconnected");
      if (outcome === "pending") {
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect((await f.discoverConnect()).ok).toBe(true);
        expect(f.connect).toHaveBeenCalledTimes(2);
        expect(() => f.provider.describe(original.value!.key)).toThrow("disconnected");
      }
    } finally {
      vi.useRealTimers();
    }
  },
);
it("A-final a timed-out suspend cannot renew its sample drain or reopen on late reply", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture();
    let release!: (value: DeviceMonitorSnapshot) => void;
    f.monitor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const read = f.read();
    await vi.advanceTimersByTimeAsync(0);
    const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
    const work = q.settled;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await work).toMatchObject({ stopConfirmed: false });
    expect(f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" })).toBe(q);
    expect(await q.settled).toMatchObject({ stopConfirmed: false });
    release(structuredClone(f.observed));
    expect((await read).ok).toBe(false);
    f.broker.sessions.resume(f.sessionId);
    expect(
      (await f.broker.request(f.principal, "devices/session", { sessionId: f.sessionId }, f.signal))
        .ok,
    ).toBe(false);
    expect(f.connect).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("A-final real coordinator resumes clean EV3 admission after the original legacy flush", async () => {
  const f = await fixture();
  let finishFlush!: () => void;
  const legacyFlush = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      }),
  );
  const persistence = createResourceFreePersistence(() => true);
  const shutdown = vi.fn(async () => {});
  const coordinator = new LifecycleCoordinator({
    ports: { device: f.broker.resources, persistence, ui: unavailableUi150() },
    resources: f.broker.resources,
    sessions: f.broker.sessions,
    reservations: f.broker.reservations,
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive: () => true,
    owners: () => [f.principal.owner],
    now: () => performance.now(),
    shutdown,
    legacyFlush,
    report: vi.fn(),
  });
  try {
    const before = await f.read();
    expect(before.ok).toBe(true);
    const suspend = coordinator.suspend(f.sessionId);
    const resume = coordinator.resume(f.sessionId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      (await f.broker.request(f.principal, "devices/session", { sessionId: f.sessionId }, f.signal))
        .ok,
    ).toBe(false);
    finishFlush();
    await Promise.all([suspend, resume]);
    expect((await f.catalog()).session.state).toBe("connected");
    const fresh = await f.read([f.first.sources.channels[0]!.channelId]);
    expect(fresh).toMatchObject({
      ok: true,
      value: { status: "fresh", frame: { values: [{ value: 42 }] } },
    });
    if (fresh.ok && before.ok)
      expect(fresh.value.frame!.sequence).toBeGreaterThan(before.value.frame!.sequence);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.modeWrites).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(legacyFlush).toHaveBeenCalledExactlyOnceWith("suspend");
  } finally {
    coordinator.dispose();
  }
});

it("A-final wake joins later explicit recovery through the final journal commit without replay", async () => {
  const f = await fixture();
  const q = f.broker.sessions.quiesce(f.sessionId, { reason: "suspended" });
  await q.settled;
  let finishCommit!: () => void;
  const commit = f.commit.getMockImplementation()!;
  f.commit.mockImplementationOnce(commit).mockImplementationOnce(async (next) => {
    await new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    await commit(next);
  });
  const recovery = f.broker.stopCurrentDevice({
    sessionId: f.sessionId,
    action: {
      actionToken: randomUUID(),
      scope: {
        hostEpoch: f.principal.owner.hostEpoch,
        workbenchInstance: f.core.workbenchInstance,
      },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.motorStop).toHaveBeenCalledTimes(4);
  f.broker.sessions.resume(f.sessionId);
  expect(
    (await f.broker.request(f.principal, "devices/session", { sessionId: f.sessionId }, f.signal))
      .ok,
  ).toBe(false);
  const settled = vi.fn();
  const receipt = q.settled.then(settled);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
  finishCommit();
  expect((await recovery).ok).toBe(true);
  await receipt;
  expect(settled).toHaveBeenCalledExactlyOnceWith({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
  f.broker.sessions.resume(f.sessionId);
  expect((await f.read()).ok).toBe(true);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.motorStop).toHaveBeenCalledTimes(4);
  expect(f.commit).toHaveBeenCalledTimes(2);
});

// Retained independent review regressions: the same real broker/EV3 fixture.
it("A-finalfix2 ABA observed before broker publication cannot revive an old handle", async () => {
  const f = await fixture();
  const oldId = f.first.sources.channels[0]!.channelId;
  const intermediate = structuredClone(f.observed);
  intermediate.inputs[0]!.unit = "intermediate";
  // provider.read observes B; provider.sources observes A again, before either
  // generation has reached the broker's retained catalog.
  f.monitor.mockResolvedValueOnce(intermediate);
  expect((await f.read([oldId])).ok).toBe(false);
  const after = await f.catalog();
  const oldRead = await f.read([oldId]);
  expect(after.sources.sourceRevision).toBe(f.first.sources.sourceRevision + 2);
  expect.soft(after.sources.channels[0]!.channelId).not.toBe(oldId);
  expect.soft(oldRead.ok).toBe(false);
});

it("A-finalfix2 real coordinator wake observes completed later recovery", async () => {
  const f = await fixture();
  const persistence = createResourceFreePersistence(() => true);
  const coordinator = new LifecycleCoordinator({
    ports: { device: f.broker.resources, persistence, ui: unavailableUi150() },
    resources: f.broker.resources,
    sessions: f.broker.sessions,
    reservations: f.broker.reservations,
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive: () => true,
    owners: () => [f.principal.owner],
    now: () => performance.now(),
    shutdown: vi.fn(async () => {}),
    legacyFlush: vi.fn(async () => {}),
    report: vi.fn(),
  });
  try {
    await coordinator.suspend(f.sessionId);
    const recovery = await f.broker.stopCurrentDevice({
      sessionId: f.sessionId,
      action: {
        actionToken: randomUUID(),
        scope: {
          hostEpoch: f.principal.owner.hostEpoch,
          workbenchInstance: f.core.workbenchInstance,
        },
      },
    });
    expect(recovery.ok).toBe(true);
    expect(f.commit).toHaveBeenCalledTimes(2);
    await coordinator.resume(f.sessionId);
    const after = await f.broker.request(
      f.principal,
      "devices/session",
      { sessionId: f.sessionId },
      f.signal,
    );
    await coordinator.resume(f.sessionId);
    const retry = await f.read();
    expect.soft(after.ok).toBe(true);
    expect.soft(retry.ok).toBe(true);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.motorStop).toHaveBeenCalledTimes(4);
  } finally {
    coordinator.dispose();
  }
});

function wakeFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const persistence = createResourceFreePersistence(() => true);
  const legacyFlush = vi.fn(async () => {}),
    shutdown = vi.fn(async () => {});
  const quiesce = vi.spyOn(f.broker.sessions, "quiesce");
  const coordinator = new LifecycleCoordinator({
    ports: { device: f.broker.resources, persistence, ui: unavailableUi150() },
    resources: f.broker.resources,
    sessions: f.broker.sessions,
    reservations: f.broker.reservations,
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive: () => true,
    owners: () => [f.principal.owner],
    now: () => performance.now(),
    shutdown,
    legacyFlush,
    report: vi.fn(),
  });
  onTestFinished(() => coordinator.dispose());
  return { coordinator, legacyFlush, shutdown, quiesce };
}
function heldRecovery(f: Awaited<ReturnType<typeof fixture>>, fail = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = f.commit.getMockImplementation()!;
  f.commit.mockImplementationOnce(commit).mockImplementationOnce(async (next) => {
    await gate;
    if (fail) {
      f.health.value = "unwritable";
      throw new Error("journal failed");
    }
    await commit(next);
  });
  const work = f.broker.stopCurrentDevice({
    sessionId: f.sessionId,
    action: {
      actionToken: randomUUID(),
      scope: {
        hostEpoch: f.principal.owner.hostEpoch,
        workbenchInstance: f.core.workbenchInstance,
      },
    },
  });
  return { work, release };
}
it.each(["clean", "core-disconnect", "provider-loss", "journal-failure"] as const)(
  "A-finalfix2 coordinator wake joins overlapping final recovery commit: %s",
  async (cause) => {
    const f = await fixture(),
      w = wakeFixture(f);
    await w.coordinator.suspend(f.sessionId);
    const original = w.quiesce.mock.results[0]!.value;
    const recovery = heldRecovery(f, cause === "journal-failure");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.commit).toHaveBeenCalledTimes(2);
      expect(f.motorStop).toHaveBeenCalledTimes(4);
      const settled = vi.fn();
      const wake = w.coordinator.resume(f.sessionId);
      expect(w.coordinator.resume(f.sessionId)).toBe(wake);
      void wake.then(settled, settled);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      expect(
        (
          await f.broker.request(
            f.principal,
            "devices/session",
            { sessionId: f.sessionId },
            f.signal,
          )
        ).ok,
      ).toBe(false);
      if (cause === "core-disconnect") {
        expect(
          f.broker.sessions.quiesce(f.sessionId, {
            reason: "core-disconnect",
            action: {
              actionToken: randomUUID(),
              scope: {
                hostEpoch: f.principal.owner.hostEpoch,
                workbenchInstance: f.core.workbenchInstance,
              },
            },
          }),
        ).toBe(original);
      } else if (cause === "provider-loss") f.lose();
      recovery.release();
      expect((await recovery.work).ok).toBe(cause !== "journal-failure");
      if (cause === "clean") {
        await wake;
        expect((await f.read()).ok).toBe(true);
        await w.coordinator.resume(f.sessionId);
      } else {
        await expect(wake).rejects.toThrow();
        await expect(w.coordinator.resume(f.sessionId)).rejects.toThrow();
        expect((await f.read()).ok).toBe(false);
      }
      expect(w.quiesce).toHaveBeenCalledTimes(cause === "core-disconnect" ? 2 : 1);
      expect(w.legacyFlush).toHaveBeenCalledExactlyOnceWith("suspend");
      expect(w.shutdown).not.toHaveBeenCalled();
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.motorStop).toHaveBeenCalledTimes(4);
    } finally {
      recovery.release();
      await recovery.work;
      f.health.value = "ready";
    }
  },
);
it("A-finalfix2 recovery starting at the resume boundary is joined through the same receipt", async () => {
  const f = await fixture(),
    w = wakeFixture(f);
  await w.coordinator.suspend(f.sessionId);
  const resume = f.broker.sessions.resume.bind(f.broker.sessions);
  let recovery: ReturnType<typeof heldRecovery> | undefined;
  vi.spyOn(f.broker.sessions, "resume").mockImplementationOnce((id) => {
    recovery = heldRecovery(f);
    resume(id);
  });
  const settled = vi.fn();
  const wake = w.coordinator.resume(f.sessionId);
  void wake.then(settled, settled);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recovery).toBeDefined();
    expect(settled).not.toHaveBeenCalled();
    expect((await f.read()).ok).toBe(false);
    recovery!.release();
    expect((await recovery!.work).ok).toBe(true);
    await wake;
    expect((await f.read()).ok).toBe(true);
    expect(w.quiesce).toHaveBeenCalledOnce();
    expect(w.legacyFlush).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledTimes(2);
  } finally {
    recovery?.release();
    await recovery?.work;
  }
});
it.each(["settled", "pending-recovery"] as const)(
  "A-finalfix2 coordinator long sleep keeps original deadlines and a retryable receipt: %s",
  async (state) => {
    vi.useFakeTimers();
    let recovery: ReturnType<typeof heldRecovery> | undefined;
    try {
      const f = await fixture(),
        w = wakeFixture(f);
      await w.coordinator.suspend(f.sessionId);
      await vi.advanceTimersByTimeAsync(60000);
      if (state === "pending-recovery") {
        recovery = heldRecovery(f);
        await vi.advanceTimersByTimeAsync(0);
        const wake = w.coordinator.resume(f.sessionId);
        const expired = expect(wake).rejects.toThrow("observation deadline");
        await vi.advanceTimersByTimeAsync(0);
        await expired;
        expect((await f.read()).ok).toBe(false);
        const again = expect(w.coordinator.resume(f.sessionId)).rejects.toThrow(
          "observation deadline",
        );
        await vi.advanceTimersByTimeAsync(0);
        await again;
        expect(w.quiesce).toHaveBeenCalledOnce();
        expect(f.commit).toHaveBeenCalledTimes(2);
        recovery.release();
        expect((await recovery.work).ok).toBe(true);
      }
      await w.coordinator.resume(f.sessionId);
      expect((await f.read()).ok).toBe(true);
      expect(w.quiesce).toHaveBeenCalledOnce();
      expect(w.legacyFlush).toHaveBeenCalledExactlyOnceWith("suspend");
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.modeWrites).not.toHaveBeenCalled();
      expect(f.stop).toHaveBeenCalledTimes(state === "settled" ? 0 : 1);
      expect(f.motorStop).toHaveBeenCalledTimes(state === "settled" ? 0 : 4);
    } finally {
      recovery?.release();
      await recovery?.work;
      vi.useRealTimers();
    }
  },
);
it("A-finalfix2 wake observation expires at original suspend +20s, not wake +20s", async () => {
  vi.useFakeTimers();
  let recovery: ReturnType<typeof heldRecovery> | undefined;
  try {
    const f = await fixture(),
      w = wakeFixture(f);
    await w.coordinator.suspend(f.sessionId);
    await vi.advanceTimersByTimeAsync(19000);
    recovery = heldRecovery(f);
    await vi.advanceTimersByTimeAsync(0);
    const wake = w.coordinator.resume(f.sessionId);
    const expired = expect(wake).rejects.toThrow("observation deadline");
    await vi.advanceTimersByTimeAsync(999);
    expect((await f.read()).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expired;
    recovery.release();
    expect((await recovery.work).ok).toBe(true);
    await w.coordinator.resume(f.sessionId);
    expect((await f.read()).ok).toBe(true);
    expect(w.quiesce).toHaveBeenCalledOnce();
    expect(w.legacyFlush).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledTimes(2);
  } finally {
    recovery?.release();
    await recovery?.work;
    vi.useRealTimers();
  }
});
it.each(["type", "mode", "removed", "component", "actuator"] as const)(
  "A-finalfix2 unpublished replacement generations stay stable without historical IDs: %s",
  async (change) => {
    const f = await fixture();
    let previous = f.first;
    for (let round = 0; round < 3; round++) {
      const intermediate = structuredClone(f.observed);
      if (change === "type") intermediate.inputs[0]!.type = 30;
      else if (change === "mode") intermediate.inputs[0]!.mode = 1;
      else if (change === "removed") intermediate.inputs = [];
      else if (change === "component") intermediate.inputs[0]!.values = [];
      else intermediate.outputs[0]!.type = 8;
      const index = change === "actuator" ? 1 : 0;
      const oldId = previous.sources.channels[index]!.channelId;
      f.monitor.mockResolvedValueOnce(intermediate);
      expect((await f.read([oldId])).ok).toBe(false);
      const current = await f.catalog();
      expect(current.sources.sourceRevision).toBe(previous.sources.sourceRevision + 2);
      const channel = current.sources.channels[index]!;
      expect(channel.channelId).not.toBe(oldId);
      expect((await f.read([oldId])).ok).toBe(false);
      const tuple = {
        sessionId: f.sessionId,
        portId: channel.portId,
        typeId: channel.typeId,
        modeId: channel.modeId,
        component: channel.component,
        unit: channel.unit,
      };
      expect(f.catalogPort.identify(tuple)).toBe(channel.channelId);
      expect(f.catalogPort.identify(tuple)).toBe(channel.channelId);
      expect((await f.read([channel.channelId])).ok).toBe(true);
      expect((await f.catalog()).sources).toEqual(current.sources);
      expect(current.sources.channels.at(-1)!.channelId).toBe(
        f.first.sources.channels.at(-1)!.channelId,
      );
      if (change === "actuator")
        expect(current.sources.actuators[0]!.actuatorId).not.toBe(
          previous.sources.actuators[0]!.actuatorId,
        );
      previous = current;
    }
  },
);
