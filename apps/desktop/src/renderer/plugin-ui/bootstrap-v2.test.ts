import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelTree } from "./components.js";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalDatasetV2Bytes, type PanelResourceV2 } from "@kobrixa/plugin-protocol";
import { RendererSession, assertRenderable } from "./bootstrap.js";
import {
  fixture,
  entry,
  snapshot,
  binding,
  validationContext,
  deferred,
  labels,
} from "./contract.test.js";
vi.stubGlobal("crypto", webcrypto);
afterEach(() => vi.useRealTimers());
const panel: PanelResourceV2 = {
  kind: "panel",
  root: "root",
  fields: {},
  data: {
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
  presentationKey: "presentation",
  datasets: {
    samples: { kind: "table", columns: [{ id: "value", label: { en: "Value" }, value: "number" }] },
  },
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["table"] },
    { id: "table", type: "table", label: { en: "Samples" }, dataset: "samples" },
  ],
};
function v2(value: number | string = 2) {
  const f = fixture();
  const item = { ...entry, version: 2 as const };
  const state = { ...snapshot(), data: { presentation: 1 }, form: {} };
  const resource = {
    owner: item,
    id: item.id,
    version: 2 as const,
    validationContext,
    rawBytes: new TextEncoder().encode(JSON.stringify(panel)).length,
    resource: {
      ...panel,
      datasets: {
        samples: {
          kind: "table" as const,
          columns: [
            {
              id: "value",
              label: { en: "Value" },
              value: typeof value === "string" ? ("string" as const) : ("number" as const),
            },
          ],
        },
      },
    },
  };
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: { hostEpoch: binding.hostEpoch, revision: 1, entries: [item], nextCursor: null },
  });
  f.bridge.resource.mockResolvedValue({ ok: true, value: resource });
  f.bridge.open.mockResolvedValue({ ok: true, value: state });
  f.bridge.snapshot.mockImplementation(async () => ({
    ok: true,
    value: { ...state, data: { ...state.data } },
  }));
  const entries = [{ key: "row", version: null, cells: [value] }];
  const bytes = canonicalDatasetV2Bytes({ kind: "table" }, entries);
  const metadata = {
    dataset: "samples",
    revision: 1,
    presentation: 1,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  f.bridge.dataSnapshot.mockResolvedValue({ ok: true, value: { datasets: [metadata] } });
  f.bridge.dataRead.mockResolvedValue({
    ok: true,
    value: {
      revision: metadata.revision,
      presentation: metadata.presentation,
      byteLength: metadata.byteLength,
      sha256: metadata.sha256,
      header: { kind: "table" },
      chunk: { kind: "table", entries },
      nextOffset: 1,
      done: true,
    },
  });
  const session = new RendererSession(f.bridge);
  return { ...f, session, item, state, resource, entries };
}
it("attaches a v2 data cache to the exact opened binding and gates scalar presentation", async () => {
  const f = v2();
  expect(() => assertRenderable(panel, validationContext, f.resource.rawBytes, 2)).not.toThrow();
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(f.item);
  const cache = f.session.record(f.item)?.datasets;
  expect(cache).toBeDefined();
  await vi.waitFor(() => expect(cache!.dataset("samples")?.entries).toEqual(f.entries));
  const record = f.session.record(f.item)!;
  const rendered = () =>
    renderToStaticMarkup(
      createElement(PanelTree, {
        state: record.state,
        intent: record.intent,
        datasets: cache!,
        locale: "en",
        labels,
      }),
    );
  expect(rendered()).toContain("<td>2</td>");
  expect(rendered()).toContain("<caption>Samples</caption>");
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  expect(f.bridge.dataSnapshot).toHaveBeenCalledWith({ binding });
  expect(f.bridge.dataRead.mock.calls[0]![0].binding).toEqual(binding);
  f.state.revision = 1;
  f.state.data.presentation = 2;
  f.emit({ type: "state", binding, revision: 1 });
  await vi.waitFor(() => expect(cache!.getSnapshot().presentation).toBe(2));
  expect(cache!.dataset("samples")).toBeUndefined();
  expect(rendered()).not.toContain("<td>2</td>");
  expect(rendered()).toContain("Updating…");
  f.session.close(f.item);
  expect(cache!.getSnapshot().active).toBe(false);
  expect(cache!.dataset("samples")).toBeUndefined();
  f.session.dispose();
});
it("does not expose a late data page after the original binding is revoked", async () => {
  const f = v2();
  const pending = deferred<Awaited<ReturnType<typeof f.bridge.dataRead>>>();
  const value = await f.bridge.dataRead({
    binding: { ...binding, kind: "panel" },
    dataset: "samples",
    revision: 1,
    offset: 0,
    limit: 10,
  });
  f.bridge.dataRead.mockClear().mockReturnValue(pending.promise);
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(f.item);
  const cache = f.session.record(f.item)!.datasets!;
  await vi.waitFor(() => expect(f.bridge.dataRead).toHaveBeenCalledOnce());
  f.emit({ type: "revoked", binding, reason: "generation-retired" });
  pending.resolve(value);
  await Promise.resolve();
  await Promise.resolve();
  expect(cache.getSnapshot().active).toBe(false);
  expect(cache.dataset("samples")).toBeUndefined();
  expect(f.session.record(f.item)).toBeUndefined();
  f.session.dispose();
});
it("data notifications from another panel cannot refresh the original cache", async () => {
  const f = v2();
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(f.item);
  await vi.waitFor(() =>
    expect(f.session.record(f.item)!.datasets!.dataset("samples")).toBeDefined(),
  );
  f.bridge.dataSnapshot.mockClear();
  f.emit({
    type: "data",
    binding: { ...binding, generation: binding.generation + 1 },
    dataset: "samples",
    revision: 2,
    presentation: 2,
  });
  await Promise.resolve();
  expect(f.bridge.dataSnapshot).not.toHaveBeenCalled();
  f.emit({ type: "data", binding, dataset: "samples", revision: 2, presentation: 2 });
  await vi.waitFor(() => expect(f.bridge.dataSnapshot).toHaveBeenCalledOnce());
  f.session.dispose();
});
it("does not relabel a v2 resource as v1 or activate it under a v1 catalog entry", async () => {
  const f = v2();
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: { hostEpoch: binding.hostEpoch, revision: 1, entries: [entry], nextCursor: null },
  });
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(entry);
  expect(f.bridge.open).not.toHaveBeenCalled();
  expect(f.bridge.dataSnapshot).not.toHaveBeenCalled();
  expect(() => assertRenderable(panel, validationContext, f.resource.rawBytes, 1)).toThrow();
  f.session.dispose();
});

