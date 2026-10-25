import { UiIntent } from "./ui-intent.js";
import { UserPersistenceActions } from "./user-persistence-actions.js";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  validateUiResourceV2,
  validateUiResource,
  uiRequestSchemasV2,
  canonicalDatasetV2Bytes,
  createMemoryChannelPair,
  RpcPeer,
  type PanelResourceV2,
  type ResourceOwner,
  type UiDataRequestMapV2,
} from "@kobrixa/plugin-protocol";
import {
  ChannelActivation,
  registerActivationDeadline,
  type Stage3ChannelContext,
  type UiRuntimeAttachment,
} from "@kobrixa/plugin-runtime";
import { runPlugin, type PluginContext } from "../../../../../packages/plugin-sdk-js/src/index.js";
import { bindEventChannel } from "../../../../../packages/plugin-sdk-js/src/events.js";
import { EventLedger } from "../device-broker/registry.js";
import {
  registerUiIpc,
  createUiRegistry,
  createUiChannelBinding,
  createUiExecutionAdapter,
  createPluginUiBridge,
  UiBridgeEvents,
} from "./ui-bridge.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Binding = UiDataRequestMapV2["ui/dataBegin"]["params"]["binding"];
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
async function harness(
  options: {
    version?: string;
    resourceVersion?: 1 | 2;
    ready?: (ctx: PluginContext) => Promise<void>;
  } = {},
) {
  const owner: ResourceOwner = {
    sourceKey: "builtin:test.lab",
    pluginId: "test.lab",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  };
  let scope = { hostEpoch: owner.hostEpoch, workbenchInstance: id(3) },
    current = true,
    permission = true,
    principalOwner = owner,
    now = 0;
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a);
  let ctx!: PluginContext;
  const child = await runPlugin(
    {
      activate(context) {
        ctx = context;
      },
      ...(options.ready ? { ready: options.ready } : {}),
    },
    { channel: b, exit: vi.fn() },
  );
  bindEventChannel(child, owner);
  const ledger = new EventLedger(
    () => now,
    (event) => host.notify("events/deliver", event),
    () => {},
  );
  const { catalog, states, subscriptions, data } = createUiRegistry({
    hostEpoch: owner.hostEpoch,
    broker: { events: ledger },
    now: () => now,
    beforeDelivery: () => {},
    revokeIntent: () => {},
    supportedResourceVersions: [1, 2],
  });
  host.handle("events/ack", ({ subscriptionId, sequence }) =>
    ledger.ack(owner, subscriptionId, sequence),
  );
  const context: Stage3ChannelContext = {
    peer: host,
    owner,
    requirements: [],
    principal: () => ({ kind: "plugin", owner: principalOwner, authorityContext: null }),
  };
  const runtime: UiRuntimeAttachment = {
    activateInitialized: async () => {
      void activation.afterInitialize().catch(() => {});
      return activation.initialized;
    },
    ready: async () => activation.ready,
    current: () => current,
    owners: () => [owner],
    context: () => null,
    commands: () => [],
    invoke: async () => ({ ok: true, value: { output: {}, fieldErrors: [] } }),
    dispatchDrain: async () => {
      throw new Error("no drain");
    },
  };
  const attachment = {
    owner,
    negotiated: vi.fn(),
    activate: (subscriptionId: string) => {
      ledger.activate(owner, subscriptionId);
    },
    abandon: (subscriptionId: string) => {
      ledger.unsubscribe(owner, subscriptionId);
    },
    dispose: () => {},
  };
  const channel = createUiChannelBinding(context, {
    catalog,
    states,
    subscriptions,
    data,
    runtime,
    attachment,
    scope: () => scope,
    hasPanelsPermission: () => permission,
  });
  const abort = new AbortController();
  const offDeadline = registerActivationDeadline(abort.signal, 10000, () => 0);
  const activation = new ChannelActivation(context, channel, abort.signal, () => current);
  const execution = createUiExecutionAdapter({
    catalog,
    states,
    data,
    runtime,
    scope: () => scope,
    now: () => now,
    core: async () => ({ ok: true, value: { output: {}, fieldErrors: [] } }),
  });
  const events = new UiBridgeEvents(() => []);
  const intent = new UiIntent(
    {
      bindMotionScope() {
        throw new Error("no motion");
      },
      pulsePanel() {},
      beginGesture() {
        throw new Error("no motion");
      },
      pulseGesture() {},
      endGesture() {},
      revokeScope() {},
    },
    () => now,
    events.publish,
  );
  const actions = new UserPersistenceActions(
    () => now,
    () => current,
  );
  const bridge = createPluginUiBridge({
    catalog,
    execution,
    intent,
    events,
    actions,
    scope: () => scope,
  });
  cleanups.push(() => {
    activation.dispose();
    offDeadline();
    execution.dispose();
    intent.dispose();
    actions.dispose();
    events.dispose();
    data.dispose();
    subscriptions.dispose();
    ledger.dispose();
    host.close();
    child.close();
  });
  const resource: PanelResourceV2 = {
    kind: "panel",
    root: "root",
    fields: {},
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["info"] },
      { id: "info", type: "status", text: { text: { en: "Ready" } }, tone: "neutral" },
    ],
    data: {
      presentation: {
        schema: {
          type: "number",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          integer: true,
          nullable: false,
        },
        initial: 0,
      },
    },
    datasets: { code: { kind: "code" } },
    presentationKey: "presentation",
  };
  const resourceVersion = options.resourceVersion ?? 2;
  const admittedResource =
    resourceVersion === 2
      ? resource
      : {
          kind: resource.kind,
          root: resource.root,
          nodes: resource.nodes,
          fields: resource.fields,
          data: resource.data,
        };
  const validatedResource = (resourceVersion === 2 ? validateUiResourceV2 : validateUiResource)(
    admittedResource,
    { pluginId: owner.pluginId, commands: [], panels: [] },
    JSON.stringify(admittedResource).length,
  );
  if (!validatedResource.ok) throw new Error(JSON.stringify(validatedResource.error));
  await catalog.replace([
    {
      owner,
      eligible: true,
      resources: { kind: "builtin", files: { "panel.json": JSON.stringify(admittedResource) } },
      commands: [],
      panels: [
        {
          id: "test.lab.panel",
          title: { en: "Panel" },
          location: "right",
          resource: { version: resourceVersion, path: "panel.json" },
        },
      ],
      status: [],
    },
  ]);
  const entry = value(await catalog.catalog({})).entries[0]!;
  expect(entry, JSON.stringify(entry)).toMatchObject({ availability: "available" });
  await host.request("initialize", {
    apiVersion: options.version ?? "1.8.0",
    pluginId: owner.pluginId,
    locale: "en",
    grantedPermissions: ["ui.panels"],
  });
  return {
    hostWire: a,
    wire: b,
    ctx,
    host,
    child,
    bridge,
    data,
    catalog,
    states,
    subscriptions,
    ledger,
    owner,
    activation,
    abort,
    entry,
    open: () =>
      bridge.open({
        sourceKey: entry.sourceKey,
        id: entry.id,
        uiResourceGeneration: entry.uiResourceGeneration,
      }),
    permission: (v: boolean) => {
      permission = v;
    },
    foreign: () => {
      principalOwner = { ...owner, processEpoch: id(99) };
    },
    window: () => {
      scope = { ...scope, workbenchInstance: id(99) };
    },
    retire: () => {
      current = false;
      activation.dispose();
    },
    time: (v: number) => {
      now = v;
    },
  };
}
async function begin(ctx: PluginContext, binding: Binding, baseRevision = 0, presentation = 1) {
  const header = { kind: "code" as const };
  const bytes = canonicalDatasetV2Bytes(header, ["hello"]);
  return value(
    await ctx.ui.data.begin({
      binding,
      dataset: "code",
      baseRevision,
      presentation,
      header,
      entryCount: 1,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  ).transfer;
}
async function publish(ctx: PluginContext, binding: Binding, baseRevision = 0, presentation = 1) {
  const transfer = await begin(ctx, binding, baseRevision, presentation);
  value(
    await ctx.ui.data.chunk({
      binding,
      dataset: "code",
      transfer,
      offset: 0,
      chunk: { kind: "code", entries: ["hello"] },
    }),
  );
  const params = { binding, dataset: "code", transfer };
  value(await ctx.ui.data.commit(params));
  return params;
}
it("actual SDK ready publication, shared ledger and renderer read/snapshot round trip", async () => {
  let initial!: Binding;
  const h = await harness({
    ready: async (ctx) => {
      const bindings = value(await ctx.ui.instances()).instances;
      const binding = bindings[0];
      if (binding?.kind !== "panel") throw new Error("missing panel");
      initial = { ...binding, kind: "panel" };
      await publish(ctx, initial);
    },
  });
  await expect(
    h.ctx.ui.data.snapshot({
      ...h.entry,
      kind: "panel",
      contributionId: h.entry.id,
      panelInstance: id(9),
      generation: 1,
      processEpoch: id(2),
      hostEpoch: id(1),
    }),
  ).rejects.toThrow("not ready");
  const opened = value(await h.open());
  expect(opened.binding).toEqual(initial);
  expect(value(await h.bridge.dataSnapshot({ binding: initial })).datasets).toHaveLength(1);
  const read = { binding: initial, dataset: "code", revision: 1, offset: 0, limit: 10 };
  expect(value(await h.bridge.dataRead(read)).chunk.entries).toEqual(["hello"]);
  expect(await h.ctx.ui.data.read(read)).toEqual(await h.bridge.dataRead(read));
  const delivered: unknown[] = [];
  const subscription = value(
    await h.ctx.ui.subscribe({ topics: ["data"], binding: initial }, (event) => {
      delivered.push(event);
    }),
  );
  expect(subscription.snapshot.data?.[0]?.datasets).toHaveLength(1);
  await publish(h.ctx, initial, 1, 2);
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  expect(delivered[0]).toMatchObject({
    kind: "ui.data",
    owner: h.owner,
    sequence: 1,
    data: { binding: initial, dataset: "code", revision: 2, presentation: 2 },
  });
});
it.each(["1.6.0", "1.7.0", "1.8.0"])(
  "preserves v1 catalog activation for initialized %s",
  async (version) => {
    const h = await harness({ version, resourceVersion: 1 });
    const opened = value(await h.open());
    expect(opened.binding.kind).toBe("panel");
    expect(h.states.instances(h.owner)).toHaveLength(1);
    const state = value(await h.ctx.ui.state(opened.binding));
    expect(state.binding).toEqual(opened.binding);
  },
);
it.each(["1.6.0", "1.7.0"])("denies v2 catalog activation for initialized %s", async (version) => {
  const h = await harness({ version });
  expect((await h.open()).ok).toBe(false);
  expect(h.states.instances(h.owner)).toEqual([]);
  await expect(
    h.ctx.ui.data.snapshot({
      kind: "panel",
      contributionId: "test.lab.panel",
      panelInstance: id(9),
      generation: 1,
      uiResourceGeneration: 1,
      processEpoch: id(2),
      hostEpoch: id(1),
    }),
  ).rejects.toThrow("not ready");
});
it("hide aborts staging but retains committed; close and retirement invalidate reads", async () => {
  const h = await harness();
  const opened = value(await h.open());
  if (opened.binding.kind !== "panel") throw new Error("panel");
  const binding: Binding = { ...opened.binding, kind: "panel" };
  await publish(h.ctx, binding);
  const transfer = await begin(h.ctx, binding, 1, 2);
  value(await h.bridge.visibility({ binding, visible: false, reason: "tab" }));
  expect((await h.ctx.ui.data.commit({ binding, dataset: "code", transfer })).ok).toBe(false);
  expect(value(await h.bridge.dataSnapshot({ binding })).datasets).toHaveLength(1);
  await expect(begin(h.ctx, binding, 1, 2)).rejects.toThrow();
  value(await h.bridge.visibility({ binding, visible: true, reason: "tab" }));
  const aborted = await begin(h.ctx, binding, 1, 2);
  value(await h.ctx.ui.data.abort({ binding, dataset: "code", transfer: aborted }));
  value(await h.bridge.close({ binding }));
  expect((await h.ctx.ui.data.snapshot(binding)).ok).toBe(false);
  h.retire();
  expect((await h.bridge.dataSnapshot({ binding })).ok).toBe(false);
});
it.each(["permission", "foreign", "window", "generation"])(
  "rejects %s authority without exposing payload",
  async (mode) => {
    const h = await harness();
    const opened = value(await h.open());
    if (opened.binding.kind !== "panel") throw new Error("panel");
    let binding: Binding = { ...opened.binding, kind: "panel" };
    await publish(h.ctx, binding);
    if (mode === "permission") h.permission(false);
    if (mode === "foreign") h.foreign();
    if (mode === "window") h.window();
    if (mode === "generation")
      binding = { ...binding, uiResourceGeneration: binding.uiResourceGeneration + 1 };
    if (mode === "foreign") await expect(h.ctx.ui.data.snapshot(binding)).rejects.toThrow();
    else expect((await h.ctx.ui.data.snapshot(binding)).ok).toBe(false);
    expect((await h.bridge.dataSnapshot({ binding })).ok).toBe(false);
  },
);
it("failed ready revokes initial publication and prevents late callbacks", async () => {
  let binding!: Binding;
  const h = await harness({
    ready: async (ctx) => {
      const first = value(await ctx.ui.instances()).instances[0];
      if (first?.kind !== "panel") throw new Error("panel");
      binding = { ...first, kind: "panel" };
      await publish(ctx, binding);
      throw new Error("failed ready");
    },
  });
  expect((await h.open()).ok).toBe(false);
  expect(h.states.instances(h.owner)).toEqual([]);
  expect((await h.bridge.dataSnapshot({ binding })).ok).toBe(false);
});
it("actual commits and scalar patches share ten publications; receipt replay costs nothing", async () => {
  const h = await harness();
  const opened = value(await h.open());
  const binding: Binding = { ...opened.binding, kind: "panel" };
  let last!: Awaited<ReturnType<typeof publish>>;
  for (let n = 0; n < 8; n++) last = await publish(h.ctx, binding, n, n + 1);
  for (let n = 0; n < 6; n++) value(await h.ctx.ui.data.commit(last));
  value(await h.ctx.ui.patch(binding, 0, { presentation: 8 }));
  value(await h.ctx.ui.patch(binding, 1, { presentation: 8 }));
  const transfer = await begin(h.ctx, binding, 8, 9);
  value(
    await h.ctx.ui.data.chunk({
      binding,
      dataset: "code",
      transfer,
      offset: 0,
      chunk: { kind: "code", entries: ["hello"] },
    }),
  );
  expect(await h.ctx.ui.data.commit({ binding, dataset: "code", transfer })).toMatchObject({
    ok: false,
    error: { detail: { reason: "rate" } },
  });
  expect(value(await h.bridge.dataSnapshot({ binding })).datasets[0]?.revision).toBe(8);
});
it("original oversized whitespace frame is denied before reserving staging bytes", async () => {
  const h = await harness();
  const opened = value(await h.open());
  const binding: Binding = { ...opened.binding, kind: "panel" };
  const header = { kind: "code" as const },
    bytes = canonicalDatasetV2Bytes(header, ["hello"]);
  const params = {
    binding,
    dataset: "code",
    baseRevision: 0,
    presentation: 1,
    header,
    entryCount: 1,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const replies: unknown[] = [];
  const send = h.hostWire.send.bind(h.hostWire);
  const spy = vi.spyOn(h.hostWire, "send").mockImplementation((text) => {
    const message = JSON.parse(text);
    if (message.id === "raw-oversized") replies.push(message);
    else send(text);
  });
  cleanups.push(() => spy.mockRestore());
  h.wire.send(
    " ".repeat(65536) +
      JSON.stringify({ jsonrpc: "2.0", id: "raw-oversized", method: "ui/dataBegin", params }),
  );
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]).toHaveProperty("error");
  expect(value(await h.ctx.ui.data.snapshot(binding)).datasets).toEqual([]);
  value(await h.ctx.ui.data.begin(params));
});
it("shared subscription quota, metadata resync and source retirement use the existing ledger", async () => {
  const h = await harness();
  const opened = value(await h.open());
  const binding: Binding = { ...opened.binding, kind: "panel" };
  await publish(h.ctx, binding);
  const subscription = value(await h.ctx.ui.subscribe({ topics: ["data"], binding }, () => {}));
  for (let n = 1; n < 32; n++)
    value(await h.ctx.ui.subscribe({ topics: ["data"], binding }, () => {}));
  expect(await h.ctx.ui.subscribe({ topics: ["data"], binding }, () => {})).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_RESOURCE_LIMIT" },
  });
  const snapshot = vi.spyOn(h.subscriptions, "snapshot");
  const send = h.hostWire.send.bind(h.hostWire);
  const dropped = new Set<string>();
  const filter = vi.spyOn(h.hostWire, "send").mockImplementation((text) => {
    const message = JSON.parse(text);
    if (
      message.method === "events/deliver" &&
      message.params.kind === "ui.data" &&
      !dropped.has(message.params.subscriptionId)
    ) {
      dropped.add(message.params.subscriptionId);
      return;
    }
    send(text);
  });
  cleanups.push(() => filter.mockRestore());
  await publish(h.ctx, binding, 1, 2);
  await publish(h.ctx, binding, 2, 3);
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
  const recovered = value(
    uiRequestSchemasV2["ui/snapshot"].result.parse(snapshot.mock.results[0]!.value),
  );
  expect(recovered.snapshot.data?.[0]?.datasets[0]?.revision).toBe(3);
  expect(JSON.stringify(recovered)).not.toContain("hello");
  h.retire();
  expect(h.states.instances(h.owner)).toEqual([]);
  expect((await h.bridge.dataSnapshot({ binding })).ok).toBe(false);
  expect(h.ledger.owns(h.owner, subscription.subscriptionId)).toBe(false);
});
it("IPC exposes only validated read ports to the trusted current workbench", async () => {
  const h = await harness();
  const binding: Binding = { ...value(await h.open()).binding, kind: "panel" };
  await publish(h.ctx, binding);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let trusted = true;
  registerUiIpc({
    bridge: h.bridge,
    trusted: () => trusted,
    handle: (name, action) => {
      handlers.set(name, (...args) => Reflect.apply(action, undefined, args));
    },
  });
  const event = { sender: { id: 1 }, senderFrame: null };
  const snapshot = handlers.get("plugins:ui:data-snapshot")!;
  const read = handlers.get("plugins:ui:data-read")!;
  expect(await snapshot(event, { binding })).toMatchObject({
    ok: true,
    value: { datasets: [{ dataset: "code" }] },
  });
  expect(
    await read(event, { binding, dataset: "code", revision: 1, offset: 0, limit: 1 }),
  ).toMatchObject({ ok: true, value: { chunk: { entries: ["hello"] } } });
  expect(
    await read(event, { binding, dataset: "code", revision: 1, offset: -1, limit: 1 }),
  ).toMatchObject({ ok: false });
  trusted = false;
  expect(await snapshot(event, { binding })).toMatchObject({ ok: false });
  expect([...handlers.keys()].some((name) => /data-(begin|chunk|commit|abort)/.test(name))).toBe(
    false,
  );
});
it("cancelled ready clears initial data before a delayed SDK callback returns", async () => {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  let binding!: Binding;
  const h = await harness({
    ready: async (ctx) => {
      const first = value(await ctx.ui.instances()).instances[0]!;
      binding = { ...first, kind: "panel" };
      await publish(ctx, binding);
      entered();
      await gate;
    },
  });
  const opening = h.open();
  await reached;
  h.abort.abort(new Error("activation cancelled"));
  release();
  expect((await opening).ok).toBe(false);
  await vi.waitFor(() => expect(h.states.instances(h.owner)).toEqual([]));
  expect((await h.bridge.dataSnapshot({ binding })).ok).toBe(false);
});
it("catalog removal physically withdraws old data and staging registrations", async () => {
  const h = await harness();
  const binding: Binding = { ...value(await h.open()).binding, kind: "panel" };
  await publish(h.ctx, binding);
  const transfer = await begin(h.ctx, binding, 1, 2);
  const close = vi.spyOn(h.data.store, "close");
  await h.catalog.replace([]);
  expect(close).toHaveBeenCalledWith(h.owner, binding);
  expect(h.states.instances(h.owner)).toEqual([]);
  expect((await h.ctx.ui.data.commit({ binding, dataset: "code", transfer })).ok).toBe(false);
  expect((await h.bridge.dataSnapshot({ binding })).ok).toBe(false);
});
