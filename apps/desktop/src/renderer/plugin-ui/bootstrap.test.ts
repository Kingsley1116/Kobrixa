import { afterEach, expect, it, vi } from "vitest";
import { fixture, entry, binding, handle, snapshot, deferred, panel, validationContext } from "./contract.test.js";
import { RendererSession, bootstrapPluginUi } from "./bootstrap.js";
afterEach(() => vi.useRealTimers());
it("U15 starts once across view remounts and never activates from readiness", async () => {
  const f = fixture(); const session = new RendererSession(f.bridge);
  await Promise.all([bootstrapPluginUi(session), bootstrapPluginUi(session)]);
  expect(f.bridge.onEvent).toHaveBeenCalledTimes(1); expect(f.bridge.open).not.toHaveBeenCalled();
  session.dispose(); session.dispose(); expect(f.listeners.size).toBe(0);
});
it("U04/U10/RF2 closes late open after hide or catalog revoke", async () => {
  const f = fixture(); const session = new RendererSession(f.bridge); await session.start();
  const pending = deferred<Awaited<ReturnType<typeof f.bridge.open>>>(); f.bridge.open.mockReturnValue(pending.promise);
  session.showPane(true, "sidebar"); const opening = session.open(entry);
  await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledTimes(1));
  session.showPane(false, "collapse");
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [] });
  pending.resolve({ ok: true, value: snapshot() }); await opening;
  expect(session.record(entry)).toBeUndefined();
  expect(f.bridge.close).toHaveBeenCalledWith({ binding }); session.dispose();
});
it("U04 bootstrap fails open to the editor at 5 seconds and recovers only from fresh events", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.bridge.catalog.mockReturnValueOnce(new Promise(() => {}));
  const session = new RendererSession(f.bridge); const ready = bootstrapPluginUi(session);
  await vi.advanceTimersByTimeAsync(5000); await ready;
  expect(session.catalog.getSnapshot().entries).toEqual([]);
  expect(f.bridge.open).not.toHaveBeenCalled();
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 1, owners: [entry] });
  await session.catalog.refresh(); expect(session.catalog.getSnapshot().phase).toBe("ready"); session.dispose();
});
it("V160 M1 keeps the empty bootstrap fallback after two late pages until a fresh revision", async () => {
  vi.useFakeTimers(); const f = fixture();
  const second = { ...entry, id: "acme.ui.second" };
  let revision = 1;
  f.bridge.catalog.mockImplementation(({ cursor }) => new Promise((resolve) => {
    const pageRevision = revision;
    setTimeout(() => resolve({ ok: true, value: { hostEpoch: handle(1), revision: pageRevision,
      entries: [cursor ? second : entry], nextCursor: cursor ? null : handle(4) } }), 3000);
  }));
  const session = new RendererSession(f.bridge);
  const restored = vi.fn(() => session.catalog.getSnapshot().entries);
  const ready = bootstrapPluginUi(session).then(restored);
  await vi.advanceTimersByTimeAsync(4999);
  expect(restored).not.toHaveBeenCalled();
  expect(f.bridge.catalog).toHaveBeenNthCalledWith(2, { cursor: handle(4) });
  await vi.advanceTimersByTimeAsync(1); await ready;
  expect(restored).toHaveReturnedWith([]);
  expect(session.catalog.getSnapshot()).toMatchObject({ phase: "failed", entries: [] });
  await vi.advanceTimersByTimeAsync(1000);
  await session.catalog.refresh(); await session.start();
  expect(session.catalog.getSnapshot()).toMatchObject({ phase: "failed", entries: [] });
  expect(f.bridge.catalog).toHaveBeenCalledTimes(2);
  expect(f.bridge.open).not.toHaveBeenCalled();

  // A later revision gets normal bounded page reads, without the expired initial budget.
  revision = 2;
  f.emit({ type: "catalog", hostEpoch: handle(1), revision, owners: [entry, second] });
  await vi.advanceTimersByTimeAsync(6000);
  expect(session.catalog.getSnapshot()).toMatchObject({ phase: "ready", revision, entries: [entry, second] });
  expect(f.bridge.catalog).toHaveBeenCalledTimes(4);
  session.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it("U04 old epoch/resource cannot resurrect and malformed adapter output isolates its contribution", async () => {
  const f = fixture(); const session = new RendererSession(f.bridge); await session.start();
  session.showPane(true, "sidebar");
  f.bridge.resource.mockResolvedValue({ ok: true, value: { owner: entry, id: entry.id, version: 1, validationContext: { pluginId: "acme.ui", commands: [], panels: [] }, rawBytes: 200,
    resource: { kind: "panel", data: {}, fields: {}, root: "bad", nodes: [{ id: "bad", type: "html" }] } as never } });
  await session.open(entry); await session.open(entry);
  expect(f.bridge.open).not.toHaveBeenCalled(); expect(f.bridge.resource).toHaveBeenCalledTimes(1);
  expect(f.bridge.reportFailure).toHaveBeenCalledTimes(1);
  f.emit({ type: "catalog", hostEpoch: handle(8), revision: 1, owners: [] });
  f.emit({ type: "catalog", hostEpoch: handle(1), revision: 99, owners: [entry] });
  expect(session.catalog.getSnapshot().epoch).toBe(handle(8)); session.dispose();
});
it("U09 hide/release invalidates intent while retaining drafts for the next explicit action", async () => {
  const f = fixture(); const session = new RendererSession(f.bridge); await session.start();
  session.showPane(true, "sidebar"); await session.open(entry);
  const record = session.record(entry)!; record.state.edit("speed", null, "-");
  f.emit({ type: "revoked", binding, reason: "hidden" });
  expect(session.record(entry)).toBe(record); expect(record.state.getSnapshot().raw.speed).toBe("-");
  expect(record.state.getSnapshot().active).toBe(true); session.dispose();
});

it("U01/U07 core navigation uses main acceptance and never invents an action token", async () => {
  const f = fixture(); const resource = structuredClone(panel);
  const go = resource.nodes.find((node) => node.id === "go")!;
  if (go.type === "action") go.action = { kind: "core", action: "openRecovery" };
  f.bridge.resource.mockResolvedValue({ ok: true, value: { owner: entry, id: entry.id, version: 1, validationContext, rawBytes: new TextEncoder().encode(JSON.stringify(resource)).length, resource } });
  const session = new RendererSession(f.bridge); await session.start(); session.showPane(true, "sidebar"); await session.open(entry);
  expect(session.getRecoveryRequest()).toBe(0);
  await session.record(entry)!.state.invoke("go"); expect(session.getRecoveryRequest()).toBe(1);
  expect(Object.keys(f.bridge.invoke.mock.calls[0]![0]).sort()).toEqual(["binding", "form", "formRevision", "nodeId"]);
  session.dispose();
});


it.each(["before-fetch", "after-fetch"] as const)("AM-17 current status replay %s survives remount and older catalog response", async (timing) => {
  const f = fixture(); const status = { ...entry, id: "acme.ui.status", kind: "status" as const };
  const statusBinding = { ...binding, contributionId: status.id, kind: "status" as const };
  const current = { ...snapshot(9), binding: statusBinding, form: {} };
  const event = { type: "state" as const, binding: statusBinding, revision: 9 };
  const page = { hostEpoch: handle(1), revision: 2, entries: [status], nextCursor: null };
  f.bridge.catalog.mockResolvedValue({ ok: true, value: page });
  f.bridge.resource.mockResolvedValue({ ok: true, value: {
    owner: status, id: status.id, version: 1, validationContext, rawBytes: 200,
    resource: { kind: "status", data: { count: panel.data.count! }, text: { text: { en: "Status" } }, tone: "neutral" },
  } });
  f.bridge.snapshot.mockResolvedValue({ ok: true, value: current });
  f.bridge.onEvent.mockImplementation((listener) => {
    f.listeners.add(listener);
    if (timing === "before-fetch") listener(event);
    return () => { f.listeners.delete(listener); };
  });
  for (let mount = 0; mount < 2; mount++) {
    const old = deferred<Awaited<ReturnType<typeof f.bridge.catalog>>>();
    f.bridge.catalog.mockReturnValueOnce(old.promise);
    const session = new RendererSession(f.bridge); const ready = session.start();
    if (timing === "after-fetch") f.emit(event);
    f.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [status] });
    f.emit(event); f.emit({ ...event, revision: 3 });
    old.resolve({ ok: true, value: { ...page, revision: 1 } });
    await ready; await session.catalog.refresh();
    await vi.waitFor(() => expect(session.record(status)?.state.getSnapshot().snapshot.revision).toBe(9));
    expect(f.bridge.open).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(1);
    session.dispose(); expect(f.listeners.size).toBe(0);
  }
});
