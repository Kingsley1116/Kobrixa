import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
import type { Stage3ChannelContext } from "./ui-lifecycle.js";
function initializedChannel(): Stage3ChannelContext {
  const [channel] = createMemoryChannelPair();
  return {
    peer: new RpcPeer(channel),
    owner,
    requirements: [],
    principal: () => ({ kind: "plugin", owner, authorityContext: null }),
  };
}
import { expect, it } from "vitest";
import { UiStateRegistry } from "./ui-state.js";
import type {
  PanelResourceV1,
  ResourceOwner,
  UiOwner,
  UiStateSnapshot,
} from "@kobrixa/plugin-protocol";
const h = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: ResourceOwner = {
  sourceKey: "source",
  pluginId: "test.ui",
  generation: 1,
  hostEpoch: h(1),
  processEpoch: h(2),
};
const uiOwner: UiOwner = {
  sourceKey: owner.sourceKey,
  pluginId: owner.pluginId,
  uiResourceGeneration: 1,
};
const resource = (): PanelResourceV1 => ({
  kind: "panel",
  root: "root",
  data: {
    count: {
      schema: { type: "number", min: 0, max: 100, nullable: false, integer: true },
      initial: 0,
    },
    text: { schema: { type: "string", maxLength: 4000, nullable: false }, initial: "initial" },
  },
  fields: {
    draft: {
      schema: { type: "string", maxLength: 100, nullable: true },
      initial: "kept",
      required: true,
    },
  },
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["input"] },
    { id: "input", type: "textInput", field: "draft", label: { en: "Draft" } },
  ],
});
const scope = { hostEpoch: h(1), workbenchInstance: h(3) };
const open = async (
  registry: UiStateRegistry,
  id = "test.ui.panel",
  workbenchInstance = scope.workbenchInstance,
) => {
  const result = await registry.open({
    owner: uiOwner,
    id,
    scope: { ...scope, workbenchInstance },
    resource: resource(),
    activateInitialized: async () => initializedChannel(),
  });
  if (!result.ok) throw new Error("open failed");
  return result.value;
};
it("U05 commits all patch keys together and preserves the host draft", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const initial = await open(registry);
  const bad = registry.patch(owner, {
    binding: initial.binding,
    baseRevision: 0,
    set: { count: 1, text: 99 },
  });
  expect(bad.ok).toBe(false);
  expect(registry.state(owner, initial.binding)).toMatchObject({
    ok: true,
    value: { revision: 0, data: { count: 0, text: "initial" }, form: { draft: "kept" } },
  });
  expect(
    registry.patch(owner, { binding: initial.binding, baseRevision: 0, set: { count: 1 } }),
  ).toEqual({ ok: true, value: { revision: 1 } });
  expect(registry.state(owner, initial.binding)).toMatchObject({
    ok: true,
    value: { formRevision: 0, form: { draft: "kept" } },
  });
  expect(
    registry.patch(owner, { binding: initial.binding, baseRevision: 0, set: { count: 2 } }),
  ).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_STALE_RESOURCE", detail: { kind: "resource", reason: "stale" } },
  });
});
it("U05 enforces four queued accepted patches independently of ten-per-second rate", async () => {
  let now = 0;
  const registry = new UiStateRegistry({ current: () => true, now: () => now });
  const initial = await open(registry);
  for (let n = 0; n < 4; n++)
    expect(
      registry.patch(owner, { binding: initial.binding, baseRevision: n, set: { count: n + 1 } })
        .ok,
    ).toBe(true);
  expect(
    registry.patch(owner, { binding: initial.binding, baseRevision: 4, set: { count: 5 } }),
  ).toMatchObject({
    ok: false,
    error: { detail: { kind: "resource", reason: "queue", limit: 4 } },
  });
  registry.flush();
  for (let n = 4; n < 10; n++) {
    expect(
      registry.patch(owner, { binding: initial.binding, baseRevision: n, set: { count: n + 1 } })
        .ok,
    ).toBe(true);
    registry.flush();
  }
  expect(
    registry.patch(owner, { binding: initial.binding, baseRevision: 10, set: { count: 11 } }),
  ).toMatchObject({
    ok: false,
    error: { detail: { kind: "resource", reason: "rate", limit: 10 } },
  });
  now = 1000;
  expect(
    registry.patch(owner, { binding: initial.binding, baseRevision: 10, set: { count: 11 } }).ok,
  ).toBe(true);
});
it("U04 denies foreign bindings and late patches after close", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const initial = await open(registry);
  expect(registry.state({ ...owner, sourceKey: "foreign" }, initial.binding).ok).toBe(false);
  expect(registry.state(owner, { ...initial.binding, processEpoch: h(99) }).ok).toBe(false);
  expect(registry.close(owner, initial.binding).ok).toBe(true);
  expect(
    registry.patch(owner, { binding: initial.binding, baseRevision: 0, set: { count: 1 } }).ok,
  ).toBe(false);
});
it("U03 reserves instance quota before activation and retirement rejects the late activation", async () => {
  let current = true;
  let release!: (value: Stage3ChannelContext) => void;
  const gate = new Promise<Stage3ChannelContext>((resolve) => {
    release = resolve;
  });
  const registry = new UiStateRegistry({ current: () => current });
  const pending = Array.from({ length: 4 }, (_, n) =>
    registry.open({
      owner: uiOwner,
      id: `test.ui.p${n}`,
      scope,
      resource: resource(),
      activateInitialized: () => gate,
    }),
  );
  expect(
    await registry.open({
      owner: uiOwner,
      id: "test.ui.extra",
      scope,
      resource: resource(),
      activateInitialized: () => gate,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_RESOURCE_LIMIT" },
  });
  current = false;
  registry.retireResource(uiOwner, "resource-replaced");
  release(initializedChannel());
  expect((await Promise.all(pending)).every((result) => !result.ok)).toBe(true);
  expect(registry.instances(owner)).toEqual([]);
});
it("U03 allows only one instance per contribution/window but counts every window", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const first = await open(registry);
  const again = await open(registry);
  expect(again.binding.panelInstance).toBe(first.binding.panelInstance);
  await open(registry, "test.ui.panel", h(4));
  await open(registry, "test.ui.panel", h(5));
  await open(registry, "test.ui.panel", h(6));
  expect(
    await registry.open({
      owner: uiOwner,
      id: "test.ui.panel",
      scope: { ...scope, workbenchInstance: h(7) },
      resource: resource(),
      activateInitialized: async () => initializedChannel(),
    }),
  ).toMatchObject({ ok: false });
});
it("U05 terminal revocation bypasses coalesced progress", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const snapshot = await open(registry);
  const events: string[] = [];
  registry.onEvent((_owner, event) => events.push(event.kind));
  registry.patch(owner, { binding: snapshot.binding, baseRevision: 0, set: { count: 1 } });
  registry.retireExecution(owner, "process-gone");
  registry.flush();
  expect(events).toEqual(["ui.revoked", "ui.instances"]);
});
it("U05 rejects a 64KiB-plus patch before changing state", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const snapshot = await open(registry);
  const set = Object.fromEntries(
    Array.from({ length: 64 }, (_, n) => [`key-${n}`, "x".repeat(4000)]),
  );
  expect(registry.patch(owner, { binding: snapshot.binding, baseRevision: 0, set }).ok).toBe(false);
  expect(
    (registry.state(owner, snapshot.binding) as { ok: true; value: UiStateSnapshot }).value
      .revision,
  ).toBe(0);
});

