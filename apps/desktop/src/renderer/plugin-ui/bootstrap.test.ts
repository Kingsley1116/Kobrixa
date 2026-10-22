import { afterEach, expect, it, vi } from "vitest";
import {
  fixture,
  entry,
  binding,
  handle,
  snapshot,
  deferred,
  panel,
  validationContext,
} from "./contract.test.js";
import { RendererSession, bootstrapPluginUi } from "./bootstrap.js";
afterEach(() => vi.useRealTimers());
it("U15 starts once across view remounts and never activates from readiness", async () => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await Promise.all([bootstrapPluginUi(session), bootstrapPluginUi(session)]);
  expect(f.bridge.onEvent).toHaveBeenCalledTimes(1);
  expect(f.bridge.open).not.toHaveBeenCalled();
  session.dispose();
  session.dispose();
  expect(f.listeners.size).toBe(0);
});
it("U04/U10/RF2 closes late open after hide or catalog revoke", async () => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  const pending = deferred<Awaited<ReturnType<typeof f.bridge.open>>>();
  f.bridge.open.mockReturnValue(pending.promise);
  session.showPane(true, "sidebar");
  const opening = session.open(entry);
  await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledTimes(1));
  session.showPane(false, "collapse");
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [] });
  pending.resolve({ ok: true, value: snapshot() });
  await opening;
  expect(session.record(entry)).toBeUndefined();
  expect(f.bridge.close).toHaveBeenCalledWith({ binding });
  session.dispose();
});
it("U04 bootstrap fails open to the editor at 5 seconds and recovers only from fresh events", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.bridge.catalog.mockReturnValueOnce(new Promise(() => {}));
  const session = new RendererSession(f.bridge);
  const ready = bootstrapPluginUi(session);
  await vi.advanceTimersByTimeAsync(5000);
  await ready;
  expect(session.catalog.getSnapshot().entries).toEqual([]);
  expect(f.bridge.open).not.toHaveBeenCalled();
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 1, owners: [entry] });
  await session.catalog.refresh();
  expect(session.catalog.getSnapshot().phase).toBe("ready");
  session.dispose();
});
it("V160 M1 keeps the empty bootstrap fallback after two late pages until a fresh revision", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const second = { ...entry, id: "acme.ui.second" };
  let revision = 1;
  f.bridge.catalog.mockImplementation(
    ({ cursor }) =>
      new Promise((resolve) => {
        const pageRevision = revision;
        setTimeout(
          () =>
            resolve({
              ok: true,
              value: {
                hostEpoch: handle(1),
                revision: pageRevision,
                entries: [cursor ? second : entry],
                nextCursor: cursor ? null : handle(4),
              },
            }),
          3000,
        );
      }),
  );
  const session = new RendererSession(f.bridge);
  const restored = vi.fn(() => session.catalog.getSnapshot().entries);
  const ready = bootstrapPluginUi(session).then(restored);
  await vi.advanceTimersByTimeAsync(4999);
  expect(restored).not.toHaveBeenCalled();
  expect(f.bridge.catalog).toHaveBeenNthCalledWith(2, { cursor: handle(4) });
  await vi.advanceTimersByTimeAsync(1);
  await ready;
  expect(restored).toHaveReturnedWith([]);
  expect(session.catalog.getSnapshot()).toMatchObject({ phase: "failed", entries: [] });
  await vi.advanceTimersByTimeAsync(1000);
  await session.catalog.refresh();
  await session.start();
  expect(session.catalog.getSnapshot()).toMatchObject({ phase: "failed", entries: [] });
  expect(f.bridge.catalog).toHaveBeenCalledTimes(2);
  expect(f.bridge.open).not.toHaveBeenCalled();

  // A later revision gets normal bounded page reads, without the expired initial budget.
  revision = 2;
  f.emit({ type: "catalog", hostEpoch: handle(1), revision, owners: [entry, second] });
  await vi.advanceTimersByTimeAsync(6000);
  expect(session.catalog.getSnapshot()).toMatchObject({
    phase: "ready",
    revision,
    entries: [entry, second],
  });
  expect(f.bridge.catalog).toHaveBeenCalledTimes(4);
  session.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("U04 old epoch/resource cannot resurrect and malformed adapter output isolates its contribution", async () => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  f.bridge.resource.mockResolvedValue({
    ok: true,
    value: {
      owner: entry,
      id: entry.id,
      version: 1,
      validationContext: { pluginId: "acme.ui", commands: [], panels: [] },
      rawBytes: 200,
      resource: {
        kind: "panel",
        data: {},
        fields: {},
        root: "bad",
        nodes: [{ id: "bad", type: "html" }],
      } as never,
    },
  });
  await session.open(entry);
  await session.open(entry);
  expect(f.bridge.open).not.toHaveBeenCalled();
  expect(f.bridge.resource).toHaveBeenCalledTimes(1);
  expect(f.bridge.reportFailure).toHaveBeenCalledTimes(1);
  f.emit({ type: "catalog", hostEpoch: handle(8), revision: 1, owners: [] });
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 99, owners: [entry] });
  expect(session.catalog.getSnapshot().epoch).toBe(handle(8));
  session.dispose();
});
it("U09 hide/release invalidates intent while retaining drafts for the next explicit action", async () => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  const record = session.record(entry)!;
  record.state.edit("speed", null, "-");
  f.emit({ type: "revoked", binding, reason: "hidden" });
  expect(session.record(entry)).toBe(record);
  expect(record.state.getSnapshot().raw.speed).toBe("-");
  expect(record.state.getSnapshot().active).toBe(true);
  session.dispose();
});