it("renders plugin table strings as text without executing commands", async () => {
  const f = v2('<script>alert("plugin")</script>');
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(f.item);
  const record = f.session.record(f.item)!;
  await vi.waitFor(() => expect(record.datasets!.dataset("samples")).toBeDefined());
  const html = renderToStaticMarkup(
    createElement(PanelTree, {
      state: record.state,
      intent: record.intent,
      datasets: record.datasets!,
      locale: "zh-TW",
      labels,
    }),
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  f.session.dispose();
});
it("invalid opening presentation quarantines and disposes the cache before visibility", async () => {
  const f = v2();
  f.state.data.presentation = -1;
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(f.item);
  expect(f.session.record(f.item)).toBeUndefined();
  expect(f.bridge.reportFailure).toHaveBeenCalledOnce();
  expect(f.bridge.dataRead).not.toHaveBeenCalled();
  expect(f.bridge.visibility).not.toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  f.session.dispose();
});

it("routes form-only invalidation and reopens synchronized panels from the fresh host form", async () => {
  const f = v2();
  const formResource: PanelResourceV2 = {
    ...panel,
    formSync: true,
    fields: {
      draft: {
        schema: { type: "string", nullable: false, maxLength: 4000 },
        initial: "",
        required: false,
      },
    },
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["draft", "table"] },
      { id: "draft", type: "textInput", field: "draft", label: { en: "Draft" } },
      { id: "table", type: "table", label: { en: "Samples" }, dataset: "samples" },
    ],
  };
  f.bridge.resource.mockResolvedValue({
    ok: true,
    value: {
      ...f.resource,
      resource: formResource,
      rawBytes: new TextEncoder().encode(JSON.stringify(formResource)).length,
    },
  });
  f.state.form = { draft: "initial" };
  await f.session.start();
  f.session.showPane(true, "sidebar");
  await f.session.open(f.item);
  const first = f.session.record(f.item)!.state;
  f.state.form = { draft: "capture" };
  f.state.formRevision = 1;
  f.emit({ type: "form", binding, formRevision: 1 });
  await vi.waitFor(() => expect(first.getSnapshot().draft.draft).toBe("capture"));
  expect(first.getSnapshot().snapshot.revision).toBe(0);
  first.edit("draft", "unsent old binding");
  f.session.close(f.item);
  f.state.binding = { ...binding, panelInstance: "00000000-0000-4000-8000-000000000090" };
  f.state.form = { draft: "fresh host" };
  await f.session.open(f.item);
  const next = f.session.record(f.item)!.state;
  expect(next.getSnapshot().draft.draft).toBe("fresh host");
  const calls = f.bridge.snapshot.mock.calls.length;
  f.emit({ type: "form", binding, formRevision: 99 });
  expect(f.bridge.snapshot).toHaveBeenCalledTimes(calls);
  expect(first.getSnapshot().active).toBe(false);
  f.session.dispose();
});
