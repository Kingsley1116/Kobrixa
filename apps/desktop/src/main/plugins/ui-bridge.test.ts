import type { UiBridgeEvent } from "@kobrixa/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import type {
  PanelResourceV1,
  ResourceOwner,
  UiBinding,
  UiStateSnapshot,
} from "@kobrixa/plugin-protocol";
import { buildInvocation, trustedWorkbench, type ResolvedUi } from "./ui-bridge.js";
const binding: UiBinding = {
  contributionId: "acme.ui.panel",
  panelInstance: "panel",
  kind: "panel",
  uiResourceGeneration: 1,
  generation: 2,
  hostEpoch: "host",
  processEpoch: "process",
};
const owner: ResourceOwner = {
  sourceKey: "dev:0123456789abcdef",
  pluginId: "acme.ui",
  generation: 2,
  hostEpoch: "host",
  processEpoch: "process",
};
function resolved(): ResolvedUi {
  const resource: PanelResourceV1 = {
    kind: "panel",
    root: "root",
    data: {},
    fields: {
      speed: {
        schema: { type: "number", min: 0, max: 100, integer: true, nullable: false },
        initial: 10,
        required: true,
      },
    },
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["speed", "run", "stop"] },
      { id: "speed", type: "number", field: "speed", label: { en: "Speed" }, step: 1 },
      {
        id: "run",
        type: "action",
        label: { en: "Run" },
        variant: "primary",
        action: {
          kind: "command",
          command: "acme.ui.run",
          arguments: { speed: { ref: { scope: "form", key: "speed" } } },
        },
      },
      {
        id: "stop",
        type: "action",
        label: { en: "Recovery" },
        variant: "danger",
        action: { kind: "core", action: "openRecovery" },
      },
    ],
  };
  const state: UiStateSnapshot = {
    binding,
    revision: 1,
    data: {},
    formRevision: 4,
    form: { speed: 10 },
    valid: true,
    visible: true,
    locale: "en",
  };
  return {
    owner,
    resource,
    state,
    workbenchInstance: "window",
    contextRef: "context",
    commands: new Map([
      [
        "acme.ui.run",
        {
          id: "acme.ui.run",
          title: { en: "Run" },
          invocation: "context-v1",
          arguments: {
            speed: { type: "number", min: 0, max: 100, integer: true, nullable: false },
          },
        },
      ],
    ]),
  };
}
it("constructs context from main-owned binding and keeps invocation/action IDs distinct", () => {
  const result = buildInvocation(
    resolved(),
    "run",
    5,
    { speed: 35 },
    { kind: "activate" },
    "action",
    "scope",
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      version: 1,
      command: "acme.ui.run",
      arguments: { speed: 35 },
      context: {
        binding,
        origin: "panel",
        contextRef: "context",
        actionRef: "action",
        motionScopeRef: "scope",
        form: { revision: 5, values: { speed: 35 } },
      },
    },
  });
  if (result.ok) expect(result.value.invocationId).not.toBe("action");
});
it.each([
  ["run", 3, { speed: 10 }],
  ["foreign", 5, { speed: 10 }],
  ["run", 5, { speed: 101 }],
  ["run", 5, { speed: "10" }],
  ["run", 5, { speed: 10, spoof: "context" }],
] as const)("rejects node/form/schema mismatch before dispatch", (nodeId, revision, form) => {
  expect(
    buildInvocation(resolved(), nodeId, revision, form, { kind: "activate" }, "action").ok,
  ).toBe(false);
});
it("denies cross-source commands and retired owner identity", () => {
  const value = resolved();
  const node = value.resource.kind === "panel" ? value.resource.nodes[2]! : undefined;
  if (!node || node.type !== "action" || node.action.kind !== "command")
    throw new Error("bad fixture");
  node.action.command = "other.plugin.run";
  expect(buildInvocation(value, "run", 5, { speed: 10 }, { kind: "activate" }, "action").ok).toBe(
    false,
  );
  const stale = resolved();
  stale.owner = { ...owner, processEpoch: "other" };
  expect(buildInvocation(stale, "run", 5, { speed: 10 }, { kind: "activate" }, "action").ok).toBe(
    false,
  );
});
it("disabled actions and oversized UTF-8 forms cannot launch a command", () => {
  const value = resolved();
  if (value.resource.kind !== "panel") throw new Error("bad fixture");
  value.resource.nodes[2]!.enabledWhen = {
    op: "eq",
    left: { scope: "form", key: "speed" },
    right: 99,
  };
  expect(buildInvocation(value, "run", 5, { speed: 10 }, { kind: "activate" }, "action").ok).toBe(
    false,
  );
  expect(
    buildInvocation(
      resolved(),
      "run",
      5,
      { speed: "界".repeat(16 * 1024) },
      { kind: "activate" },
      "action",
    ).ok,
  ).toBe(false);
});
it("rejects spoofed sender/subframe even when the webContents id matches", () => {
  const mainFrame = {};
  const web = { id: 1, mainFrame };
  expect(trustedWorkbench({ sender: web, senderFrame: mainFrame }, web)).toBe(true);
  expect(trustedWorkbench({ sender: web, senderFrame: {} }, web)).toBe(false);
  expect(trustedWorkbench({ sender: { id: 2 }, senderFrame: mainFrame }, web)).toBe(false);
});
it("hold-end invocation carries no new user persistence authority", () => {
  const value = resolved();
  if (value.resource.kind !== "panel") throw new Error("bad fixture");
  value.resource.nodes[2] = {
    id: "run",
    type: "holdAction",
    label: { en: "Hold" },
    command: "acme.ui.run",
    arguments: { speed: { ref: { scope: "form", key: "speed" } } },
  };
  const result = buildInvocation(
    value,
    "run",
    4,
    { speed: 10 },
    { kind: "hold", phase: "end", gestureRef: "gesture" },
  );
  expect(result).toMatchObject({
    ok: true,
    value: { context: { trigger: { kind: "hold", phase: "end" } } },
  });
  if (result.ok) expect(result.value.context).not.toHaveProperty("actionRef");
});

