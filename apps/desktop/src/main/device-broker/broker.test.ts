import { expect, it } from "vitest";
import type { DeviceBrokerOptions } from "./broker-port.js";
import { createBroker } from "./broker.js";
const factories: Parameters<typeof createBroker>[1] = {
  recovery: ({ journal }) => ({
    snapshot: () => journal.snapshot(),
    subscribe: (listener) => journal.subscribe(listener),
    async stopCurrent() {
      throw new Error("W1 recovery double cannot close P150");
    },
    async reconcile() {
      throw new Error("W1 recovery double cannot close P150");
    },
    async clearResolved() {
      throw new Error("W1 recovery double cannot close P150");
    },
  }),
  participant: (driver) => ({
    retire: (owner, reason) => driver.revokeOwner(owner, reason),
    async retireProvider(id, generation) {
      const all = await Promise.all(driver.revokeProvider(id, generation));
      return {
        stopConfirmed: all.every((x) => x.stopConfirmed),
        journalCommitted: all.every((x) => x.journalCommitted),
        faultIds: all.flatMap((x) => x.faultIds),
      };
    },
    async beginShutdown() {
      const all = await Promise.all(driver.revokeAll());
      return {
        stopConfirmed: all.every((x) => x.stopConfirmed),
        journalCommitted: all.every((x) => x.journalCommitted),
        faultIds: all.flatMap((x) => x.faultIds),
      };
    },
  }),
};
const createDeviceBroker = (input: DeviceBrokerOptions) => createBroker(input, factories);
import { operationHarness, pluginPrincipal, ID } from "./fake-provider.js";
const signal = () => new AbortController().signal;
function setup(
  allowed = true,
  overrides: Partial<
    Pick<DeviceBrokerOptions, "requirements" | "operationGate" | "connectionPolicy">
  > = {},
) {
  const h = operationHarness();
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
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
    hasPermission: () => allowed,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
    ...overrides,
  });
  const unregister = broker.registerProvider(h.provider);
  return { ...h, broker, unregister };
}
it("F03 permissions fail without I/O; F20 secondary creates no provider work", async () => {
  const h = setup(false);
  const result = await h.broker.request(
    pluginPrincipal(),
    "devices/discover",
    { providerId: h.provider.id },
    signal(),
  );
  expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED" } });
  expect(h.provider.calls).toEqual([]);
  expect(() =>
    createDeviceBroker({
      journal: h.dependencies.journal,
      profile: {
        hostEpoch: ID,
        assertHeld() {
          throw new Error("secondary");
        },
      },
      now: () => 0,
      authority: { current: () => null, assertContinuation() {}, subscribe: () => () => {} },
      coreActions: { claim: () => false, isClaimed: () => false, complete() {} },
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
    }),
  ).toThrow("secondary");
});
it("F02 reconnect issues a new session; old owner cannot use candidate/session", async () => {
  const h = setup(),
    p = pluginPrincipal();
  const discovered = await h.broker.request(
    p,
    "devices/discover",
    { providerId: h.provider.id },
    signal(),
  );
  if (!discovered.ok) throw new Error("discover failed");
  const candidateId = discovered.value.candidates[0]!.candidateId;
  expect(
    await h.broker.request(
      pluginPrincipal(2),
      "devices/connect",
      { target: { kind: "candidate", candidateId } },
      signal(),
    ),
  ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
  const connected = await h.broker.request(
    p,
    "devices/connect",
    { target: { kind: "candidate", candidateId } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect failed");
  const first = connected.value.session.sessionId;
  h.provider.lose();
  const next = await h.broker.request(
    p,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!next.ok) throw new Error("reconnect failed");
  expect(next.value.session.sessionId).not.toBe(first);
  expect(
    await h.broker.request(
      p,
      "devices/read",
      { sessionId: first, channelIds: [ID], freshness: "fresh" },
      signal(),
    ),
  ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
});
it("F07 public disconnect is busy while a retained file plan owns foreground", async () => {
  const h = setup(),
    p = pluginPrincipal();
  const connected = await h.broker.request(
    p,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect failed");
  const sessionId = connected.value.session.sessionId;
  const operation = await h.broker.begin({
    principal: p,
    sessionId,
    operationClass: "file-read",
    signal: signal(),
  });
  expect(await h.broker.request(p, "devices/disconnect", { sessionId }, signal())).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_DEVICE_BUSY" },
  });
  await operation.execute({ kind: "list", remotePath: "/home/root/lms2012/prjs" });
  await operation.finish();
  expect((await h.broker.request(p, "devices/disconnect", { sessionId }, signal())).ok).toBe(true);
});

it("F11 retained journal snapshot is available with all optional providers absent", () => {
  const h = operationHarness();
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => null,
      assertContinuation() {
        throw new Error("unbound");
      },
      subscribe: () => () => {},
    },
    coreActions: { claim: () => false, isClaimed: () => false, complete() {} },
    hasPermission: () => false,
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
  expect(broker.recovery.snapshot().journalHealth).toBe("ready");
  expect(h.provider.calls).toEqual([]);
});
it("F19 quiesce keeps one action claim and does not retire the healthy consumer", async () => {
  const h = setup(),
    p = pluginPrincipal();
  const result = await h.broker.request(
    p,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!result.ok) throw new Error("connect failed");
  const sessionId = result.value.session.sessionId;
  const action = { actionToken: ID, scope: { hostEpoch: ID, workbenchInstance: ID } };
  const first = h.broker.sessions.quiesce(sessionId, { reason: "core-disconnect", action });
  expect(h.broker.sessions.quiesce(sessionId, { reason: "core-disconnect", action })).toBe(first);
  h.setNow(6000);
  expect((await h.broker.sessions.disconnect(sessionId, action)).ok).toBe(true);
  expect((await h.broker.request(p, "devices/list", {}, signal())).ok).toBe(true);
});
it("F18 F20 a resource-free shutdown does not fabricate faults or construct transport", async () => {
  const h = setup();
  expect(await h.broker.resources.beginShutdown()).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
  expect(h.provider.calls).toEqual([]);
});

it.each([
  [[], true],
  [[{ capability: "connection.v1", required: true }], true],
  [[{ capability: "connection.v2", required: true }], false],
  [[{ capability: "connection.v2", required: false }], true],
  [[{ capability: "telemetry.v1", required: false }], true],
] as const)("generation-bound requirements %j", async (requirements, satisfied) => {
  const h = setup(true, {
    requirements: (owner) => (owner.generation === 1 ? requirements : null),
  });
  const result = await h.broker.request(pluginPrincipal(), "devices/negotiate", {}, signal());
  expect(result).toMatchObject({ ok: true, value: { requirementsSatisfied: satisfied } });
  if (result.ok && requirements.some((row) => row.capability === "connection.v2"))
    expect(result.value.capabilities).toContainEqual({
      capability: "connection.v2",
      state: "unsupported",
      providerId: null,
    });
  expect(
    await h.broker.request(pluginPrincipal(2), "devices/negotiate", {}, signal()),
  ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
  expect(h.provider.calls).toEqual([]);
});
it("provider absence never enables it and an empty manifest differs from an unknown owner", async () => {
  const h = setup(true, { requirements: () => [] });
  expect((await h.broker.request(pluginPrincipal(), "devices/negotiate", {}, signal())).ok).toBe(
    true,
  );
  h.unregister();
  const disabled = await h.broker.request(pluginPrincipal(), "devices/negotiate", {}, signal());
  expect(disabled).toMatchObject({ ok: true, value: { requirementsSatisfied: true } });
  if (disabled.ok)
    expect(disabled.value.capabilities.every((row) => row.state === "provider-unavailable")).toBe(
      true,
    );
  const unknown = setup(true, { requirements: () => null });
  expect(
    await unknown.broker.request(pluginPrincipal(), "devices/negotiate", {}, signal()),
  ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
});
it("channel owner is bound before subscription and disposal removes its ledger rows", async () => {
  const h = setup(),
    principal = pluginPrincipal(),
    sent: unknown[] = [];
  const channel = h.broker.attachChannel({
    owner: principal.owner,
    principal: () => principal,
    send: (event) => sent.push(event),
  });
  channel.negotiated("devices", 1);
  const result = await h.broker.request(
    principal,
    "devices/subscribe",
    { topic: "catalog" },
    signal(),
  );
  if (!result.ok) throw new Error("subscribe failed");
  const id = result.value.subscriptionId;
  h.broker.events.publish(
    principal.owner,
    id,
    { kind: "devices.catalog", data: { revision: 1, providers: [], sessions: [] } },
    "control",
  );
  expect(sent).toEqual([]);
  channel.activate(id);
  expect(sent).toHaveLength(1);
  channel.dispose();
  expect(h.broker.events.owns(principal.owner, id)).toBe(false);
});

import { vi } from "vitest";
import type { Stage3EventEnvelope } from "@kobrixa/plugin-runtime";
import { createFakeDeviceProvider } from "./fake-provider.js";
it("catalog changes are produced synchronously and disposed with the channel", () => {
  const h = setup(),
    p = pluginPrincipal(),
    sent: unknown[] = [];
  const attachment = h.broker.attachChannel({
    owner: p.owner,
    principal: () => p,
    send: (event) => sent.push(event),
  });
  attachment.negotiated("devices", 1);
  return h.broker.request(p, "devices/subscribe", { topic: "catalog" }, signal()).then((result) => {
    if (!result.ok) throw new Error("subscribe");
    attachment.activate(result.value.subscriptionId);
    h.unregister();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "devices.catalog", data: { providers: [] } });
    attachment.dispose();
    expect(h.broker.events.diagnostics().subscriptions).toBe(0);
  });
});
it("provider catalog freezes policy during connect and validates full tuples", async () => {
  let timeout: 3000 | 5000 = 3000;
  const h = setup(true, {
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: timeout,
      wifiHandshakeTimeoutMs: 1000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  h.unregister();
  const catalog = h.broker.providerCatalog(h.provider.id);
  const { provider } = createFakeDeviceProvider({ catalog, now: h.dependencies.now });
  expect(() =>
    catalog.identify({
      sessionId: ID,
      portId: "1",
      typeId: "29",
      modeId: "0",
      component: 0,
      unit: "%",
    }),
  ).toThrow();
  const original = provider.connect.bind(provider);
  provider.connect = async (target, ctx) => {
    timeout = 5000;
    expect(catalog.connectionPolicy().wifiConnectTimeoutMs).toBe(3000);
    return original(target, ctx);
  };
  const unregister = h.broker.registerProvider(provider);
  const connected = await h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: provider.id, address: "127.0.0.1" } },
    signal(),
  );
  expect(connected.ok).toBe(true);
  if (!connected.ok) return;
  const tuple = {
    sessionId: connected.value.session.sessionId,
    portId: null,
    typeId: "battery",
    modeId: null,
    component: 0,
    unit: "",
  };
  expect(catalog.identify(tuple)).toBe(catalog.identify(tuple));
  expect(() => catalog.identify({ ...tuple, unit: "\u0000" })).toThrow();
  expect(() => catalog.identify({ ...tuple, sessionId: ID })).toThrow();
  unregister();
  expect(() => catalog.identify(tuple)).toThrow();
});
it("connection cancellation blocks a delayed exchange dispatch", async () => {
  const h = setup();
  h.unregister();
  const catalog = h.broker.providerCatalog(h.provider.id),
    fake = createFakeDeviceProvider({ catalog, now: h.dependencies.now });
  h.broker.registerProvider(fake.provider);
  fake.control.block("before-exchange", "connect");
  const abort = new AbortController();
  const pending = h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    abort.signal,
  );
  await fake.control.reached("before-exchange", "connect");
  abort.abort();
  fake.control.release("before-exchange", "connect");
  expect((await pending).ok).toBe(false);
  expect(fake.control.trace().filter((row) => row.dispatch === "sent")).toEqual([]);
});
it("core telemetry enforces shared owner subscription limits and disposes on workbench loss", async () => {
  vi.useFakeTimers();
  try {
    let live = true;
    const h = setup();
    const p = {
      kind: "core" as const,
      adapter: "monitor" as const,
      hostEpoch: ID,
      workbenchInstance: ID,
      authorityContext: { ref: ID, epoch: ID },
    };
    // Use the same authority projection as production for core workbench liveness.
    const broker = createBroker(
      {
        ...h.dependencies,
        authority: {
          current: () =>
            live
              ? {
                  ref: ID,
                  epoch: ID,
                  workbenchInstance: ID,
                  state: "local" as const,
                  roomBinding: null,
                  connected: false,
                  synced: true,
                  role: null,
                  isHolder: true,
                }
              : null,
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
      },
      factories,
    );
    broker.registerProvider(h.provider);
    const connected = await broker.request(
      p,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
      signal(),
    );
    if (!connected.ok) throw new Error("connect");
    const receive = vi.fn(),
      input = {
        principal: p,
        sessionId: connected.value.session.sessionId,
        channelIds: [ID],
        intervalMs: 500 as const,
        receive,
      };
    const demands = await Promise.all(
      Array.from({ length: 32 }, () => broker.subscribeCoreTelemetry(input)),
    );
    await expect(broker.subscribeCoreTelemetry(input)).rejects.toThrow();
    await demands[0]!.dispose();
    for (const demand of demands) demand.activate();
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenCalled();
    receive.mockClear();
    live = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(receive).not.toHaveBeenCalled();
    await broker.resources.beginShutdown();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("gate loss during a file chunk prevents the next chunk but preserves exactly one close", async () => {
  let permitted = true;
  const h = setup(true, {
    operationGate: () =>
      permitted
        ? { ok: true, value: null }
        : {
            ok: false,
            error: {
              code: "PLUGIN_E_DISABLED",
              message: "disabled",
              detail: {
                kind: "device",
                reason: "disabled",
                dispatch: "not-sent",
                stopConfirmation: "not-required",
              },
            },
          },
  });
  h.unregister();
  const fake = createFakeDeviceProvider({
    catalog: h.broker.providerCatalog(h.provider.id),
    now: h.dependencies.now,
  });
  h.broker.registerProvider(fake.provider);
  const p = pluginPrincipal(),
    connected = await h.broker.request(
      p,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: fake.provider.id, address: "127.0.0.1" } },
      signal(),
    );
  if (!connected.ok) throw new Error("connect");
  const operation = await h.broker.begin({
    principal: p,
    sessionId: connected.value.session.sessionId,
    operationClass: "file-write",
    signal: signal(),
  });
  fake.control.block("after-exchange", "file-chunk");
  const pending = operation.execute({
    kind: "upload",
    remotePath: "test",
    size: 2,
    chunks: (async function* () {
      yield new Uint8Array([1]);
      yield new Uint8Array([2]);
    })(),
    progress() {},
  });
  const rejected = expect(pending).rejects.toThrow();
  await fake.control.reached("after-exchange", "file-chunk");
  permitted = false;
  fake.control.release("after-exchange", "file-chunk");
  await rejected;
  await operation.cancel();
  const sent = fake.control.trace().filter((row) => row.dispatch === "sent");
  expect(sent.filter((row) => row.step === "file-chunk")).toHaveLength(1);
  expect(sent.filter((row) => row.step === "file-close")).toHaveLength(1);
});
it("USB loss schedules a fresh serial-only reconnect with no operation replay", async () => {
  vi.useFakeTimers();
  try {
    const h = setup(true, {
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 5000,
        wifiHandshakeTimeoutMs: 3000,
        usbAutoReconnect: true,
        usbRetryInterval: 1000,
        usbRetryLimit: 3,
      }),
    });
    h.provider.describe = () => ({
      key: h.provider.session,
      descriptor: { ...h.provider.descriptor, transport: "usb" },
      physical: h.provider.physical,
      capabilities: [...h.provider.capabilities],
    });
    h.provider.discover = async (ctx) =>
      ctx.exchange("discover", async () => ({
        value: [
          {
            key: h.provider.candidate,
            descriptor: { ...h.provider.descriptor, transport: "usb" },
            physical: h.provider.physical,
          },
        ],
        dispatch: "not-sent",
        stopConfirmation: "not-required",
        error: null,
      }));
    const first = await h.broker.request(
      pluginPrincipal(),
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
      signal(),
    );
    if (!first.ok) throw new Error("connect");
    h.provider.lose();
    await vi.advanceTimersByTimeAsync(1000);
    const listed = await h.broker.request(pluginPrincipal(), "devices/list", {}, signal());
    if (!listed.ok) throw new Error("list");
    expect(listed.value.sessions[0]?.state).toBe("connected");
    expect(listed.value.sessions[0]?.sessionId).not.toBe(first.value.session.sessionId);
    expect(
      h.provider.calls.filter((call) => ["motion", "upload", "run", "stop"].includes(call)),
    ).toEqual([]);
    await h.broker.resources.beginShutdown();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it.each(["duplicate", "changed"])("USB recovery rejects %s serial evidence", async (kind) => {
  const h = setup(true, {
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: true,
      usbRetryInterval: 1000,
      usbRetryLimit: 3,
    }),
  });
  h.provider.describe = () => ({
    key: h.provider.session,
    descriptor: { ...h.provider.descriptor, transport: "usb" },
    physical: h.provider.physical,
    capabilities: [...h.provider.capabilities],
  });
  const connected = await h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect");
  h.provider.lose();
  const candidate = {
    key: h.provider.candidate,
    descriptor: { ...h.provider.descriptor, transport: "usb" as const },
    physical: {
      ...h.provider.physical,
      digest: kind === "changed" ? "b".repeat(64) : h.provider.physical.digest,
    },
  };
  h.provider.discover = async () => ({
    value: kind === "duplicate" ? [candidate, candidate] : [candidate],
    dispatch: "not-sent",
    stopConfirmation: "not-required",
    error: null,
  });
  expect(
    (
      await h.broker.reconnectForRecovery({
        previousSessionId: connected.value.session.sessionId,
        signal: signal(),
      })
    ).ok,
  ).toBe(false);
  await h.broker.resources.beginShutdown();
});

it("retained legacy cancellation owns the lane until file-close settles", async () => {
  const h = setup();
  h.unregister();
  const fake = createFakeDeviceProvider({
    catalog: h.broker.providerCatalog(h.provider.id),
    now: h.dependencies.now,
  });
  h.broker.registerProvider(fake.provider);
  const principal = pluginPrincipal(),
    connected = await h.broker.request(
      principal,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: fake.provider.id, address: "127.0.0.1" } },
      signal(),
    );
  if (!connected.ok) throw new Error("connect");
  const input = {
      principal,
      sessionId: connected.value.session.sessionId,
      operationClass: "file-write" as const,
      signal: signal(),
    },
    operation = await h.broker.begin(input);
  fake.control.block("after-exchange", "file-chunk");
  fake.control.block("before-exchange", "file-close");
  const work = operation.execute({
    kind: "upload",
    remotePath: "test",
    size: 1,
    chunks: (async function* () {
      yield new Uint8Array([1]);
    })(),
    progress() {},
  });
  const rejected = expect(work).rejects.toThrow();
  await fake.control.reached("after-exchange", "file-chunk");
  const cancel = operation.cancel();
  fake.control.release("after-exchange", "file-chunk");
  await fake.control.reached("before-exchange", "file-close");
  await expect(h.broker.begin(input)).rejects.toThrow();
  fake.control.release("before-exchange", "file-close");
  await rejected;
  await cancel;
  const next = await h.broker.begin(input);
  await next.finish();
});