it("U01/U07 core navigation uses main acceptance and never invents an action token", async () => {
  const f = fixture();
  const resource = structuredClone(panel);
  const go = resource.nodes.find((node) => node.id === "go")!;
  if (go.type === "action") go.action = { kind: "core", action: "openRecovery" };
  f.bridge.resource.mockResolvedValue({
    ok: true,
    value: {
      owner: entry,
      id: entry.id,
      version: 1,
      validationContext,
      rawBytes: new TextEncoder().encode(JSON.stringify(resource)).length,
      resource,
    },
  });
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  expect(session.getRecoveryRequest()).toBe(0);
  await session.record(entry)!.state.invoke("go");
  expect(session.getRecoveryRequest()).toBe(1);
  expect(Object.keys(f.bridge.invoke.mock.calls[0]![0]).sort()).toEqual([
    "binding",
    "form",
    "formRevision",
    "nodeId",
  ]);
  session.dispose();
});

it.each(["before-fetch", "after-fetch"] as const)(
  "AM-17 current status replay %s survives remount and older catalog response",
  async (timing) => {
    const f = fixture();
    const status = { ...entry, id: "acme.ui.status", kind: "status" as const };
    const statusBinding = { ...binding, contributionId: status.id, kind: "status" as const };
    const current = { ...snapshot(9), binding: statusBinding, form: {} };
    const event = { type: "state" as const, binding: statusBinding, revision: 9 };
    const page = { hostEpoch: handle(1), revision: 2, entries: [status], nextCursor: null };
    f.bridge.catalog.mockResolvedValue({ ok: true, value: page });
    f.bridge.resource.mockResolvedValue({
      ok: true,
      value: {
        owner: status,
        id: status.id,
        version: 1,
        validationContext,
        rawBytes: 200,
        resource: {
          kind: "status",
          data: { count: panel.data.count! },
          text: { text: { en: "Status" } },
          tone: "neutral",
        },
      },
    });
    f.bridge.snapshot.mockResolvedValue({ ok: true, value: current });
    f.bridge.onEvent.mockImplementation((listener) => {
      f.listeners.add(listener);
      if (timing === "before-fetch") listener(event);
      return () => {
        f.listeners.delete(listener);
      };
    });
    for (let mount = 0; mount < 2; mount++) {
      const old = deferred<Awaited<ReturnType<typeof f.bridge.catalog>>>();
      f.bridge.catalog.mockReturnValueOnce(old.promise);
      const session = new RendererSession(f.bridge);
      const ready = session.start();
      if (timing === "after-fetch") f.emit(event);
      f.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [status] });
      f.emit(event);
      f.emit({ ...event, revision: 3 });
      old.resolve({ ok: true, value: { ...page, revision: 1 } });
      await ready;
      await session.catalog.refresh();
      await vi.waitFor(() =>
        expect(session.record(status)?.state.getSnapshot().snapshot.revision).toBe(9),
      );
      expect(f.bridge.open).not.toHaveBeenCalled();
      expect(f.listeners.size).toBe(1);
      session.dispose();
      expect(f.listeners.size).toBe(0);
    }
  },
);