it("captures pending opens without awaiting ready or later opens", async () => {
  const states = new UiStateRegistry({ current: () => true });
  let release!: (value: Stage3ChannelContext) => void;
  const initialized = new Promise<Stage3ChannelContext>((resolve) => {
    release = resolve;
  });
  const opening = states.open({
    owner: uiOwner,
    id: "test.ui.panel",
    scope,
    resource: resource(),
    activateInitialized: () => initialized,
  });
  let done = false;
  const latch = states.initialBindingsReady(owner, new AbortController().signal).then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  const later = new AbortController();
  const laterOpen = states.open({
    owner: uiOwner,
    id: "test.ui.other",
    scope,
    resource: resource(),
    signal: later.signal,
    activateInitialized: () => new Promise(() => {}),
  });
  const channel = initializedChannel();
  release(channel);
  expect((await opening).ok).toBe(true);
  await latch;
  expect(done).toBe(true);
  later.abort();
  expect((await laterOpen).ok).toBe(false);
  channel.peer.close();
});
it.each(["failure", "cancel", "replace"] as const)(
  "releases captured reservations on %s",
  async (mode) => {
    const states = new UiStateRegistry({ current: () => true });
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    const open = states.open({
      owner: uiOwner,
      id: "test.ui.panel",
      scope,
      resource: resource(),
      signal: controller.signal,
      activateInitialized: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    const latch = states.initialBindingsReady(owner, new AbortController().signal);
    await Promise.resolve();
    if (mode === "failure") fail(new Error("launch failed"));
    else if (mode === "cancel") controller.abort();
    else states.retireResource(uiOwner, "resource-replaced");
    expect((await open).ok).toBe(false);
    await latch;
  },
);
it("command/onPanel launch with no open resolves in the next microtask", async () => {
  const states = new UiStateRegistry({ current: () => true });
  await states.initialBindingsReady(owner, new AbortController().signal);
  expect(states.instances(owner)).toEqual([]);
});
it("aborted initialization cancels captured opens and rejects its waiter", async () => {
  const states = new UiStateRegistry({ current: () => true });
  const open = states.open({
    owner: uiOwner,
    id: "test.ui.panel",
    scope,
    resource: resource(),
    activateInitialized: () => new Promise(() => {}),
  });
  const signal = new AbortController();
  const latch = states.initialBindingsReady(owner, signal.signal);
  signal.abort(new Error("original deadline"));
  await expect(latch).rejects.toThrow("original deadline");
  expect((await open).ok).toBe(false);
});

import { currentStatusBindings, diagnosticsFor } from "./ui-state.js";
it("lazy first-open registers initial instances before ready and shares one activation", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  let initialized!: (channel: Stage3ChannelContext) => void;
  const barrier = new Promise<Stage3ChannelContext>((resolve) => {
    initialized = resolve;
  });
  let activations = 0;
  const input = {
    owner: uiOwner,
    id: "test.ui.panel",
    scope,
    resource: resource(),
    activateInitialized: () => {
      activations++;
      return barrier;
    },
  };
  const first = registry.open(input);
  const second = registry.open(input);
  await Promise.resolve();
  expect(registry.instances(owner)).toEqual([]);
  initialized(initializedChannel());
  const opened = await first;
  expect(opened.ok).toBe(true);
  expect(await second).toEqual(opened);
  expect(activations).toBe(1);
  // R160 initialized callback awaits this open, releases the initial-binding latch,
  // then sends ui/ready. Its ready callback can immediately query this binding.
  expect(registry.instances(owner)).toHaveLength(1);
  expect(diagnosticsFor(registry).snapshot().bindings).toBe(1);
  registry.retireExecution(owner, "process-gone");
  expect(diagnosticsFor(registry).snapshot().bindings).toBe(0);
  expect(() => diagnosticsFor({})).toThrow("Unknown UI state instance");
});
it("replays only live status revisions in the main-derived workbench scope", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const result = await registry.open({
    owner: uiOwner,
    id: "test.ui.status",
    scope,
    resource: { kind: "status", data: {}, text: { text: { en: "Ready" } }, tone: "info" },
    activateInitialized: async () => initializedChannel(),
  });
  if (!result.ok) throw new Error("status open failed");
  expect(currentStatusBindings(registry, scope)).toEqual([
    { binding: result.value.binding, revision: 0 },
  ]);
  expect(currentStatusBindings(registry, { ...scope, workbenchInstance: h(99) })).toEqual([]);
  registry.close(owner, result.value.binding);
  expect(currentStatusBindings(registry, scope)).toEqual([]);
});