it("mode changes allocate a new catalog revision and stamp the snapshot in the session sequence", async () => {
  const h = setup();
  h.unregister();
  const catalog = h.broker.providerCatalog(h.provider.id),
    fake = createFakeDeviceProvider({ catalog, now: h.dependencies.now });
  h.broker.registerProvider(fake.provider);
  const p = pluginPrincipal();
  const connected = await h.broker.request(
    p,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: fake.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect");
  const sessionId = connected.value.session.sessionId;
  const before = await h.broker.request(p, "devices/session", { sessionId }, signal());
  if (!before.ok) throw new Error("sources");
  const changed = await h.broker.request(
    p,
    "devices/inputModes/set",
    {
      sessionId,
      portId: "1",
      expectedSourceRevision: before.value.sources.sourceRevision,
      modeId: "1",
      contextRef: ID,
    },
    signal(),
  );
  expect(changed.ok).toBe(true);
  if (!changed.ok) return;
  expect(changed.value.sources.sourceRevision).toBe(2);
  expect(changed.value.sources.channels[0]!.channelId).not.toBe(
    before.value.sources.channels[0]!.channelId,
  );
  expect(changed.value.snapshot.frame?.sequence).toBe(1);
  expect(changed.value.snapshot.frame?.sourceRevision).toBe(2);
  const read = await h.broker.request(
    p,
    "devices/read",
    { sessionId, channelIds: [changed.value.sources.channels[0]!.channelId], freshness: "fresh" },
    signal(),
  );
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.value.frame?.sequence).toBe(2);
});
it("session and reservation producers retain terminal control until ACK", async () => {
  const h = setup(),
    p = pluginPrincipal(),
    sent: Stage3EventEnvelope[] = [];
  const attachment = h.broker.attachChannel({
    owner: p.owner,
    principal: () => p,
    send: (event) => sent.push(event),
  });
  attachment.negotiated("devices", 1);
  const connected = await h.broker.request(
    p,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect");
  const sessionId = connected.value.session.sessionId;
  const reserved = await h.broker.request(
    p,
    "devices/recording/reserve",
    { sessionId, channelIds: [ID], expectedSourceRevision: 1 },
    signal(),
  );
  if (!reserved.ok) throw new Error("reserve");
  const reservationId = reserved.value.reservation.reservationId;
  const subscribed = await h.broker.request(
    p,
    "devices/subscribe",
    { topic: "reservation", reservationId },
    signal(),
  );
  if (!subscribed.ok) throw new Error("subscribe");
  attachment.activate(subscribed.value.subscriptionId);
  await h.broker.request(p, "devices/recording/release", { reservationId }, signal());
  expect(sent.at(-1)).toMatchObject({ kind: "devices.reservation", data: { state: "ended" } });
  expect(h.broker.events.diagnostics().queuedBytes).toBeGreaterThan(0);
  const last = sent.at(-1)!;
  h.broker.events.ack(p.owner, last.subscriptionId, last.sequence);
  expect(h.broker.events.diagnostics().subscriptions).toBe(0);
  attachment.dispose();
  await h.broker.resources.beginShutdown();
});

it("battery monitor and Lab overlap on one sampler and independent disposal preserves peers", async () => {
  vi.useFakeTimers();
  try {
    const h = setup(),
      connected = await h.broker.request(
        pluginPrincipal(),
        "devices/connect",
        { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
        signal(),
      );
    if (!connected.ok) throw new Error("connect");
    const sessionId = connected.value.session.sessionId;
    const receivers = [vi.fn(), vi.fn(), vi.fn()],
      demands = [];
    for (const [index, adapter] of (["battery", "monitor", "lab"] as const).entries()) {
      const principal = {
        kind: "core" as const,
        adapter,
        hostEpoch: ID,
        workbenchInstance: ID,
        authorityContext: { ref: ID, epoch: ID },
      };
      await h.broker.request(principal, "devices/list", {}, signal());
      const demand = await h.broker.subscribeCoreTelemetry({
        principal,
        sessionId,
        channelIds: [ID],
        intervalMs: adapter === "battery" ? 30000 : 500,
        receive: (value) => {
          receivers[index]!(value);
          demand.ack(value.sequence);
        },
      });
      demands.push(demand);
      demand.activate();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.provider.calls.filter((call) => call === "read")).toHaveLength(1);
    expect(receivers.map((receive) => receive.mock.calls.length)).toEqual([1, 1, 1]);
    await demands[1]!.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(receivers.map((receive) => receive.mock.calls.length)).toEqual([2, 1, 2]);
    await h.broker.resources.beginShutdown();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("each connect exchange is clamped to the one captured attempt deadline", async () => {
  const h = setup(true, {
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 3000,
        wifiHandshakeTimeoutMs: 1000,
        usbAutoReconnect: false,
        usbRetryInterval: "backoff",
        usbRetryLimit: 3,
      }),
    }),
    timeouts: number[] = [];
  h.provider.connect = async (_target, ctx) => {
    await ctx.exchange("connect", async (_signal, timeout) => {
      timeouts.push(timeout);
    });
    h.setNow(2500);
    return ctx.exchange("connect", async (_signal, timeout) => {
      timeouts.push(timeout);
      return {
        value: h.provider.describe(h.provider.session),
        dispatch: "not-sent",
        stopConfirmation: "not-required",
        error: null,
      };
    });
  };
  expect(
    (
      await h.broker.request(
        pluginPrincipal(),
        "devices/connect",
        { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
        signal(),
      )
    ).ok,
  ).toBe(true);
  expect(timeouts).toEqual([4000, 1500]);
});
it("conflicting and replaced provider generations cannot reuse a catalog allocator", async () => {
  const h = setup();
  h.unregister();
  const old = h.broker.providerCatalog(h.provider.id),
    fake = createFakeDeviceProvider({ catalog: old, now: h.dependencies.now });
  const remove = h.broker.registerProvider(fake.provider);
  const connected = await h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: fake.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect");
  const tuple = {
    sessionId: connected.value.session.sessionId,
    portId: "1",
    typeId: "29",
    modeId: "0",
    component: 0,
    unit: "%",
  };
  const id = old.identify(tuple);
  const conflict = h.broker.registerProvider(h.provider);
  expect(() => old.identify(tuple)).toThrow();
  conflict();
  remove();
  const next = h.broker.providerCatalog(h.provider.id),
    replacement = createFakeDeviceProvider({ catalog: next, now: h.dependencies.now });
  h.broker.registerProvider(replacement.provider);
  const reconnected = await h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: replacement.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!reconnected.ok) throw new Error("reconnect");
  expect(() => old.identify(tuple)).toThrow();
  expect(next.identify({ ...tuple, sessionId: reconnected.value.session.sessionId })).not.toBe(id);
});

it("a connect settling after its deadline permits a later connection", async () => {
  vi.useFakeTimers();
  try {
    const h = setup(),
      original = h.provider.connect.bind(h.provider);
    let release!: () => void;
    h.provider.connect = async (_target, ctx) =>
      ctx.exchange("connect", async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          value: h.provider.describe(h.provider.session),
          dispatch: "not-sent",
          stopConfirmation: "not-required",
          error: null,
        };
      });
    const connect = () =>
      h.broker.request(
        pluginPrincipal(),
        "devices/connect",
        { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
        signal(),
      );
    const first = connect();
    await vi.advanceTimersByTimeAsync(0);
    h.setNow(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).ok).toBe(false);
    expect(await connect()).toMatchObject({ ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } });
    release();
    await vi.advanceTimersByTimeAsync(0);
    h.provider.connect = original;
    expect((await connect()).ok).toBe(true);
    await h.broker.resources.beginShutdown();
  } finally {
    vi.useRealTimers();
  }
});
it.each(["provider", "lane"] as const)(
  "finish bounds stalled %s cleanup and subsequent cancel",
  async (failure) => {
    vi.useFakeTimers();
    try {
      const h = setup(),
        p = pluginPrincipal();
      const connected = await h.broker.request(
        p,
        "devices/connect",
        { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
        signal(),
      );
      if (!connected.ok) throw new Error("connect");
      const input = {
        principal: p,
        sessionId: connected.value.session.sessionId,
        operationClass: "file-write" as const,
        signal: signal(),
      };
      h.provider.legacy = async (_session, _request, ctx) => {
        if (failure === "provider") return new Promise(() => {});
        return ctx.exchange("file-chunk", () => new Promise(() => {}));
      };
      const op = await h.broker.begin(input);
      const work = op.execute({
        kind: "upload",
        remotePath: "test",
        size: 1,
        chunks: (async function* () {
          yield new Uint8Array([1]);
        })(),
        progress() {},
      });
      void work.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      let finished = false;
      const finish = op.finish().then(
        () => {
          finished = true;
        },
        () => {},
      );
      const retirement = h.broker.resources.retire(p.owner, "disabled");
      let disposition: unknown;
      void retirement.settled.then((value) => {
        disposition = value;
      });
      h.setNow(15000);
      await vi.advanceTimersByTimeAsync(15000);
      expect(finished).toBe(true);
      expect(disposition).toMatchObject({ stopConfirmed: false, journalCommitted: true });
      await finish;
      await op.cancel();
      const other = pluginPrincipal(2);
      const listed = await h.broker.request(other, "devices/list", {}, signal());
      expect(listed).toMatchObject({ ok: true, value: { sessions: [{ state: "quarantined" }] } });
      await expect(h.broker.begin({ ...input, principal: other })).rejects.toMatchObject({
        result: {
          error: { code: "PLUGIN_E_DEVICE_UNAVAILABLE", detail: { reason: "quarantined" } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  },
);
it.each(["throw", "outcome"] as const)(
  "failed input mode %s preserves source revision and notifies subscribers",
  async (failure) => {
    const h = setup(),
      p = pluginPrincipal();
    const connected = await h.broker.request(
      p,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
      signal(),
    );
    if (!connected.ok) throw new Error("connect");
    const sessionId = connected.value.session.sessionId;
    const sent: unknown[] = [];
    const channel = h.broker.attachChannel({
      owner: p.owner,
      principal: () => p,
      send: (event) => sent.push(event),
    });
    channel.negotiated("devices", 1);
    const sub = await h.broker.request(
      p,
      "devices/subscribe",
      { topic: "session", sessionId },
      signal(),
    );
    if (!sub.ok) throw new Error("subscribe");
    channel.activate(sub.value.subscriptionId);
    const before = await h.broker.request(p, "devices/session", { sessionId }, signal());
    if (!before.ok) throw new Error("session");
    h.provider.setInputMode = async () => {
      if (failure === "throw") throw new Error("mode failed");
      return {
        value: null,
        dispatch: "not-sent",
        stopConfirmation: "not-required",
        error: { message: "mode failed", reason: "provider-contract" },
      };
    };
    const result = await h.broker.request(
      p,
      "devices/inputModes/set",
      {
        sessionId,
        portId: "1",
        modeId: "1",
        expectedSourceRevision: before.value.sources.sourceRevision,
        contextRef: ID,
      },
      signal(),
    );
    expect(result.ok).toBe(false);
    const after = await h.broker.request(p, "devices/session", { sessionId }, signal());
    if (!after.ok) throw new Error("session");
    expect(after.value.session.sourceRevision).toBe(after.value.sources.sourceRevision);
    expect(after.value.sources.sourceRevision).toBe(before.value.sources.sourceRevision);
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "devices.session",
        data: expect.objectContaining({ sourcesChanged: true }),
      }),
    );
    channel.dispose();
    await h.broker.resources.beginShutdown();
  },
);