it("C-G1 restores independent port fields and invalid raw into a fresh binding without intent", async () => {
  const f = fixture();
  const resource = structuredClone(panel);
  resource.fields.portb = structuredClone(resource.fields.speed!);
  resource.fields.port = {
    schema: { type: "enum", values: ["A", "B"], nullable: false },
    initial: "A",
    required: true,
  };
  resource.nodes.push(
    { id: "portb", type: "number", field: "portb", label: { en: "Port B" }, step: 0.1 },
    {
      id: "port",
      type: "choice",
      field: "port",
      label: { en: "Port" },
      presentation: "select",
      options: [
        { value: "A", label: { en: "A" } },
        { value: "B", label: { en: "B" } },
      ],
    },
  );
  const root = resource.nodes[0]!;
  if (root.type === "group") root.children.push("portb", "port");
  f.bridge.resource.mockResolvedValue({
    ok: true,
    value: { owner: entry, id: entry.id, version: 1, validationContext, rawBytes: 2000, resource },
  });
  const initial = { ...snapshot(), form: { speed: 0, enabled: false, portb: 0, port: "A" } };
  f.bridge.open.mockResolvedValue({ ok: true, value: initial });
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  const former = session.record(entry)!;
  former.state.edit("speed", 23, "23");
  former.state.edit("portb", null, "-");
  former.state.edit("port", "B");
  const oldPatch = deferred<Awaited<ReturnType<typeof f.bridge.snapshot>>>();
  f.bridge.snapshot.mockReturnValueOnce(oldPatch.promise);
  const patch = former.state.invalidate(9);
  session.close(entry);
  // Main's actual `closed` event is an instance notification, not execution retirement.
  f.emit({ type: "revoked", binding, reason: "closed" });
  const freshBinding = { ...binding, panelInstance: handle(20) };
  f.bridge.open.mockResolvedValue({
    ok: true,
    value: { ...initial, binding: freshBinding, formRevision: 7 },
  });
  await session.open(entry);
  const fresh = session.record(entry)!;
  expect(fresh.state).not.toBe(former.state);
  expect(fresh.intent).not.toBe(former.intent);
  expect(fresh.state.getSnapshot()).toMatchObject({
    draft: { speed: 23, portb: null, port: "B" },
    raw: { speed: "23", portb: "-" },
    errors: {},
    problem: null,
    busy: false,
    localRevision: 1,
  });
  expect(fresh.state.form().binding).toEqual(freshBinding);
  expect(fresh.state.getSnapshot().snapshot.form).toEqual(initial.form);
  expect(fresh.state.valid()).toBe(false);
  await fresh.state.invoke("go");
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  expect(f.bridge.hold).not.toHaveBeenCalled();
  expect(f.bridge.pulse).not.toHaveBeenCalled();
  oldPatch.resolve({ ok: true, value: { ...snapshot(9), form: { speed: 99 } } });
  await patch;
  f.emit({ type: "state", binding, revision: 10 });
  expect(fresh.state.getSnapshot().draft.speed).toBe(23);
  expect(f.bridge.snapshot).toHaveBeenCalledTimes(1);
  fresh.state.edit("portb", 42, "42");
  await fresh.state.invoke("go");
  expect(f.bridge.invoke).toHaveBeenCalledWith({
    binding: freshBinding,
    nodeId: "go",
    formRevision: 8,
    form: { speed: 23, enabled: false, portb: 42, port: "B" },
  });
  expect(resource.fields.speed!.initial).toBe(0);
  session.dispose();
});

it.each(["generation", "processEpoch"] as const)(
  "C-G1 fresh execution %s cannot inherit a closed draft",
  async (changed) => {
    const f = fixture();
    const session = new RendererSession(f.bridge);
    await session.start();
    session.showPane(true, "sidebar");
    await session.open(entry);
    session.record(entry)!.state.edit("speed", 15);
    session.close(entry);
    const next = {
      ...binding,
      panelInstance: handle(20),
      [changed]: changed === "generation" ? 2 : handle(21),
    };
    f.bridge.open.mockResolvedValue({ ok: true, value: { ...snapshot(), binding: next } });
    await session.open(entry);
    expect(session.record(entry)!.state.getSnapshot().draft.speed).toBe(0);
    session.dispose();
  },
);