import * as runtimeExports from "@kobrixa/plugin-runtime";
it("consumes only the named R160 runtime values", () => {
  for (const name of [
    "UiCatalog",
    "UiStateRegistry",
    "currentStatusBindings",
    "UiSubscriptions",
    "sameUiBinding",
    "sameResourceOwner",
    "ChannelActivation",
    "createUiLifetimePort",
    "retireStage3Owner",
  ] as const)
    expect(typeof runtimeExports[name]).toBe("function");
  expect(runtimeExports).not.toHaveProperty("UiLifecycle");
  expect(runtimeExports).not.toHaveProperty("retireBeforePublish");
  expect(runtimeExports).not.toHaveProperty("diagnosticsFor");
});

import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
import {
  type UiCatalogSource,
  type UiRuntimeAttachment,
  type Stage3ChannelContext,
} from "@kobrixa/plugin-runtime";
import { diagnosticsFor as stateDiagnostics } from "../../../../../packages/plugin-runtime/dist/ui-state.js";
import {
  createPluginUiBridge,
  createUiExecutionAdapter,
  createUiRegistry,
  UiBridgeEvents,
  diagnosticsFor as bridgeDiagnostics,
  disposePluginUiBridge,
  type UiExecutionAdapter,
} from "./ui-bridge.js";
import { UiIntent } from "./ui-intent.js";
import { UserPersistenceActions } from "./user-persistence-actions.js";
import { EventLedger } from "../device-broker/registry.js";

