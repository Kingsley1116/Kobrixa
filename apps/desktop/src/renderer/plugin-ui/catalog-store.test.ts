import { expect, it, vi } from "vitest";
import type { PluginUiBridge, UiBridgeEvent } from "@kobrixa/plugin-runtime";
import type { UiCatalogEntry, UiCatalogPage } from "@kobrixa/plugin-protocol";
import { UiCatalogStore } from "./catalog-store.js";
const epoch = "00000000-0000-4000-8000-000000000001";
const entry = (generation = 1): UiCatalogEntry => ({
  sourceKey: "builtin:acme.ui", pluginId: "acme.ui", id: "acme.ui.panel",
  kind: "panel", title: { en: "Panel" }, version: 1,
  resourceDigest: "a".repeat(64), resourceBytes: 200,
  uiResourceGeneration: generation, availability: "available",
});
const page = (revision: number, entries: UiCatalogEntry[]): UiCatalogPage => ({
  hostEpoch: epoch, revision, entries, nextCursor: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
it("U04/RF1 subscribes first, revokes immediately and discards a late page", async () => {
  let emit!: (event: UiBridgeEvent) => void;
  const first = deferred<Awaited<ReturnType<PluginUiBridge["catalog"]>>>();
  const off = vi.fn(); const revoked = vi.fn();
  const api = {
    onEvent: vi.fn((listener: typeof emit) => { emit = listener; return off; }),
    catalog: vi.fn<PluginUiBridge["catalog"]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, value: page(2, [entry(2)]) }),
    resource: vi.fn<PluginUiBridge["resource"]>(),
  };
  const store = new UiCatalogStore(api, revoked);
  const ready = store.start();
  expect(api.onEvent.mock.invocationCallOrder[0]).toBeLessThan(api.catalog.mock.invocationCallOrder[0]!);
  emit({ type: "catalog", hostEpoch: epoch, revision: 2, owners: [entry(2)] });
  expect(revoked).toHaveBeenCalled();
  first.resolve({ ok: true, value: page(1, [entry()]) });
  await ready; await store.refresh();
  expect(store.getSnapshot().entries).toEqual([entry(2)]);
  store.dispose(); store.dispose(); expect(off).toHaveBeenCalledTimes(1);
});
it("U04 discards late resources, isolates throws until a new resource generation", async () => {
  const pending = deferred<Awaited<ReturnType<PluginUiBridge["resource"]>>>();
  let emit!: (event: UiBridgeEvent) => void;
  const api = {
    onEvent: (listener: typeof emit) => { emit = listener; return () => {}; },
    catalog: vi.fn<PluginUiBridge["catalog"]>().mockResolvedValue({ ok: true, value: page(1, [entry()]) }),
    resource: vi.fn<PluginUiBridge["resource"]>().mockReturnValueOnce(pending.promise),
  };
  const store = new UiCatalogStore(api, () => {}); await store.start();
  const old = store.resource(entry());
  api.catalog.mockResolvedValue({ ok: true, value: page(2, [entry(2)]) });
  emit({ type: "catalog", hostEpoch: epoch, revision: 2, owners: [entry(2)] });
  pending.resolve({ ok: true, value: { owner: entry(), id: entry().id, version: 1, validationContext: { pluginId: "acme.ui", commands: [], panels: [] }, rawBytes: 200,
    resource: { kind: "status", data: {}, text: { text: { en: "Old" } }, tone: "neutral" } } });
  expect(await old).toBeNull(); await store.refresh();
  api.resource.mockImplementation(() => { throw new Error("adapter failed"); });
  expect(await store.resource(entry(2))).toBeNull();
  expect(await store.resource(entry(2))).toBeNull();
  expect(api.resource).toHaveBeenCalledTimes(2);
  store.dispose();
});
it("U04 never publishes mixed pages or duplicate IDs", async () => {
  const api = {
    onEvent: () => () => {}, resource: vi.fn<PluginUiBridge["resource"]>(),
    catalog: vi.fn<PluginUiBridge["catalog"]>()
      .mockResolvedValueOnce({ ok: true, value: { ...page(1, [entry()]), nextCursor: epoch } })
      .mockResolvedValueOnce({ ok: true, value: page(2, [entry(2)]) }),
  };
  const store = new UiCatalogStore(api, () => {}); await store.start();
  expect(store.getSnapshot().entries).toEqual([]);
  expect(store.getSnapshot().phase).toBe("failed"); store.dispose();
});

it("rejects an owner generation absent from the latest catalog event", async () => {
  let emit!: (event: UiBridgeEvent) => void;
  const api = {
    onEvent: (listener: typeof emit) => { emit = listener; return () => {}; },
    resource: vi.fn<PluginUiBridge["resource"]>(),
    catalog: vi.fn<PluginUiBridge["catalog"]>().mockResolvedValue({ ok: true, value: page(1, [entry()]) }),
  };
  const store = new UiCatalogStore(api, () => {}); await store.start();
  api.catalog.mockResolvedValue({ ok: true, value: page(2, [entry()]) });
  emit({ type: "catalog", hostEpoch: epoch, revision: 2, owners: [entry(2)] });
  await store.refresh();
  expect(store.getSnapshot().phase).toBe("failed"); store.dispose();
});
it("ignores a lower revision event in the same epoch without revoking", async () => {
  let emit!: (event: UiBridgeEvent) => void; const revoked = vi.fn();
  const api = {
    onEvent: (listener: typeof emit) => { emit = listener; return () => {}; },
    resource: vi.fn<PluginUiBridge["resource"]>(),
    catalog: vi.fn<PluginUiBridge["catalog"]>().mockResolvedValue({ ok: true, value: page(2, [entry(2)]) }),
  };
  const store = new UiCatalogStore(api, revoked); await store.start();
  emit({ type: "catalog", hostEpoch: epoch, revision: 2, owners: [entry(2)] }); await store.refresh();
  const before = store.getSnapshot(); revoked.mockClear();
  emit({ type: "catalog", hostEpoch: epoch, revision: 1, owners: [] });
  expect(revoked).not.toHaveBeenCalled(); expect(store.getSnapshot()).toBe(before); store.dispose();
});
it("rejects duplicate contribution IDs within a page", async () => {
  const api = {
    onEvent: () => () => {}, resource: vi.fn<PluginUiBridge["resource"]>(),
    catalog: vi.fn<PluginUiBridge["catalog"]>().mockResolvedValue({ ok: true, value: page(1, [entry(), entry()]) }),
  };
  const store = new UiCatalogStore(api, () => {}); await store.start();
  expect(store.getSnapshot().phase).toBe("failed"); expect(store.getSnapshot().entries).toEqual([]); store.dispose();
});
