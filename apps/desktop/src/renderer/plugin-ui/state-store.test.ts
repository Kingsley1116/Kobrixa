import { expect, it, vi } from "vitest";
import { fixture, snapshot, panel, binding, deferred, entry } from "./contract.test.js";
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
  expect(store.form()).toMatchObject({ form: { speed: null, enabled: false }, formRevision: 1 });
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
