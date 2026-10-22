import { expect, it, vi } from "vitest";
import { fixture, snapshot, panel, binding, deferred, entry, handle, validationContext } from "./contract.test.js";
import { UiStateStore, scalarValid, diagnosticsFor } from "./state-store.js";
it("U05 preserves invalid raw draft, focus identity and full form while reconciling one snapshot", async () => {
  const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.bridge.snapshot>>>();
  f.bridge.snapshot.mockReturnValueOnce(pending.promise);
  const store = new UiStateStore(f.bridge, panel, snapshot());
  store.edit("speed", null, "-");
  const first = store.invalidate(1); void store.invalidate(2);
  expect(f.bridge.snapshot).toHaveBeenCalledTimes(1);
  pending.resolve({ ok: true, value: snapshot(2) }); await first;
  expect(store.getSnapshot().raw.speed).toBe("-");
  expect(store.form()).toMatchObject({ form: { speed: null, enabled: false }, formRevision: 0 });
  expect(store.valid()).toBe(false);
  expect(store.getSnapshot().snapshot.binding).toEqual(binding);
  expect(store.getSnapshot().snapshot.data.count).toBe(2);
});
it("U04/U07 ignores late errors and snapshots after edits or retirement; no replay", async () => {
  const f = fixture(); const call = deferred<Awaited<ReturnType<typeof f.bridge.invoke>>>();
  f.bridge.invoke.mockReturnValue(call.promise);
  const store = new UiStateStore(f.bridge, panel, snapshot());
  const invoke = store.invoke("go"); store.edit("speed", 1, "1");
  call.resolve({ ok: true, value: { output: {}, fieldErrors: [{ field: "speed", message: { en: "Old" } }] } });
  await invoke; expect(store.getSnapshot().errors).toEqual({});
  store.retire(); await store.invalidate(3); await store.invoke("go");
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
  expect(f.bridge.snapshot).not.toHaveBeenCalled();
});
it("U01/U15 accepts false/zero, validates 1e-9 grid tolerance and validates active fields only", () => {
  expect(scalarValid(panel.fields.speed!.schema, 0)).toBe(true);
  const f = fixture(); const resource = structuredClone(panel);
  resource.nodes.find((node) => node.id === "speed")!.visibleWhen = { op: "eq", left: { scope: "form", key: "enabled" }, right: true };
  const store = new UiStateStore(f.bridge, resource, snapshot());
  store.edit("speed", null, "-"); expect(store.valid()).toBe(true);
  store.edit("enabled", true); expect(store.valid()).toBe(false);
  store.edit("speed", 0.30000000000000004); expect(store.valid()).toBe(true);
  store.edit("speed", 0.35); expect(store.valid()).toBe(false);
  expect(store.form().form.speed).toBe(0.35); // never mask the request in renderer
});
it("U04 retains retired state while a previously requested snapshot arrives late", async () => {
  const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.bridge.snapshot>>>();
  f.bridge.snapshot.mockReturnValue(pending.promise);
  const state = new UiStateStore(f.bridge, panel, snapshot()); const work = state.invalidate(10);
  state.edit("speed", null, "-"); state.retire();
  pending.resolve({ ok: true, value: snapshot(10) }); await work;
  expect(state.getSnapshot().snapshot.revision).toBe(0);
  expect(state.getSnapshot().raw.speed).toBe("-"); expect(state.getSnapshot().active).toBe(false);
});


it("AM-22 exposes immutable observations and cancels pending deadlines on retire", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); const state = new UiStateStore(f.bridge, panel, snapshot());
    state.setDiagnosticOwner({ sourceKey: entry.sourceKey, pluginId: entry.pluginId,
      generation: binding.generation, hostEpoch: binding.hostEpoch, processEpoch: binding.processEpoch });
    const diagnostics = diagnosticsFor(state); const events: string[] = [];
    const off = diagnostics.onEvent((event) => { expect(event.time).toBeGreaterThan(0); events.push(event.kind); });
    await state.invalidate(1);
    expect(events).toEqual([]); expect(diagnostics.snapshot().queuedBytes).toBeGreaterThan(0);
    state.renderCommitted(1); state.renderCommitted(1);
    expect(events).toEqual(["apply"]); expect(diagnostics.snapshot().queuedBytes).toBe(0);
    state.intentRevoked(); expect(events).toEqual(["apply", "revoke"]);
    f.bridge.snapshot.mockReturnValue(new Promise(() => {})); const pending = state.invalidate(2);
    expect(diagnostics.snapshot().timers).toBe(1);
    state.retire(); await pending; off();
    expect(Object.values(diagnostics.snapshot()).every((value) => value === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(() => diagnosticsFor({})).toThrow();
  } finally { vi.useRealTimers(); }
});

it("bounds raw input at 4,000 code points without publishing an oversized edit", () => {
  const state = new UiStateStore(fixture().bridge, panel, snapshot());
  state.edit("speed", null, "😀".repeat(4000));
  expect(Array.from(state.getSnapshot().raw.speed!)).toHaveLength(4000);
  const previous = state.getSnapshot();
  state.edit("speed", 1, "😀".repeat(4001));
  expect(state.getSnapshot()).toBe(previous);
  state.retire();
});