function executionFixture() {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const owner: ResourceOwner = {
    sourceKey: "development:fixture",
    pluginId: "test.ui",
    generation: 1,
    hostEpoch: uuid(1),
    processEpoch: uuid(2),
  };
  const scope = { hostEpoch: owner.hostEpoch, workbenchInstance: uuid(3) };
  const [a, b] = createMemoryChannelPair();
  const peer = new RpcPeer(a),
    child = new RpcPeer(b);
  let now = 0,
    current = true,
    markerFails = false;
  const marker = vi.fn((sourceKey: string) => {
    if (sourceKey.startsWith("builtin:")) return;
    if (markerFails) throw new Error("checked marker failed");
  });
  const ledger = new EventLedger(
    () => now,
    () => {},
    () => {},
  );
  const broker = { events: ledger };
  const { catalog, states, subscriptions } = createUiRegistry({
    hostEpoch: owner.hostEpoch,
    broker,
    now: () => now,
    beforeDelivery: marker,
    revokeIntent: () => {},
  });
  let principalOwner = owner;
  const context: Stage3ChannelContext = {
    peer,
    owner,
    requirements: [],
    principal: () => ({ kind: "plugin", owner: principalOwner, authorityContext: null }),
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime: UiRuntimeAttachment = {
    activateInitialized: vi.fn(async (_sourceKey, signal) => {
      await gate;
      signal.throwIfAborted();
      return context;
    }),
    ready: vi.fn(async (_owner, signal) => {
      signal.throwIfAborted();
    }),
    current: (candidate) =>
      current &&
      candidate.generation === owner.generation &&
      candidate.processEpoch === owner.processEpoch &&
      candidate.hostEpoch === owner.hostEpoch &&
      candidate.sourceKey === owner.sourceKey &&
      candidate.pluginId === owner.pluginId,
    owners: () => (current ? [owner] : []),
    context: () => null,
    commands: () => [],
    invoke: async () => ({ ok: true, value: { output: {}, fieldErrors: [] } }),
    dispatchDrain: async () => {
      throw new Error("P160 has no drain RPC");
    },
  };
  const execution = createUiExecutionAdapter({
    catalog,
    states,
    runtime,
    scope: () => scope,
    now: () => now,
    core: async () => ({ ok: true, value: { output: {}, fieldErrors: [] } }),
  });
  const events = new UiBridgeEvents(() => []);
  // Resource/open tests must never touch motion; the real intent wrapper is otherwise idle.
  const device: ConstructorParameters<typeof UiIntent>[0] = {
    bindMotionScope() {
      throw new Error("unexpected motion");
    },
    pulsePanel() {},
    beginGesture() {
      throw new Error("unexpected motion");
    },
    pulseGesture() {},
    endGesture() {},
    revokeScope() {},
  };
  const intent = new UiIntent(device, () => now, events.publish);
  const bridge = createPluginUiBridge({
    catalog,
    execution,
    intent,
    events,
    actions: new UserPersistenceActions(
      () => now,
      () => current,
    ),
    scope: () => scope,
  });
  const raw = JSON.stringify({
    kind: "status",
    text: { text: { en: "Ready" } },
    tone: "neutral",
    data: {
      value: {
        schema: { type: "number", min: 0, max: 10, integer: true, nullable: false },
        initial: 0,
      },
    },
  });
  const source: UiCatalogSource = {
    owner,
    eligible: true,
    resources: { kind: "builtin", files: { "status.json": raw } },
    commands: [],
    panels: [],
    status: [
      {
        id: "test.ui.status",
        title: { en: "Status" },
        resource: { version: 1, path: "status.json" },
      },
    ],
  };
  const load = async () => {
    await catalog.replace([source]);
    const page = await catalog.catalog({});
    if (!page.ok || !page.value.entries[0]) throw new Error("missing resource");
    const entry = page.value.entries[0];
    return {
      sourceKey: entry.sourceKey,
      id: entry.id,
      uiResourceGeneration: entry.uiResourceGeneration,
      resourceDigest: entry.resourceDigest,
    };
  };
  return {
    owner,
    scope: () => scope,
    source,
    catalog,
    states,
    ledger,
    subscriptions,
    bridge,
    execution,
    runtime,
    marker,
    release,
    load,
    peer,
    child,
    context,
    hostWire: a,
    childWire: b,
    stalePrincipal: () => {
      principalOwner = { ...owner, processEpoch: uuid(99) };
    },
    markerFails: () => {
      markerFails = true;
    },
    time: (value: number) => {
      now = value;
    },
    replace: () => {
      current = false;
      states.retireExecution(owner, "generation-retired");
    },
    dispose() {
      execution.dispose();
      intent.dispose();
      subscriptions.dispose();
      ledger.disposeOwner(owner);
      peer.close();
      child.close();
    },
  };
}
describe("BM-11 real T2 execution ownership", () => {
  it("first, concurrent and repeated opens share the initialized binding and await ready", async () => {
    const h = executionFixture();
    try {
      const input = await h.load();
      const first = h.bridge.open(input),
        second = h.bridge.open(input);
      h.release();
      const opened = await first;
      expect(opened.ok).toBe(true);
      expect(await second).toEqual(opened);
      expect(await h.bridge.open(input)).toEqual(opened);
      expect(h.runtime.activateInitialized).toHaveBeenCalledTimes(1);
      if (!opened.ok) throw new Error("open failed");
      const owner = h.states.executionOwner(opened.value.binding);
      expect(owner).toEqual(h.owner);
      expect(owner).not.toBe(h.owner);
      expect(h.execution.resolve(opened.value.binding)?.owner).toEqual(h.owner);
      expect(h.runtime.ready).toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
  it("disposal cancels pending open and a late initialized reply cannot create a binding", async () => {
    const h = executionFixture();
    try {
      const input = await h.load();
      const opening = h.bridge.open(input);
      await vi.waitFor(() => expect(h.runtime.activateInitialized).toHaveBeenCalledOnce());
      h.execution.dispose();
      expect((await opening).ok).toBe(false);
      h.release();
      await Promise.resolve();
      expect(h.states.instances(h.owner)).toEqual([]);
      expect(h.runtime.ready).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
  it("replacement invalidates both authoritative owner lookup and adapter metadata", async () => {
    const h = executionFixture();
    try {
      const input = await h.load();
      h.release();
      const opened = await h.bridge.open(input);
      if (!opened.ok) throw new Error("open failed");
      h.replace();
      expect(h.states.executionOwner(opened.value.binding)).toBeNull();
      expect(h.execution.resolve(opened.value.binding)).toBeNull();
      expect((await h.bridge.open(input)).ok).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
describe("BM-17 checked catalog delivery", () => {
  it("checks direct bridge.resource before open and every cached fetch, with no activation", async () => {
    const h = executionFixture();
    try {
      const input = await h.load();
      expect((await h.bridge.resource(input)).ok).toBe(true);
      expect((await h.bridge.resource(input)).ok).toBe(true);
      expect(h.marker).toHaveBeenCalledTimes(2);
      h.markerFails();
      const failure = await h.bridge.resource(input);
      expect(failure).toMatchObject({ ok: false, error: { detail: { reason: "read" } } });
      expect(failure).not.toHaveProperty("value");
      expect(failure).not.toHaveProperty("rawBytes");
      expect(h.runtime.activateInitialized).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
  it("a builtin exemption and another admitted contribution remain deliverable", async () => {
    const h = executionFixture();
    try {
      await h.catalog.replace([
        h.source,
        { ...h.source, owner: { ...h.owner, sourceKey: "builtin:fixture" } },
      ]);
      h.markerFails();
      const page = await h.catalog.catalog({});
      if (!page.ok) throw new Error("catalog failed");
      for (const entry of page.value.entries) {
        const result = await h.bridge.resource({
          sourceKey: entry.sourceKey,
          id: entry.id,
          uiResourceGeneration: entry.uiResourceGeneration,
          resourceDigest: entry.resourceDigest,
        });
        expect(result.ok).toBe(entry.sourceKey.startsWith("builtin:"));
      }
      expect(h.runtime.activateInitialized).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
});
describe("BM-16 authoritative ledger accounting", () => {
  it.each(["ack", "timeout", "disposal"] as const)(
    "retains terminal bytes until %s",
    async (mode) => {
      const h = executionFixture();
      try {
        const input = await h.load();
        h.release();
        const opened = await h.bridge.open(input);
        if (!opened.ok) throw new Error("open failed");
        const result = h.subscriptions.subscribe(h.owner, {
          binding: opened.value.binding,
          topics: ["state"],
        });
        if (!result.ok) throw new Error("subscribe failed");
        h.ledger.activate(h.owner, result.value.subscriptionId);
        await h.bridge.close({ binding: opened.value.binding });
        expect(stateDiagnostics(h.states).snapshot()).toMatchObject({
          subscriptions: 1,
          queuedEvents: 1,
        });
        expect(stateDiagnostics(h.states).snapshot().queuedBytes).toBeGreaterThan(0);
        expect(stateDiagnostics(h.states).snapshot().queuedBytes).toBe(
          h.ledger.diagnostics().queuedBytes,
        );
        if (mode === "ack") h.ledger.ack(h.owner, result.value.subscriptionId, 1);
        else if (mode === "timeout") {
          h.time(10_000);
          h.ledger.sweep();
        } else h.ledger.disposeOwner(h.owner);
        expect(stateDiagnostics(h.states).snapshot()).toMatchObject({
          subscriptions: 0,
          queuedEvents: 0,
          queuedBytes: 0,
        });
      } finally {
        h.dispose();
      }
    },
  );
});

import { createUiChannelBinding } from "./ui-bridge.js";
import { registerUiEventIpc } from "./ui-bridge.js";
it("preload event streams replay independently, reject foreign frames and detach within a bounded budget", () => {
  type Handle = Parameters<typeof registerUiEventIpc>[0]["handle"];
  const handlers = new Map<string, Parameters<Handle>[1]>();
  const handle: Handle = (channel, action) => {
    handlers.set(channel, action as Parameters<Handle>[1]);
  };
  const send = vi.fn();
  const current = { sender: { id: 1 }, senderFrame: {} } as Electron.IpcMainInvokeEvent;
  const foreign = { ...current, senderFrame: {} } as Electron.IpcMainInvokeEvent;
  const replay: UiBridgeEvent[] = [
    { type: "catalog", hostEpoch: "host", revision: 1, owners: [] },
    { type: "state", binding: { ...binding, kind: "status" }, revision: 4 },
  ];
  const events = new UiBridgeEvents(() => replay);
  const detach = registerUiEventIpc({
    handle,
    bridge: { onEvent: events.subscribe },
    trusted: (event) =>
      event.sender === current.sender && event.senderFrame === current.senderFrame,
    send,
  });
  const invoke = (name: string, event: Electron.IpcMainInvokeEvent, id: unknown) =>
    handlers.get(name)!(event, id);
  expect(invoke("plugins:ui:subscribe", current, 1)).toBe(true);
  expect(send.mock.calls).toEqual(replay.map((event) => ["plugins:ui:event:1", event]));
  send.mockClear();
  expect(invoke("plugins:ui:subscribe", current, 2)).toBe(true);
  expect(send.mock.calls).toEqual(replay.map((event) => ["plugins:ui:event:2", event]));
  expect(invoke("plugins:ui:unsubscribe", foreign, 1)).toBe(false);
  expect(invoke("plugins:ui:subscribe", foreign, 3)).toBe(false);
  expect(invoke("plugins:ui:subscribe", current, "3")).toBe(false);
  send.mockClear();
  events.publish(replay[1]!);
  expect(send.mock.calls.map(([channel]) => channel)).toEqual([
    "plugins:ui:event:1",
    "plugins:ui:event:2",
  ]);
  expect(invoke("plugins:ui:unsubscribe", current, 1)).toBe(true);
  send.mockClear();
  events.publish(replay[1]!);
  expect(send).toHaveBeenCalledExactlyOnceWith("plugins:ui:event:2", replay[1]);
  for (let n = 3; n <= 33; n++) expect(invoke("plugins:ui:subscribe", current, n)).toBe(true);
  expect(invoke("plugins:ui:subscribe", current, 34)).toBe(false);
  detach();
  detach();
  send.mockClear();
  events.publish(replay[1]!);
  expect(send).not.toHaveBeenCalled();
  expect(invoke("plugins:ui:subscribe", current, 34)).toBe(true);
  detach();
  events.dispose();
});
import { registerActivationDeadline, type DeviceChannelAttachment } from "@kobrixa/plugin-runtime";
async function channelFixture() {
  const h = executionFixture();
  const descriptor = await h.load();
  const attachment: DeviceChannelAttachment = {
    owner: h.owner,
    negotiated: vi.fn(),
    activate: vi.fn((id) => {
      h.ledger.activate(h.owner, id);
    }),
    abandon: vi.fn((id) => {
      h.ledger.unsubscribe(h.owner, id);
    }),
    dispose: vi.fn(),
  };
  const handle = vi.spyOn(h.peer, "handle");
  const binding = createUiChannelBinding(h.context, { ...h, attachment });
  const controller = new AbortController();
  let clock = 0;
  const deadlineOff = registerActivationDeadline(controller.signal, 10_000, () => clock);
  h.child.handle("ui/negotiate", () => ({
    ok: true,
    value: { commandEnvelopeVersions: [1], uiResourceVersions: [1] },
  }));
  h.child.handle("ui/ready", async () => {
    const instances = await h.child.request("ui/instances", {});
    expect(instances.ok).toBe(true);
    return { ok: true, value: {} };
  });
  return {
    ...h,
    descriptor,
    attachment,
    handle,
    binding,
    controller,
    advanceClock(ms: number) {
      clock += ms;
    },
    dispose() {
      binding.dispose();
      deadlineOff();
      handle.mockRestore();
      h.dispose();
    },
  };
}
it("negotiated command activation creates status before ready without another activation", async () => {
  const h = await channelFixture();
  try {
    expect(h.states.instances(h.owner)).toEqual([]);
    const notices: UiBinding[] = [];
    h.states.onEvent((_owner, event) => {
      if (event.kind === "ui.state") notices.push(event.data.binding);
    });
    await h.binding.initialized(h.controller.signal);
    const instances = h.states.instances(h.owner);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ kind: "status", contributionId: "test.ui.status" });
    expect(notices).toEqual(instances);
    h.child.handle("ui/ready", async () => {
      expect(await h.child.request("ui/instances", {})).toEqual({ ok: true, value: { instances } });
      return { ok: true, value: {} };
    });
    await h.binding.ready(h.controller.signal);
    expect(h.runtime.activateInitialized).not.toHaveBeenCalled();
    expect(h.runtime.ready).not.toHaveBeenCalled();
    h.binding.dispose();
    expect(h.states.instances(h.owner)).toEqual([]);
  } finally {
    h.dispose();
  }
});
it("actual patch RPCs drain coalesced state notifications without a manual test flush", async () => {
  const h = await channelFixture();
  try {
    h.release();
    await h.binding.initialized(h.controller.signal);
    const opened = await h.bridge.open(h.descriptor);
    if (!opened.ok) throw new Error("open failed");
    const revisions: number[] = [];
    h.states.onEvent((_owner, event) => {
      if (event.kind === "ui.state") revisions.push(event.data.revision);
    });
    for (let n = 0; n < 6; n++) {
      h.time(n * 250);
      expect(
        await h.child.request("ui/patch", {
          binding: opened.value.binding,
          baseRevision: n,
          set: { value: n + 1 },
        }),
      ).toEqual({ ok: true, value: { revision: n + 1 } });
    }
    await Promise.resolve();
    expect(revisions.at(-1)).toBe(6);
  } finally {
    h.dispose();
  }
});
it("status initialization only binds the negotiated owner and checks delivery before creating state", async () => {
  const h = await channelFixture();
  try {
    await h.catalog.replace([
      h.source,
      { ...h.source, owner: { ...h.owner, sourceKey: "foreign:source" } },
    ]);
    await h.binding.initialized(h.controller.signal);
    expect(h.states.instances(h.owner)).toHaveLength(1);
    expect(h.marker.mock.calls.map(([source]) => source)).toEqual([h.owner.sourceKey]);
    expect(stateDiagnostics(h.states).snapshot().bindings).toBe(1);
  } finally {
    h.dispose();
  }
  const denied = await channelFixture();
  try {
    denied.markerFails();
    await expect(denied.binding.initialized(denied.controller.signal)).rejects.toThrow(
      "Status resource unavailable",
    );
    expect(denied.states.instances(denied.owner)).toEqual([]);
    expect(denied.runtime.activateInitialized).not.toHaveBeenCalled();
  } finally {
    denied.dispose();
  }
});
it("repeated closes acknowledge the same closed binding but never a forged or retired owner", async () => {
  const h = executionFixture();
  try {
    h.release();
    const opened = await h.bridge.open(await h.load());
    if (!opened.ok) throw new Error("open failed");
    const input = { binding: opened.value.binding };
    const closed = await h.bridge.close(input);
    expect(closed).toEqual({ ok: true, value: { closed: true } });
    expect(await h.bridge.close(input)).toEqual(closed);
    expect(
      (
        await h.bridge.close({
          binding: { ...input.binding, processEpoch: "00000000-0000-4000-8000-000000000099" },
        })
      ).ok,
    ).toBe(false);
    expect((await h.bridge.snapshot(input)).ok).toBe(false);
    await h.catalog.replace([]);
    expect((await h.bridge.close(input)).ok).toBe(false);
  } finally {
    h.dispose();
  }
});
it("completed close receipts expire without retaining live bindings", async () => {
  const h = executionFixture();
  try {
    h.release();
    const opened = await h.bridge.open(await h.load());
    if (!opened.ok) throw new Error("open failed");
    const input = { binding: opened.value.binding };
    await h.bridge.close(input);
    h.time(29_999);
    expect((await h.bridge.close(input)).ok).toBe(true);
    h.time(30_000);
    expect((await h.bridge.close(input)).ok).toBe(false);
    expect(stateDiagnostics(h.states).snapshot().bindings).toBe(0);
  } finally {
    h.dispose();
  }
});
it("completed close receipts stay within the bounded host budget during rapid reopen", async () => {
  const h = executionFixture();
  try {
    h.release();
    const descriptor = await h.load();
    let first: UiBinding | undefined, last: UiBinding | undefined;
    for (let n = 0; n < 257; n++) {
      const opened = await h.bridge.open(descriptor);
      if (!opened.ok) throw new Error("open failed");
      first ??= opened.value.binding;
      last = opened.value.binding;
      await h.bridge.close({ binding: last });
    }
    expect((await h.bridge.close({ binding: first! })).ok).toBe(false);
    expect((await h.bridge.close({ binding: last! })).ok).toBe(true);
    expect(stateDiagnostics(h.states).snapshot().bindings).toBe(0);
  } finally {
    h.dispose();
  }
});
it("BM-12 routes all five requests on the original peer and ready can query instances", async () => {
  const h = await channelFixture();
  try {
    const opening = h.bridge.open(h.descriptor);
    h.release();
    await h.binding.initialized(h.controller.signal);
    const opened = await opening;
    if (!opened.ok) throw new Error("open failed");
    await h.binding.ready(h.controller.signal);
    const instances = await h.child.request("ui/instances", {});
    expect(instances).toEqual({ ok: true, value: { instances: [opened.value.binding] } });
    expect((await h.child.request("ui/state", { binding: opened.value.binding })).ok).toBe(true);
    expect(
      await h.child.request("ui/patch", {
        binding: opened.value.binding,
        baseRevision: 0,
        set: { value: 1 },
      }),
    ).toEqual({ ok: true, value: { revision: 1 } });
    const subscription = await h.child.request("ui/subscribe", {
      binding: opened.value.binding,
      topics: ["state"],
    });
    if (!subscription.ok) throw new Error("subscribe failed");
    expect(h.attachment.activate).toHaveBeenCalledExactlyOnceWith(
      subscription.value.subscriptionId,
    );
    expect(
      (await h.child.request("ui/snapshot", { subscriptionId: subscription.value.subscriptionId }))
        .ok,
    ).toBe(true);
    expect(h.handle.mock.calls.map((call) => call[0])).toEqual([
      "ui/instances",
      "ui/state",
      "ui/patch",
      "ui/snapshot",
      "ui/subscribe",
    ]);
    expect(h.attachment.negotiated).toHaveBeenCalledExactlyOnceWith("ui", 1);
    expect(h.runtime.activateInitialized).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});
it.each(["command", "onPanel"])(
  "BM-12 %s launch without open needs no ready recursion",
  async () => {
    const h = await channelFixture();
    try {
      await h.binding.initialized(h.controller.signal);
      await h.binding.ready(h.controller.signal);
      expect(h.runtime.ready).not.toHaveBeenCalled();
      expect(h.states.instances(h.owner)).toMatchObject([{ kind: "status" }]);
      expect(h.runtime.activateInitialized).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);
it("BM-12 stale principal and unnegotiated domain are rejected on actual requests", async () => {
  const h = await channelFixture();
  try {
    await expect(h.child.request("ui/instances", {})).rejects.toThrow();
    await h.binding.initialized(h.controller.signal);
    h.stalePrincipal();
    await expect(h.child.request("ui/instances", {})).rejects.toThrow();
    await expect(h.child.request("ui/subscribe", { topics: ["instances"] })).rejects.toThrow();
    expect(h.attachment.activate).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
it.each(["ui/negotiate", "ui/ready"] as const)(
  "BM-12 malformed %s reply fails schema routing",
  async (method) => {
    const h = await channelFixture();
    try {
      if (method === "ui/ready") await h.binding.initialized(h.controller.signal);
      // Invalid wire is deliberate: bypass TypeScript only at the transport boundary, never a typed handler.
      const [rawHost, rawChild] = createMemoryChannelPair();
      const malformed = new RpcPeer(rawHost);
      const off = rawChild.onMessage((text) => {
        const request = JSON.parse(text);
        if (request.id)
          rawChild.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "ui/negotiate" && method === "ui/ready"
                  ? { ok: true, value: { commandEnvelopeVersions: [1], uiResourceVersions: [1] } }
                  : { unexpected: true },
            }),
          );
      });
      try {
        const context = { ...h.context, peer: malformed };
        const binding = createUiChannelBinding(context, { ...h, attachment: h.attachment });
        if (method === "ui/negotiate")
          await expect(binding.initialized(h.controller.signal)).rejects.toThrow();
        else {
          await binding.initialized(h.controller.signal);
          await expect(binding.ready(h.controller.signal)).rejects.toThrow();
        }
        binding.dispose();
      } finally {
        off();
        malformed.close();
      }
    } finally {
      h.dispose();
    }
  },
);
it("BM-12 cancellation abandons an inactive subscription before a reply can activate it", async () => {
  const h = await channelFixture();
  try {
    await h.binding.initialized(h.controller.signal);
    const original = h.subscriptions.subscribe.bind(h.subscriptions);
    const cancel = new AbortController();
    vi.spyOn(h.subscriptions, "subscribe").mockImplementation((owner, input) => {
      const result = original(owner, input);
      cancel.abort();
      return result;
    });
    await expect(
      h.child.request("ui/subscribe", { topics: ["instances"] }, { signal: cancel.signal }),
    ).rejects.toThrow();
    await Promise.resolve();
    expect(h.attachment.activate).not.toHaveBeenCalled();
    expect(h.attachment.abandon).toHaveBeenCalledOnce();
    expect(h.ledger.diagnostics().subscriptions).toBe(0);
  } finally {
    h.dispose();
  }
});
it("BM-12 failed reply send abandons the original inactive subscription", async () => {
  const h = await channelFixture();
  try {
    await h.binding.initialized(h.controller.signal);
    const send = h.hostWire.send.bind(h.hostWire);
    vi.spyOn(h.hostWire, "send").mockImplementation((text) => {
      const message = JSON.parse(text);
      if (message.result?.value?.subscriptionId) throw new Error("reply send failed");
      send(text);
    });
    await expect(
      h.child.request("ui/subscribe", { topics: ["instances"] }, { timeoutMs: 20 }),
    ).rejects.toThrow();
    expect(h.attachment.activate).not.toHaveBeenCalled();
    expect(h.attachment.abandon).toHaveBeenCalledOnce();
    expect(h.ledger.diagnostics().subscriptions).toBe(0);
  } finally {
    h.dispose();
  }
});
it("BM-12 malformed incoming params never reach state mutation", async () => {
  const h = await channelFixture();
  try {
    await h.binding.initialized(h.controller.signal);
    const patch = vi.spyOn(h.states, "patch");
    const replies: unknown[] = [];
    const off = h.childWire.onMessage((text) => {
      const value = JSON.parse(text);
      if (value.id === 990) replies.push(value);
    });
    h.childWire.send(
      JSON.stringify({ jsonrpc: "2.0", id: 990, method: "ui/patch", params: { extra: true } }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ error: { code: -32602 } });
    expect(patch).not.toHaveBeenCalled();
    off();
  } finally {
    h.dispose();
  }
});
it("BM-12 no-UI source retains inert phases and never negotiates", async () => {
  const h = await channelFixture();
  try {
    await h.catalog.replace([{ ...h.source, panels: [], status: [], commands: [] }]);
    const request = vi.spyOn(h.peer, "request");
    await h.binding.initialized(h.controller.signal);
    await h.binding.ready(h.controller.signal);
    expect(request).not.toHaveBeenCalled();
    expect(h.attachment.negotiated).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
it("BM-12 ready receives the original remaining deadline", async () => {
  vi.useFakeTimers();
  const h = await channelFixture();
  try {
    await h.binding.initialized(h.controller.signal);
    h.advanceClock(9_500);
    await vi.advanceTimersByTimeAsync(9_500);
    h.child.handle("ui/ready", () => new Promise(() => {}));
    const request = vi.spyOn(h.peer, "request");
    const ready = h.binding.ready(h.controller.signal);
    const rejected = expect(ready).rejects.toThrow();
    expect(request.mock.calls.at(-1)![2]!.timeoutMs).toBeLessThanOrEqual(500);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(h.runtime.ready).not.toHaveBeenCalled();
  } finally {
    h.dispose();
    vi.useRealTimers();
  }
});
it("BM-12 disposal rejects pending initial bindings without closing the shared channel twice", async () => {
  const h = await channelFixture();
  try {
    const opening = h.bridge.open(h.descriptor);
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    const phase = h.binding.initialized(h.controller.signal);
    const failed = expect(phase).rejects.toThrow();
    h.binding.dispose();
    h.binding.dispose();
    await failed;
    expect((await opening).ok).toBe(false);
    expect(h.attachment.dispose).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it("counts mixed-domain subscriptions once, including terminal controls", async () => {
  const h = executionFixture();
  try {
    const input = await h.load();
    h.release();
    const opened = await h.bridge.open(input);
    if (!opened.ok) throw new Error("open failed");
    const ui = h.subscriptions.subscribe(h.owner, {
      binding: opened.value.binding,
      topics: ["state"],
    });
    const other = h.ledger.create(h.owner);
    if (!ui.ok || !other.ok) throw new Error("subscription failed");
    h.ledger.activate(h.owner, ui.value.subscriptionId);
    h.ledger.activate(h.owner, other.value.subscriptionId);
    await h.bridge.close({ binding: opened.value.binding });
    expect(stateDiagnostics(h.states).snapshot()).toMatchObject({
      subscriptions: 2,
      queuedEvents: 1,
    });
    expect(stateDiagnostics(h.states).snapshot().queuedBytes).toBe(
      h.ledger.diagnostics().queuedBytes,
    );
    h.ledger.ack(h.owner, ui.value.subscriptionId, 1);
    expect(stateDiagnostics(h.states).snapshot()).toMatchObject({
      subscriptions: 1,
      queuedEvents: 0,
      queuedBytes: 0,
    });
    h.ledger.unsubscribe(h.owner, other.value.subscriptionId);
    expect(stateDiagnostics(h.states).snapshot().subscriptions).toBe(0);
  } finally {
    h.dispose();
  }
});

it("replays current status before concurrent hints and repeats on remount", () => {
  const status = { ...binding, kind: "status" as const };
  const catalog: UiBridgeEvent = { type: "catalog", hostEpoch: "host", revision: 2, owners: [] };
  const initial: UiBridgeEvent = { type: "state", binding: status, revision: 4 };
  const next: UiBridgeEvent = { type: "state", binding: status, revision: 5 };
  const events = new UiBridgeEvents(() => [catalog, initial]);
  const seen: UiBridgeEvent[] = [];
  const off = events.subscribe((event) => {
    seen.push(event);
    if (event === catalog) events.publish(next);
  });
  expect(seen).toEqual([catalog, initial, next]);
  off();
  events.publish(next);
  expect(seen).toHaveLength(3);
  const remount: UiBridgeEvent[] = [];
  const stop = events.subscribe((event) => remount.push(event));
  expect(remount).toEqual([catalog, initial]);
  stop();
});
it("bridge diagnostics count live requests and disposal aborts their authority without executing a late result", async () => {
  expect(() => bridgeDiagnostics({})).toThrow("Unknown foundation");
  const value = resolved();
  let signal: AbortSignal | undefined;
  let finish!: (value: Awaited<ReturnType<UiExecutionAdapter["invoke"]>>) => void;
  const execution: UiExecutionAdapter = {
    resolve: () => value,
    acceptForm: () => true,
    open: async () => ({ ok: true, value: value.state }),
    close: async () => ({ ok: true, value: { closed: true } }),
    visibility: async () => ({ ok: true, value: { accepted: true } }),
    snapshot: async () => ({ ok: true, value: value.state }),
    reportFailure: async () => ({ ok: true, value: { accepted: true } }),
    invoke: async (_owner, _invocation, actualSignal) => {
      signal = actualSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    core: async () => ({ ok: true, value: { output: {}, fieldErrors: [] } }),
    dispose() {},
  };
  const events = new UiBridgeEvents(() => []);
  const intent = new UiIntent(
    {
      bindMotionScope: () => "scope",
      pulsePanel() {},
      beginGesture: () => "gesture",
      pulseGesture() {},
      endGesture() {},
      revokeScope() {},
    },
    () => 0,
    events.publish,
  );
  const actions = new UserPersistenceActions(
    () => 0,
    () => true,
  );
  const bridge = createPluginUiBridge({
    catalog: {
      catalog: async () => ({
        ok: true,
        value: { hostEpoch: owner.hostEpoch, revision: 0, entries: [], nextCursor: null },
      }),
      resource: async () => {
        throw new Error("unused");
      },
      onEvent: () => () => {},
      retire() {},
    },
    execution,
    intent,
    actions,
    events,
    scope: () => ({ hostEpoch: owner.hostEpoch, workbenchInstance: "window" }),
  });
  const pending = bridge.invoke({ binding, nodeId: "run", formRevision: 5, form: { speed: 30 } });
  expect(bridgeDiagnostics(bridge).snapshot()).toMatchObject({
    pendingInvocations: 1,
    actionTokens: 1,
  });
  disposePluginUiBridge(bridge);
  expect(signal?.aborted).toBe(true);
  expect(bridgeDiagnostics(bridge).snapshot()).toMatchObject({
    pendingInvocations: 0,
    actionTokens: 0,
    timers: 0,
  });
  finish({ ok: true, value: { output: {}, fieldErrors: [] } });
  expect((await pending).ok).toBe(false);
});

it("hold cleanup stops first and delivers the original accepted form while begin is pending", async () => {
  const value = resolved(); if (value.resource.kind !== "panel") throw new Error("panel");
  value.resource.nodes[2] = { id: "run", type: "holdAction", label: { en: "Hold" }, command: "acme.ui.run", arguments: { speed: { ref: { scope: "form", key: "speed" } } } };
  const events = new UiBridgeEvents(() => []); const order: string[] = [];
  let challenge = "";
  const intent = new UiIntent({ bindMotionScope: () => "scope", pulsePanel() {}, beginGesture: () => "gesture", pulseGesture() {},
    endGesture() { order.push("stop"); }, revokeScope() {} }, () => 0, (event) => { if (event.type === "pulse") challenge = event.challenge; });
  let finish!: (value: Awaited<ReturnType<UiExecutionAdapter["invoke"]>>) => void;
  const invoke = vi.fn<UiExecutionAdapter["invoke"]>((_owner, invocation) => {
    if (invocation.context.trigger.kind === "hold" && invocation.context.trigger.phase === "begin") return new Promise(resolve => { finish = resolve; });
    order.push("cleanup"); return Promise.resolve({ ok: true, value: { output: {}, fieldErrors: [] } });
  });
  const bridge = createPluginUiBridge({ catalog: { catalog: async () => ({ ok: true, value: { hostEpoch: owner.hostEpoch, revision: 0, entries: [], nextCursor: null } }), resource: async () => { throw new Error("unused"); }, onEvent: () => () => {}, retire() {} },
    execution: { resolve: () => value, acceptForm: (_binding, revision, form) => { value.state.formRevision = revision; value.state.form = form; return true; },
      invoke, core: async () => ({ ok: true, value: { output: {}, fieldErrors: [] } }), open: async () => ({ ok: true, value: value.state }), close: async () => ({ ok: true, value: { closed: true } }), visibility: async () => ({ ok: true, value: { accepted: true } }), snapshot: async () => ({ ok: true, value: value.state }), reportFailure: async () => ({ ok: true, value: { accepted: true } }), dispose() {} },
    intent, events, actions: new UserPersistenceActions(() => 0, () => true), scope: () => ({ hostEpoch: owner.hostEpoch, workbenchInstance: "window" }) });
  try {
    intent.bind(binding, { owner, contextRef: "context", panelInstance: binding.panelInstance, uiResourceGeneration: 1, workbenchInstance: "window" });
    expect(intent.pulse(binding, challenge, null, null)).toBe(true);
    const begin = bridge.hold({ binding, nodeId: "run", formRevision: 5, form: { speed: 30 }, phase: "begin", inputToken: "token" });
    await bridge.hold({ binding, nodeId: "run", formRevision: 99, form: { speed: null }, phase: "cancel", inputToken: "token" });
    expect(order).toEqual(["stop", "cleanup"]);
    expect(invoke.mock.calls[1]![1].context).toMatchObject({ form: { revision: 5, values: { speed: 30 } }, trigger: { kind: "hold", phase: "cancel" } });
    finish({ ok: true, value: { output: {}, fieldErrors: [] } }); expect(await begin).toMatchObject({ ok: true, value: { gesture: null } });
  } finally { disposePluginUiBridge(bridge); intent.dispose(); }
});
