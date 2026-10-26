import { afterEach, expect, it, vi } from "vitest";
import type { PluginUiBridge } from "@kobrixa/plugin-runtime";
import type { PanelResourceV2, UiStateSnapshot } from "@kobrixa/plugin-protocol";
import { UiStateStore } from "./state-store.js";
import { fixture, snapshot, panel, deferred, binding, handle } from "./contract.test.js";
afterEach(() => vi.useRealTimers());
const resource: PanelResourceV2 = {
  ...panel,
  formSync: true,
  presentationKey: "presentation",
  datasets: {},
  data: {
    ...panel.data,
    presentation: {
      schema: {
        type: "number",
        nullable: false,
        integer: true,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      },
      initial: 0,
    },
  },
  fields: {
    text: {
      schema: { type: "string", nullable: false, maxLength: 4000 },
      initial: "",
      required: false,
    },
    mode: { schema: { type: "boolean", nullable: false }, initial: false, required: false },
    hidden: {
      schema: { type: "string", nullable: false, maxLength: 4000 },
      initial: "kept",
      required: false,
    },
  },
  nodes: [
    {
      id: "root",
      type: "group",
      layout: "stack",
      children: ["text", "mode", "hidden", "go", "stop"],
    },
    { id: "text", type: "textInput", field: "text", label: { en: "Text" } },
    { id: "mode", type: "boolean", field: "mode", label: { en: "Mode" } },
    {
      id: "hidden",
      type: "textInput",
      field: "hidden",
      label: { en: "Hidden" },
      visibleWhen: { op: "eq", left: { scope: "form", key: "mode" }, right: true },
    },
    {
      id: "go",
      type: "action",
      label: { en: "Go" },
      variant: "primary",
      action: { kind: "command", command: "acme.ui.go", arguments: {} },
    },
    {
      id: "stop",
      type: "action",
      label: { en: "Stop" },
      variant: "danger",
      action: {
        kind: "core",
        action: "stopRecording",
        reservation: { scope: "data", key: "reservation" },
      },
    },
  ],
};
function setup(correlated = false) {
  vi.useFakeTimers();
  const f = fixture();
  let host: UiStateSnapshot = {
    ...snapshot(),
    form: { text: "", mode: false, hidden: "kept" },
    data: { count: 0, presentation: 0, reservation: handle(9) },
  };
  f.bridge.snapshot.mockImplementation(async () => ({ ok: true, value: structuredClone(host) }));
  const syncForm = vi.fn<NonNullable<PluginUiBridge["syncForm"]>>(async (q) => {
    if (q.baseFormRevision !== host.formRevision)
      return { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "stale" } };
    host = { ...host, formRevision: host.formRevision + 1, form: { ...q.form } };
    return {
      ok: true,
      value: {
        formRevision: host.formRevision,
        editSequence: q.editSequence,
        form: { ...host.form },
      },
    };
  });
  const bridge = { ...f.bridge, syncForm };
  const selectedResource = structuredClone(resource);
  if (correlated) {
    selectedResource.derivedFormRevisionKey = "derived";
    selectedResource.data.derived = { ...structuredClone(selectedResource.data.presentation!) };
    host.data.derived = 0;
  }
  const state = new UiStateStore(bridge, selectedResource, structuredClone(host));
  return {
    ...f,
    bridge,
    syncForm,
    state,
    host: () => host,
    patch: (form: Partial<UiStateSnapshot["form"]>) => {
      host = {
        ...host,
        formRevision: host.formRevision + 1,
        form: { ...host.form, ...form } as UiStateSnapshot["form"],
      };
    },
  };
}
it("coalesces one in-flight/latest draft at <=10 dispatches/s without losing hidden values", async () => {
  const f = setup();
  const gate = deferred<Awaited<ReturnType<typeof f.syncForm>>>();
  const real = f.syncForm.getMockImplementation()!;
  f.syncForm.mockImplementationOnce(async (q) => {
    await gate.promise;
    return real(q);
  });
  f.state.edit("text", "first");
  await vi.advanceTimersByTimeAsync(0);
  for (let n = 0; n < 30; n++) f.state.edit("text", String(n));
  await vi.advanceTimersByTimeAsync(50);
  expect(f.syncForm).toHaveBeenCalledOnce();
  gate.resolve({ ok: true, value: { formRevision: 1, editSequence: 1, form: {} } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state.getSnapshot().draft.text).toBe("29");
  await vi.advanceTimersByTimeAsync(49);
  expect(f.syncForm).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.syncForm).toHaveBeenCalledTimes(2);
  expect(f.syncForm.mock.lastCall?.[0]).toMatchObject({
    baseFormRevision: 1,
    editSequence: 31,
    form: { text: "29", hidden: "kept" },
  });
  expect(f.state.formCurrent()).toBe(true);
  f.state.retire();
});
it("a plugin patch with unchanged scalar revision backfills only when no local edit is newer", async () => {
  const f = setup();
  f.patch({ text: "capture" });
  await f.state.invalidateForm(1);
  expect(f.state.getSnapshot()).toMatchObject({
    draft: { text: "capture" },
    snapshot: { revision: 0, formRevision: 1 },
  });
  f.state.edit("text", "unsent");
  f.patch({ text: "late capture" });
  await f.state.invalidateForm(2);
  expect(f.state.getSnapshot().draft.text).toBe("unsent");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.syncForm.mock.lastCall?.[0]).toMatchObject({
    baseFormRevision: 2,
    form: { text: "unsent" },
  });
  f.state.retire();
});
it("preserves a pending newer edit when a snapshot arrives before an earlier sync receipt", async () => {
  const f = setup();
  const gate = deferred<Awaited<ReturnType<typeof f.syncForm>>>();
  const real = f.syncForm.getMockImplementation()!;
  let accepted: Awaited<ReturnType<typeof f.syncForm>>;
  f.syncForm.mockImplementationOnce(async (q) => {
    accepted = await real(q);
    return gate.promise;
  });
  f.state.edit("text", "first");
  await vi.advanceTimersByTimeAsync(0);
  f.state.edit("text", "newer");
  f.patch({ text: "patch after first" });
  await f.state.invalidateForm(2);
  gate.resolve(accepted!);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.host().form.text).toBe("newer");
  expect(f.state.getSnapshot().snapshot.formRevision).toBe(3);
  f.state.retire();
});
it("flushes full canonical form before a normal command while core Stop bypasses the sync", async () => {
  const f = setup();
  const gate = deferred<Awaited<ReturnType<typeof f.syncForm>>>();
  const real = f.syncForm.getMockImplementation()!;
  f.syncForm.mockImplementationOnce(async (q) => {
    await gate.promise;
    return real(q);
  });
  f.state.edit("text", "-"); // a string field accepts incomplete numeric editor text
  const command = f.state.invoke("go");
  await vi.advanceTimersByTimeAsync(0);
  await f.state.invoke("stop");
  expect(f.bridge.invoke).toHaveBeenCalledOnce();
  expect(f.bridge.invoke.mock.calls[0]![0]).toMatchObject({ nodeId: "stop", form: {} });
  gate.resolve({ ok: true, value: { formRevision: 1, editSequence: 1, form: {} } });
  await vi.advanceTimersByTimeAsync(0);
  await command;
  expect(f.bridge.invoke.mock.lastCall?.[0]).toMatchObject({
    nodeId: "go",
    formRevision: 2,
    form: { text: "-", mode: false, hidden: "kept" },
  });
  f.state.retire();
});
it("retains an explicit conflict when coalesced hidden edits cannot be admitted; a visible edit can recover", async () => {
  const f = setup();
  const gate = deferred<void>();
  const real = f.syncForm.getMockImplementation()!;
  f.syncForm.mockImplementation(async (q) => {
    // Model the documented host old/new editable-tree admission rule.
    if (!f.host().form.mode && !q.form.mode && q.form.hidden !== f.host().form.hidden)
      return { ok: false, error: { code: "PLUGIN_E_UI_RESOURCE", message: "hidden change" } };
    return real(q);
  });
  f.syncForm.mockImplementationOnce(async (q) => {
    await gate.promise;
    return real(q);
  });
  f.state.edit("text", "unrelated");
  await vi.advanceTimersByTimeAsync(0);
  f.state.edit("mode", true);
  f.state.edit("hidden", "new hidden");
  f.state.edit("mode", false);
  expect(f.syncForm).toHaveBeenCalledOnce();
  gate.resolve();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.state.getSnapshot()).toMatchObject({
    draft: { text: "unrelated", hidden: "new hidden", mode: false },
    problem: "PLUGIN_E_UI_RESOURCE",
  });
  await f.state.invalidateForm(1, true);
  expect(f.state.getSnapshot().draft.hidden).toBe("new hidden");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.syncForm).toHaveBeenCalledTimes(2);
  expect(await f.state.flushForm()).toBe(false);
  await f.state.invoke("go");
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  f.state.edit("mode", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.host().form).toMatchObject({ hidden: "new hidden", mode: true });
  f.state.retire();
});
it("bounds repeated CAS collisions and does not replay on retire or reopen", async () => {
  const f = setup();
  f.syncForm.mockResolvedValue({
    ok: false,
    error: { code: "PLUGIN_E_STALE_RESOURCE", message: "collision" },
  });
  f.state.edit("text", "draft");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.syncForm).toHaveBeenCalledTimes(3);
  expect(f.state.getSnapshot().draft.text).toBe("draft");
  expect(await f.state.flushForm()).toBe(false);
  f.state.retire();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.syncForm).toHaveBeenCalledTimes(3);
});
it("ignores a late response for the closed binding and does not change a new store", async () => {
  const f = setup();
  const gate = deferred<Awaited<ReturnType<typeof f.syncForm>>>();
  f.syncForm.mockReturnValueOnce(gate.promise);
  f.state.edit("text", "old");
  await vi.advanceTimersByTimeAsync(0);
  f.state.retire();
  const fresh = new UiStateStore(f.bridge, resource, {
    ...f.host(),
    binding: { ...binding, panelInstance: handle(8) },
  });
  gate.resolve({
    ok: true,
    value: { formRevision: 1, editSequence: 1, form: { text: "old", mode: false, hidden: "kept" } },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fresh.getSnapshot().draft.text).toBe("");
  expect(f.syncForm).toHaveBeenCalledOnce();
  fresh.retire();
});
it("v1 never synchronizes or applies form backfill and preserves numeric grammar", async () => {
  const f = setup();
  const legacy = new UiStateStore(f.bridge, panel, snapshot());
  legacy.edit("speed", null, "-");
  await legacy.invalidateForm(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.syncForm).not.toHaveBeenCalled();
  expect(legacy.valid()).toBe(false);
  expect(legacy.getSnapshot().raw.speed).toBe("-");
  legacy.retire();
  f.state.retire();
});

it("a timed-out sync keeps its single transport slot until the original request settles", async () => {
  const f = setup();
  const gate = deferred<Awaited<ReturnType<typeof f.syncForm>>>();
  f.syncForm.mockReturnValueOnce(gate.promise);
  f.state.edit("text", "timed out");
  await vi.advanceTimersByTimeAsync(5000);
  expect(await f.state.flushForm()).toBe(false);
  f.state.edit("text", "latest");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.syncForm).toHaveBeenCalledOnce();
  gate.resolve({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "late" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.syncForm).toHaveBeenCalledTimes(2);
  expect(f.host().form.text).toBe("latest");
  f.state.retire();
});
it("a late snapshot cannot backfill a hide/show lifetime and a fresh snapshot preserves the newer edit", async () => {
  const f = setup();
  const gate = deferred<Awaited<ReturnType<typeof f.bridge.snapshot>>>();
  f.bridge.snapshot.mockReturnValueOnce(gate.promise);
  f.patch({ text: "old capture" });
  const reading = f.state.invalidateForm(1);
  f.state.setVisible(false);
  f.state.setVisible(true);
  f.state.edit("text", "new lifecycle edit");
  gate.resolve({
    ok: true,
    value: { ...f.host(), form: { text: "old capture", hidden: "kept", mode: false } },
  });
  await reading;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state.getSnapshot().draft.text).toBe("new lifecycle edit");
  expect(f.host().form.text).toBe("new lifecycle edit");
  f.state.retire();
});

it("keeps derived datasets stale until the same canonical draft is explicitly published", async () => {
  const f = setup(true);
  expect(f.state.derivedCurrent()).toBe(true);
  f.state.edit("text", "new draft");
  expect(f.state.derivedCurrent()).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state.formCurrent()).toBe(true);
  expect(f.state.derivedCurrent()).toBe(false);
  // An unrelated scalar presentation update is not evidence of recomputation.
  f.host().revision++;
  f.host().data.presentation = 1;
  await f.state.invalidate(f.host().revision);
  expect(f.state.derivedCurrent()).toBe(false);
  f.host().revision++;
  f.host().data.derived = f.host().formRevision;
  await f.state.invalidate(f.host().revision);
  expect(f.state.derivedCurrent()).toBe(true);
  f.patch({ text: "backfill" });
  await f.state.invalidateForm(f.host().formRevision);
  expect(f.state.derivedCurrent()).toBe(false);
  f.state.retire();
});