it("C-G1 restoration is a cloned local draft with fresh revision and no edit or action notification", () => {
  const f = fixture(); const source = { draft: { speed: null as number | null, enabled: true, foreign: 7 }, raw: { speed: "-" } };
  const initial = { ...snapshot(4), formRevision: 11 };
  const store = new UiStateStore(f.bridge, panel, initial, source);
  const edit = vi.fn(); store.onEdit = edit;
  source.raw.speed = "5"; source.draft.speed = 5;
  expect(store.getSnapshot()).toMatchObject({ draft: { speed: null, enabled: true }, raw: { speed: "-" }, localRevision: 1, errors: {}, problem: null, busy: false });
  expect(store.getSnapshot().snapshot).toBe(initial); expect(initial.form.speed).toBe(0);
  expect(store.valid()).toBe(false); expect(edit).not.toHaveBeenCalled(); expect(f.bridge.invoke).not.toHaveBeenCalled();
  store.edit("speed", 5, "5"); expect(edit).toHaveBeenCalledTimes(1); expect(store.form().formRevision).toBe(11); store.retire();
});

import { UiStateRegistry } from "../../../../../packages/plugin-runtime/src/ui-state.js";
import { RpcPeer, createMemoryChannelPair, type ResourceOwner } from "@kobrixa/plugin-protocol";
import { buildInvocation } from "../../main/plugins/ui-bridge.js";
import { UiIntentController } from "./intent-controller.js";
async function admittedStore() {
  const f = fixture(); const owner: ResourceOwner = { sourceKey: entry.sourceKey, pluginId: entry.pluginId,
    generation: binding.generation, hostEpoch: binding.hostEpoch, processEpoch: binding.processEpoch };
  const registry = new UiStateRegistry({ current: () => true });
  const [wire] = createMemoryChannelPair(); const peer = new RpcPeer(wire);
  const opened = await registry.open({ owner: entry, id: entry.id, resource: panel,
    scope: { hostEpoch: binding.hostEpoch, workbenchInstance: handle(50) },
    activateInitialized: async () => ({ owner, peer, requirements: [], principal: () => ({ kind: "plugin", owner, authorityContext: null }) }) });
  if (!opened.ok) throw new Error("open");
  registry.visibility(owner, opened.value.binding, true); opened.value.visible = true;
  const commands = new Map(validationContext.commands.map((command) => [command.id, command]));
  const accept = (input: Parameters<typeof f.bridge.invoke>[0], hold = false) => {
    const current = registry.state(owner, input.binding); if (!current.ok) throw new Error("snapshot");
    const built = buildInvocation({ owner, state: current.value, resource: panel, commands, contextRef: null, workbenchInstance: handle(50) },
      input.nodeId, input.formRevision, input.form, hold ? { kind: "hold", phase: "begin", gestureRef: handle(51) } : { kind: "activate" });
    expect(built.ok).toBe(true); if (!built.ok) throw new Error("buildInvocation rejected");
    expect(registry.setForm(owner, input.binding, input.formRevision, built.value.context.form!.values, true).ok).toBe(true);
  };
  f.bridge.snapshot.mockImplementation(async () => registry.state(owner, opened.value.binding));
  f.bridge.invoke.mockImplementation(async (input) => { accept(input); return { ok: true, value: { output: {}, fieldErrors: [] } }; });
  f.bridge.hold.mockImplementation(async (input) => { if (input.phase === "begin") accept(input, true); return { ok: true, value: { gesture: input.phase === "begin" ? handle(51) : null } }; });
  const store = new UiStateStore(f.bridge, panel, opened.value, { draft: { speed: 2, enabled: false }, raw: { speed: "2" } });
  return { f, store, registry, owner, accept, dispose: () => { store.retire(); peer.close(); } };
}
it("C-G1 restored invoke and repeated edited actions satisfy real main and registry admission", async () => {
  const h = await admittedStore();
  try {
    await h.store.invoke("go");
    h.store.edit("speed", 3, "3"); h.store.edit("speed", 4, "4"); await h.store.invoke("go");
    h.store.edit("speed", 5, "5"); await h.store.invoke("go");
    expect(h.f.bridge.invoke.mock.calls.map(([input]) => input.formRevision)).toEqual([1, 2, 3]);
    expect(h.f.bridge.snapshot).toHaveBeenCalledTimes(2);
  } finally { h.dispose(); }
});
it("C-G1 restored hold is admitted and cleanup carries original submission before edited draft", async () => {
  const h = await admittedStore(); const intent = new UiIntentController(h.f.bridge, h.store);
  try {
    expect(intent.begin("hold", { trusted: true, kind: "key", id: "Enter", primary: true, repeat: false })).toBe(true);
    h.store.edit("speed", 9, "9");
    const [begin, cancel] = h.f.bridge.hold.mock.calls.map(([input]) => input);
    expect(begin).toMatchObject({ phase: "begin", formRevision: 1, form: { speed: 2 } });
    expect(cancel).toEqual({ ...begin, phase: "cancel" });
    await vi.waitFor(() => expect(h.store.getSnapshot().busy).toBe(false)); await h.store.invoke("go");
    expect(h.f.bridge.invoke.mock.calls[0]![0]).toMatchObject({ formRevision: 2, form: { speed: 9 } });
  } finally { intent.dispose(); h.dispose(); }
});
it.each(["lost", "rejected", "denied"])("C-G1 %s result reconciles only on explicit next action, never replays", async (mode) => {
  const h = await admittedStore();
  try {
    h.f.bridge.invoke.mockImplementationOnce(async (input) => {
      if (mode !== "denied") h.accept(input);
      if (mode === "lost") throw new Error("lost transport reply");
      return { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Rejected" } };
    });
    await h.store.invoke("go"); h.store.edit("speed", 7, "7");
    expect(h.f.bridge.invoke).toHaveBeenCalledTimes(1); expect(h.f.bridge.snapshot).not.toHaveBeenCalled();
    await h.store.invoke("go");
    expect(h.f.bridge.invoke).toHaveBeenCalledTimes(2);
    expect(h.f.bridge.invoke.mock.calls[1]![0]).toMatchObject({ formRevision: mode === "denied" ? 1 : 2, form: { speed: 7 } });
  } finally { h.dispose(); }
});
it("C-G1 real admitted late errors cannot affect a new draft; next submission reconciles", async () => {
  const h = await admittedStore(); const reply = deferred<Awaited<ReturnType<typeof h.f.bridge.invoke>>>();
  try {
    h.f.bridge.invoke.mockImplementationOnce((input) => { h.accept(input); return reply.promise; });
    const work = h.store.invoke("go"); h.store.edit("speed", 8, "8");
    reply.resolve({ ok: true, value: { output: {}, fieldErrors: [{ field: "speed", message: { en: "Old" } }] } });
    await work; expect(h.store.getSnapshot().errors).toEqual({});
    await h.store.invoke("go"); expect(h.f.bridge.invoke.mock.calls[1]![0].formRevision).toBe(2);
  } finally { h.dispose(); }
});
it("C-G1 lost hold reply times out, cancels once, and the next explicit hold reconciles without replay", async () => {
  vi.useFakeTimers(); const h = await admittedStore(); const intent = new UiIntentController(h.f.bridge, h.store);
  try {
    h.f.bridge.hold.mockImplementationOnce((input) => { h.accept(input, true); return new Promise(() => {}); });
    const input = { trusted: true, kind: "key" as const, id: "Enter", primary: true, repeat: false };
    expect(intent.begin("hold", input)).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual(["begin", "cancel"]);
    expect(h.f.bridge.snapshot).not.toHaveBeenCalled(); expect(h.store.getSnapshot().busy).toBe(false);
    expect(intent.begin("hold", input)).toBe(true); await vi.advanceTimersByTimeAsync(0);
    expect(h.f.bridge.hold.mock.calls.map(([input]) => [input.phase, input.formRevision])).toEqual([["begin", 1], ["cancel", 1], ["begin", 2]]);
    intent.release("key", "Enter", false);
  } finally { intent.dispose(); h.dispose(); vi.useRealTimers(); }
});
it("C-G1 editing or releasing during explicit reconciliation cannot dispatch a delayed action", async () => {
  const h = await admittedStore(); const intent = new UiIntentController(h.f.bridge, h.store);
  try {
    await h.store.invoke("go");
    const pending = deferred<Awaited<ReturnType<typeof h.f.bridge.snapshot>>>(); h.f.bridge.snapshot.mockReturnValueOnce(pending.promise);
    const work = h.store.invoke("go"); h.store.edit("speed", 6, "6");
    pending.resolve(h.registry.state(h.owner, h.store.form().binding)); await work;
    expect(h.f.bridge.invoke).toHaveBeenCalledTimes(1);
    await h.store.invoke("go");
    const next = deferred<Awaited<ReturnType<typeof h.f.bridge.snapshot>>>(); h.f.bridge.snapshot.mockReturnValueOnce(next.promise);
    expect(intent.begin("hold", { trusted: true, kind: "key", id: "Enter", primary: true, repeat: false })).toBe(true);
    intent.release("key", "Enter", false); next.resolve(h.registry.state(h.owner, h.store.form().binding));
    await vi.waitFor(() => expect(h.store.getSnapshot().busy).toBe(false));
    expect(h.f.bridge.hold).not.toHaveBeenCalled();
  } finally { intent.dispose(); h.dispose(); }
});
it("C-G1 a failed reconciliation sends nothing and requires another explicit action", async () => {
  const h = await admittedStore();
  try {
    await h.store.invoke("go");
    h.f.bridge.snapshot.mockRejectedValueOnce(new Error("snapshot unavailable"));
    await h.store.invoke("go"); expect(h.f.bridge.invoke).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot()).toMatchObject({ busy: false, problem: "snapshot" });
    await h.store.invoke("go"); expect(h.f.bridge.invoke).toHaveBeenCalledTimes(2);
    expect(h.f.bridge.invoke.mock.calls[1]![0].formRevision).toBe(2);
  } finally { h.dispose(); }
});