it.each([
  "generation-retired",
  "resource-replaced",
  "renderer-gone",
  "process-gone",
  "safe-mode",
  "shutdown",
] as const)("C-G1 %s purges closed drafts and rejects a delayed old open", async (reason) => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  session.record(entry)!.state.edit("speed", 15);
  session.close(entry);
  const late = deferred<Awaited<ReturnType<typeof f.bridge.open>>>();
  f.bridge.open.mockReturnValueOnce(late.promise);
  const pending = session.open(entry);
  await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledTimes(2));
  f.emit({ type: "revoked", binding, reason });
  late.resolve({ ok: true, value: snapshot() });
  await pending;
  expect(session.record(entry)).toBeUndefined();
  await session.open(entry);
  expect(session.record(entry)!.state.getSnapshot().draft.speed).toBe(0);
  session.dispose();
});

it.each([
  "resourceDigest",
  "uiResourceGeneration",
  "sourceKey",
  "hostEpoch",
  "withdrawal",
] as const)("C-G1 catalog %s drops drafts", async (changed) => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  session.record(entry)!.state.edit("speed", 15);
  session.close(entry);
  const nextEntry = {
    ...entry,
    ...(changed === "resourceDigest"
      ? { resourceDigest: "b".repeat(64) }
      : changed === "uiResourceGeneration"
        ? { uiResourceGeneration: 2 }
        : changed === "sourceKey"
          ? { sourceKey: "builtin:other" }
          : {}),
  };
  const epoch = changed === "hostEpoch" ? handle(30) : binding.hostEpoch;
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: {
      hostEpoch: epoch,
      revision: 2,
      entries: changed === "withdrawal" ? [] : [nextEntry],
      nextCursor: null,
    },
  });
  f.emit({
    type: "catalog",
    hostEpoch: epoch,
    revision: 2,
    owners: changed === "withdrawal" ? [] : [nextEntry],
  });
  await session.catalog.refresh();
  if (changed === "withdrawal") {
    f.bridge.catalog.mockResolvedValue({
      ok: true,
      value: { hostEpoch: epoch, revision: 3, entries: [entry], nextCursor: null },
    });
    f.emit({ type: "catalog", hostEpoch: epoch, revision: 3, owners: [entry] });
    await session.catalog.refresh();
  }
  f.bridge.resource.mockResolvedValue({
    ok: true,
    value: {
      owner: nextEntry,
      id: nextEntry.id,
      version: 1,
      validationContext,
      rawBytes: 1000,
      resource: panel,
    },
  });
  f.bridge.open.mockResolvedValue({
    ok: true,
    value: {
      ...snapshot(),
      binding: {
        ...binding,
        hostEpoch: epoch,
        uiResourceGeneration: nextEntry.uiResourceGeneration,
        panelInstance: handle(20),
      },
    },
  });
  await session.open(nextEntry);
  expect(session.record(nextEntry)!.state.getSnapshot().draft.speed).toBe(0);
  session.dispose();
});

it("C-G1 quarantine and renderer disposal drop closed drafts", async () => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  session.record(entry)!.state.edit("speed", 15);
  session.close(entry);
  session.quarantine(entry, "renderer");
  // A resource retry re-admits the contribution; quarantined memory must already be gone.
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: { hostEpoch: handle(1), revision: 2, entries: [], nextCursor: null },
  });
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [] });
  await session.catalog.refresh();
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: { hostEpoch: handle(1), revision: 3, entries: [entry], nextCursor: null },
  });
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 3, owners: [entry] });
  await session.catalog.refresh();
  await session.open(entry);
  expect(session.record(entry)!.state.getSnapshot().draft.speed).toBe(0);
  session.record(entry)!.state.edit("speed", 25);
  session.close(entry);
  session.dispose();
  const next = new RendererSession(f.bridge);
  await next.start();
  next.showPane(true, "sidebar");
  await next.open(entry);
  expect(next.record(entry)!.state.getSnapshot().draft.speed).toBe(0);
  next.dispose();
});