it("closed notification receipts are bounded, owner scoped, and retired exactly once without live bindings", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const events: string[] = [];
  registry.onEvent((_owner, event) => {
    if (event.kind === "ui.revoked") events.push(event.data.reason);
  });
  // Distinct windows create receipts; repeat close in a window replaces its receipt.
  for (let n = 0; n < 257; n++) {
    const state = await open(registry, "test.ui.panel", h(n + 100));
    expect(registry.close(owner, state.binding).ok).toBe(true);
  }
  expect(events.filter((reason) => reason === "overflow")).toHaveLength(1);
  events.length = 0;
  registry.retireExecution({ ...owner, processEpoch: h(99) }, "process-gone");
  expect(events).toEqual([]);
  registry.retireResource({ ...uiOwner, uiResourceGeneration: 2 }, "resource-replaced");
  expect(events).toEqual([]);
  registry.retireExecution(owner, "process-gone");
  expect(events).toHaveLength(256);
  expect(events.every((reason) => reason === "process-gone")).toBe(true);
  events.length = 0;
  registry.retireExecution(owner, "process-gone");
  expect(events).toEqual([]);
  expect(registry.instances(owner)).toEqual([]);
});
it("resource retirement notifies closed panels and leaves unrelated resource owners available", async () => {
  const registry = new UiStateRegistry({ current: () => true });
  const state = await open(registry);
  registry.close(owner, state.binding);
  const events: string[] = [];
  registry.onEvent((_owner, event) => {
    if (event.kind === "ui.revoked") events.push(event.data.reason);
  });
  registry.retireResource(uiOwner, "resource-replaced");
  expect(events).toEqual(["resource-replaced"]);
  registry.retireExecution(owner, "process-gone");
  expect(events).toHaveLength(1);
  expect((await open(registry)).formRevision).toBe(0);
});
