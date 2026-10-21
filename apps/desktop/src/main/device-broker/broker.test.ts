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

it.each(["success", "failure", "late"] as const)(
  "cancel preserves settled provider evidence and bounds %s outcomes",
  async (outcomeKind) => {
    vi.useFakeTimers();
    try {
      const h = setup(),
        principal = pluginPrincipal();
      const connected = await h.broker.request(
        principal,
        "devices/connect",
        { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
        signal(),
      );
      if (!connected.ok) throw new Error("connect");
      const outcome = {
        value: outcomeKind === "failure" ? null : { kind: "mutation" as const, verified: true },
        dispatch: "unknown" as const,
        stopConfirmation: "unconfirmed" as const,
        error:
          outcomeKind === "failure"
            ? { reason: "readback-failed" as const, message: "Original handle close failed" }
            : null,
      };
      let release!: () => void;
      h.provider.legacy = () =>
        new Promise((resolve) => {
          release = () => resolve(outcome);
        });
      const op = await h.broker.begin({
        principal,
        sessionId: connected.value.session.sessionId,
        operationClass: "file-write",
        signal: signal(),
      });
      const work = op.execute({ kind: "mkdir", remotePath: "test" });
      const settled = work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const cancel = op.cancel();
      if (outcomeKind === "late") {
        h.setNow(15000);
        await vi.advanceTimersByTimeAsync(15000);
        await cancel;
        expect(await settled).toMatchObject({
          error: {
            result: { error: { code: "PLUGIN_E_TIMEOUT", detail: { reason: "deadline" } } },
          },
        });
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(await settled).toMatchObject({
          error: {
            result: { error: { code: "PLUGIN_E_TIMEOUT", detail: { reason: "deadline" } } },
          },
        });
      } else {
        release();
        await cancel;
        if (outcomeKind === "success") expect(await settled).toEqual({ value: outcome });
        else
          expect(await settled).toMatchObject({
            error: {
              result: {
                error: {
                  message: outcome.error!.message,
                  detail: {
                    kind: "device",
                    reason: "readback-failed",
                    dispatch: "unknown",
                    stopConfirmation: "unconfirmed",
                  },
                },
              },
            },
          });
      }
      await op.cancel();
      await op.finish();
      await h.broker.resources.beginShutdown();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("T5fix retained operations permit further execute calls after a recoverable provider error", async () => {
  const h = setup(),
    principal = pluginPrincipal();
  const connected = await h.broker.request(
    principal,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect");
  const original = h.provider.legacy.bind(h.provider);
  vi.spyOn(h.provider, "legacy").mockImplementation(async (key, request, ctx) =>
    request.kind === "list"
      ? {
          value: null,
          dispatch: "sent",
          stopConfirmation: "not-required",
          error: { reason: "provider-failure", message: "Missing directory" },
        }
      : original(key, request, ctx),
  );
  const operation = await h.broker.begin({
    principal,
    sessionId: connected.value.session.sessionId,
    operationClass: "deployment",
    signal: signal(),
  });
  try {
    expect((await operation.execute({ kind: "list", remotePath: "/missing" })).error?.reason).toBe(
      "provider-failure",
    );
    expect((await operation.execute({ kind: "mkdir", remotePath: "/missing" })).error).toBeNull();
    expect((await operation.execute({ kind: "mkdir", remotePath: "/second" })).error).toBeNull();
  } finally {
    await operation.finish();
    h.unregister();
  }
});
import { LegacyFiles } from "./legacy-files.js";
it("T5fix real broker execution remains exchange-bounded after confirmation expires", async () => {
  vi.useFakeTimers();
  const h = setup(),
    principal = pluginPrincipal();
  try {
    const connected = await h.broker.request(
      principal,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
      signal(),
    );
    if (!connected.ok) throw new Error("connect");
    const files = new LegacyFiles(h.broker, () => principal, h.dependencies.now);
    const result = files
      .run(connected.value.session.sessionId, async (session, cancellation) => {
        await session.confirm(async () => true);
        await new Promise<void>((resolve) => setTimeout(resolve, 600001));
        h.setNow(600001);
        await session.createDirectory("/late", cancellation);
      })
      .then(
        () => "ok",
        () => "expired",
      );
    await vi.advanceTimersByTimeAsync(600002);
    expect(await result).toBe("ok");
  } finally {
    h.unregister();
    vi.useRealTimers();
  }
});
import { observeCoreTelemetryClosed } from "./broker.js";
import type { CorePrincipal } from "./broker-port.js";
it.each(["ack-deadline", "session-loss", "caller"])(
  "T5fix core telemetry reports %s closure once",
  async (reason) => {
    vi.useFakeTimers();
    const h = setup();
    const principal: CorePrincipal = {
      kind: "core",
      adapter: "monitor",
      hostEpoch: ID,
      workbenchInstance: ID,
      authorityContext: { ref: ID, epoch: ID },
    };
    try {
      const connected = await h.broker.request(
        principal,
        "devices/connect",
        { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
        signal(),
      );
      if (!connected.ok) throw new Error("connect");
      const subscription = await h.broker.subscribeCoreTelemetry({
        principal,
        sessionId: connected.value.session.sessionId,
        channelIds: [ID],
        intervalMs: 500,
        receive() {},
      });
      const closed = vi.fn();
      observeCoreTelemetryClosed(subscription, closed);
      subscription.activate();
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "caller") await subscription.dispose();
      else if (reason === "session-loss") h.provider.lose();
      else h.setNow(10000);
      await vi.advanceTimersByTimeAsync(500);
      expect(closed).toHaveBeenCalledTimes(reason === "caller" ? 0 : 1);
      await subscription.dispose();
      expect(closed).toHaveBeenCalledTimes(reason === "caller" ? 0 : 1);
    } finally {
      h.unregister();
      vi.useRealTimers();
    }
  },
);
it("T5fix core reservations retain core identity and share recording exclusion with plugins", async () => {
  const h = setup();
  const principal: CorePrincipal = {
    kind: "core",
    adapter: "lab",
    hostEpoch: ID,
    workbenchInstance: ID,
    authorityContext: { ref: ID, epoch: ID },
  };
  try {
    const connected = await h.broker.request(
      principal,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
      signal(),
    );
    if (!connected.ok) throw new Error("connect");
    const params = {
      sessionId: connected.value.session.sessionId,
      channelIds: [ID],
      expectedSourceRevision: 1,
    };
    const reserved = await h.broker.request(
      principal,
      "devices/recording/reserve",
      params,
      signal(),
    );
    if (!reserved.ok) throw new Error("reserve");
    const ref = { reservationId: reserved.value.reservation.reservationId };
    expect(
      await h.broker.request(
        { ...principal, adapter: "monitor" },
        "devices/recording/query",
        ref,
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
    expect(
      await h.broker.request(
        {
          ...principal,
          authorityContext: { ref: ID, epoch: "00000000-0000-4000-8000-000000000002" },
        },
        "devices/recording/read",
        { ...ref, afterSequence: 0, limit: 1 },
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
    await h.broker.request(pluginPrincipal(), "devices/list", {}, signal());
    expect(
      await h.broker.request(pluginPrincipal(), "devices/recording/reserve", params, signal()),
    ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } });
    expect(
      await h.broker.request(pluginPrincipal(), "devices/recording/query", ref, signal()),
    ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
    expect((await h.broker.request(principal, "devices/recording/release", ref, signal())).ok).toBe(
      true,
    );
    expect(
      (await h.broker.request(pluginPrincipal(), "devices/recording/reserve", params, signal())).ok,
    ).toBe(true);
  } finally {
    h.unregister();
  }
});
it("T5fix confirmation expiry still blocks exchanges during planning", async () => {
  const h = setup(),
    principal = pluginPrincipal();
  const connected = await h.broker.request(
    principal,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect");
  const sent = vi.fn(async () => {});
  vi.spyOn(h.provider, "legacy").mockImplementation(async (_key, _request, ctx) => {
    h.setNow(120000);
    await ctx.exchange("read", sent);
    return {
      value: { kind: "entries", entries: [] },
      dispatch: "sent",
      error: null,
      stopConfirmation: "not-required",
    };
  });
  const operation = await h.broker.begin({
    principal,
    sessionId: connected.value.session.sessionId,
    operationClass: "file-read",
    signal: signal(),
  });
  try {
    await expect(operation.execute({ kind: "list", remotePath: "/plan" })).rejects.toThrow();
    expect(sent).not.toHaveBeenCalled();
  } finally {
    await operation.finish();
    h.unregister();
  }
});

import { admitLegacyExecution } from "./broker.js";
it("T5fix2 legacy waits for an in-flight sampler exchange with finite provider deadlines", async () => {
  const h = setup(),
    principal: CorePrincipal = {
      kind: "core",
      adapter: "deployment",
      hostEpoch: ID,
      workbenchInstance: ID,
      authorityContext: { ref: ID, epoch: ID },
    };
  const warnings: Error[] = [];
  const listener = (warning: Error) => warnings.push(warning);
  process.on("warning", listener);
  try {
    const connected = await h.broker.request(
      principal,
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
      signal(),
    );
    if (!connected.ok) throw new Error("connect");
    const id = connected.value.session.sessionId;
    const original = h.provider.read.bind(h.provider);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.provider.read = async (session, ctx) => {
      await ctx.exchange("read", async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      return original(session, ctx);
    };
    const catalog = await h.broker.request(
      principal,
      "devices/session",
      { sessionId: id },
      signal(),
    );
    if (!catalog.ok) throw new Error("catalog");
    const demand = await h.broker.subscribeCoreTelemetry({
      principal,
      sessionId: id,
      channelIds: catalog.value.sources.channels.map((c) => c.channelId),
      intervalMs: 500,
      receive: () => {},
    });
    demand.activate();
    const reading = h.broker.request(
      principal,
      "devices/read",
      {
        sessionId: id,
        channelIds: catalog.value.sources.channels.map((c) => c.channelId),
        freshness: "fresh",
      },
      signal(),
    );
    await entered;
    h.provider.legacy = async (_session, _request, ctx) => {
      expect(Number.isFinite(ctx.deadlineMonotonicMs)).toBe(true);
      expect(ctx.deadlineMonotonicMs).toBeGreaterThan(h.dependencies.now());
      await ctx.exchange("read", async () => {});
      return {
        value: { kind: "entries", entries: [] },
        dispatch: "not-sent",
        error: null,
        stopConfirmation: "not-required",
      };
    };
    const op = await h.broker.begin({
      principal,
      sessionId: id,
      operationClass: "file-read",
      signal: signal(),
    });
    await expect(op.execute({ kind: "list", remotePath: "/" })).resolves.toMatchObject({
      error: null,
    });
    admitLegacyExecution(op);
    h.setNow(600001);
    await expect(op.execute({ kind: "list", remotePath: "/later" })).resolves.toMatchObject({
      error: null,
    });
    await op.finish();
    const next = await h.broker.begin({
      principal,
      sessionId: id,
      operationClass: "file-read",
      signal: signal(),
    });
    await next.finish();
    await reading;
    await demand.dispose();
    expect(warnings.filter((warning) => warning.name === "TimeoutOverflowWarning")).toEqual([]);
  } finally {
    process.off("warning", listener);
    h.unregister();
  }
});

it("send failure disposes every channel subscription while preserving another owner", async () => {
  const h = setup();
  const failed = pluginPrincipal();
  const healthy = pluginPrincipal(2);
  const nativeError = new Error("private native transport detail");
  const failedSend = vi.fn(() => {
    throw nativeError;
  });
  const healthySend = vi.fn();
  const failedChannel = h.broker.attachChannel({
    owner: failed.owner,
    principal: () => failed,
    send: failedSend,
  });
  const healthyChannel = h.broker.attachChannel({
    owner: healthy.owner,
    principal: () => healthy,
    send: healthySend,
  });
  const removed = vi.fn();
  const detachRemoved = h.broker.events.onRemoved(removed);
  const subscribe = async (principal: typeof failed) => {
    const result = await h.broker.request(
      principal,
      "devices/subscribe",
      { topic: "catalog" },
      signal(),
    );
    if (!result.ok) throw new Error("subscribe");
    return result.value.subscriptionId;
  };
  const publish = (principal: typeof failed, id: string) =>
    h.broker.events.publish(
      principal.owner,
      id,
      { kind: "devices.catalog", data: { revision: 1, providers: [], sessions: [] } },
      "control",
    );
  try {
    failedChannel.negotiated("devices", 1);
    healthyChannel.negotiated("devices", 1);
    const first = await subscribe(failed);
    const inactive = await subscribe(failed);
    const other = await subscribe(healthy);
    publish(failed, inactive);
    failedChannel.activate(first);
    healthyChannel.activate(other);
    expect(() => publish(failed, first)).toThrow(nativeError);
    expect(h.broker.events.diagnostics()).toEqual({
      subscriptions: 1,
      queuedEvents: 0,
      queuedBytes: 0,
    });
    expect(removed.mock.calls.map(([id]) => id).sort()).toEqual([first, inactive].sort());
    expect(() => failedChannel.negotiated("devices", 1)).toThrow();
    failedChannel.activate(inactive);
    expect(() => publish(failed, inactive)).toThrow();
    expect(failedSend).toHaveBeenCalledTimes(1);
    const denied = await h.broker.request(
      failed,
      "devices/subscribe",
      { topic: "catalog" },
      signal(),
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "PLUGIN_E_DEVICE_UNAVAILABLE" } });
    expect(JSON.stringify(denied)).not.toContain(nativeError.message);
    publish(healthy, other);
    expect(healthySend).toHaveBeenCalledTimes(1);
    healthyChannel.dispose();
    failedChannel.dispose();
    expect(removed).toHaveBeenCalledTimes(3);
    expect(h.broker.events.diagnostics()).toEqual({
      subscriptions: 0,
      queuedEvents: 0,
      queuedBytes: 0,
    });
  } finally {
    failedChannel.dispose();
    healthyChannel.dispose();
    detachRemoved();
    await h.broker.resources.beginShutdown();
  }
});