it("C-G1 close discards held input, queued pulses and command state while retaining only fields", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  await session.open(entry);
  const old = session.record(entry)!;
  old.state.edit("speed", 25, "25");
  expect(
    old.intent.begin("hold", {
      trusted: true,
      kind: "pointer",
      id: "1",
      primary: true,
      repeat: false,
    }),
  ).toBe(true);
  await Promise.resolve();
  old.intent.challenge(handle(40));
  const response = deferred<Awaited<ReturnType<typeof f.bridge.invoke>>>();
  f.bridge.invoke.mockReturnValueOnce(response.promise);
  const command = old.state.invoke("go");
  session.close(entry);
  await command;
  expect(f.bridge.hold).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "cancel" }));
  f.bridge.hold.mockClear();
  f.bridge.invoke.mockClear();
  f.bridge.pulse.mockClear();
  const freshBinding = { ...binding, panelInstance: handle(20) };
  f.bridge.open.mockResolvedValue({ ok: true, value: { ...snapshot(), binding: freshBinding } });
  await session.open(entry);
  const fresh = session.record(entry)!;
  response.resolve({
    ok: true,
    value: { output: {}, fieldErrors: [{ field: "speed", message: { en: "Old error" } }] },
  });
  await vi.runOnlyPendingTimersAsync();
  expect(fresh.state.getSnapshot()).toMatchObject({
    draft: { speed: 25 },
    raw: { speed: "25" },
    busy: false,
    errors: {},
    problem: null,
    localRevision: 1,
  });
  expect(f.bridge.hold).not.toHaveBeenCalled();
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  expect(f.bridge.pulse).not.toHaveBeenCalled();
  fresh.intent.challenge(handle(41));
  await vi.runOnlyPendingTimersAsync();
  expect(f.bridge.pulse).toHaveBeenCalledWith({
    binding: freshBinding,
    challenge: handle(41),
    gesture: null,
    inputToken: null,
  });
  session.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["closed", "generation-retired", "process-gone", "safe-mode"] as const)(
  "C-G1 unrequested live %s notification never saves a draft",
  async (reason) => {
    const f = fixture();
    const session = new RendererSession(f.bridge);
    await session.start();
    session.showPane(true, "sidebar");
    await session.open(entry);
    session.record(entry)!.state.edit("speed", 15);
    f.emit({ type: "revoked", binding, reason });
    expect(session.record(entry)).toBeUndefined();
    await session.open(entry);
    expect(session.record(entry)!.state.getSnapshot().draft.speed).toBe(0);
    session.dispose();
  },
);

import { UiStateRegistry } from "../../../../../packages/plugin-runtime/src/ui-state.js";
import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
it("C-G1 actual registry retirement after last panel close reaches renderer and purges raw without catalog withdrawal", async () => {
  const f = fixture();
  const states = new UiStateRegistry({ current: () => true });
  const owner = {
    sourceKey: entry.sourceKey,
    pluginId: entry.pluginId,
    generation: binding.generation,
    hostEpoch: binding.hostEpoch,
    processEpoch: binding.processEpoch,
  };
  const [wire] = createMemoryChannelPair();
  const peer = new RpcPeer(wire);
  const off = states.onEvent((_owner, event) => {
    // Same existing UiEvent -> UiBridgeEvent projection as desktop controller.
    if (event.kind === "ui.revoked") f.emit({ type: "revoked", ...event.data });
  });
  f.bridge.open.mockImplementation(() =>
    states.open({
      owner: entry,
      id: entry.id,
      resource: panel,
      scope: { hostEpoch: binding.hostEpoch, workbenchInstance: handle(70) },
      activateInitialized: async () => ({
        owner,
        peer,
        requirements: [],
        principal: () => ({ kind: "plugin", owner, authorityContext: null }),
      }),
    }),
  );
  f.bridge.close.mockImplementation(async ({ binding }) => states.close(owner, binding));
  f.bridge.visibility.mockImplementation(async ({ binding, visible }) =>
    states.visibility(owner, binding, visible),
  );
  const session = new RendererSession(f.bridge);
  try {
    await session.start();
    session.showPane(true, "sidebar");
    await session.open(entry);
    session.record(entry)!.state.edit("speed", null, "-");
    session.close(entry);
    expect(states.instances(owner)).toEqual([]);
    states.retireExecution({ ...owner, processEpoch: handle(71) }, "process-gone");
    await session.open(entry);
    expect(session.record(entry)!.state.getSnapshot().raw.speed).toBe("-");
    session.close(entry);
    const revoked: string[] = [];
    const stop = states.onEvent((_owner, event) => {
      if (event.kind === "ui.revoked") revoked.push(event.data.reason);
    });
    states.retireExecution(owner, "process-gone");
    stop();
    expect(revoked).toEqual(["process-gone"]);
    expect(states.instances(owner)).toEqual([]);
    // Keep identical execution identity: this proves eager purge, not restore's epoch guard.
    await session.open(entry);
    expect(session.record(entry)!.state.getSnapshot()).toMatchObject({
      draft: { speed: 0 },
      raw: {},
    });
    expect(f.bridge.catalog).toHaveBeenCalledTimes(1);
  } finally {
    session.dispose();
    off();
    peer.close();
  }
});
