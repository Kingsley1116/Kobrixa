import { expect, it, vi } from "vitest";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import { UiDataClient } from "../../../../../packages/plugin-sdk-js/src/ui-data.js";
import {
  UiDataStore,
  type UiDataAuthority,
} from "../../../../../packages/plugin-runtime/src/ui-data.js";
import type { DatasetV2, UiDataRequestMapV2 } from "@kobrixa/plugin-protocol";
import { LabPresentationPublisher } from "../../../../../plugins/sensor-lab/src/presentation-publisher.js";
import { binding, snapshot } from "../../renderer/plugin-ui/contract.test.js";
function setup() {
  const authority: UiDataAuthority = {
    owner: {
      sourceKey: "builtin:acme.ui",
      pluginId: "acme.ui",
      generation: binding.generation,
      hostEpoch: binding.hostEpoch,
      processEpoch: binding.processEpoch,
    },
    binding: { ...binding, kind: "panel" },
    registration: {},
    version: 2,
    ready: true,
    panelsPermission: true,
    visible: true,
    presentation: 0,
    resource: {
      kind: "panel",
      root: "root",
      nodes: [{ id: "root", type: "group", layout: "stack", children: [] }],
      fields: {},
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
      presentationKey: "presentation",
      datasets: {
        one: { kind: "code" },
        two: { kind: "list", columns: [{ id: "name", label: { en: "Name" }, value: "string" }] },
        rows: {
          kind: "list",
          columns: ["name", "source", "value"].map((id) => ({
            id,
            label: { en: id },
            value: "string" as const,
          })),
        },
      },
    },
  };
  const frames: { method: string; params: unknown }[] = [];
  const store = new UiDataStore({
    now: () => 0,
    resolve: () => authority,
    admitCommit: () => "admitted",
    publish: () => {},
  });
  const data = new UiDataClient(async (method, params) => {
    frames.push({ method, params });
    return JSON.parse(
      store.requestFrame(
        authority.owner,
        JSON.stringify({ jsonrpc: "2.0", id: frames.length, method, params }),
      ),
    ).result;
  });
  data.markReady();
  const state = {
    ...snapshot(),
    binding: authority.binding,
    data: { presentation: 0 },
    visible: true,
  };
  const patch = vi.fn(async (_binding: unknown, revision: number, set: Record<string, unknown>) => {
    expect(revision).toBe(state.revision);
    Object.assign(state.data, set);
    state.revision++;
    authority.presentation = state.data.presentation;
    return { ok: true as const, value: { revision: state.revision } };
  });
  const ui = {
    data,
    state: vi.fn(async () => ({ ok: true as const, value: structuredClone(state) })),
    patch,
  } as unknown as PluginContext["ui"];
  return {
    authority,
    store,
    ui,
    frames,
    patch,
    state,
    publisher: new LabPresentationPublisher(ui, authority.binding),
  };
}
const code = (text: string): DatasetV2 => ({ header: { kind: "code" }, entries: [text] });
it("uses real public data validation and commits every dataset before presentation CAS", async () => {
  const f = setup();
  await expect(
    f.publisher.publish({
      one: code("one"),
      two: { header: { kind: "list" }, entries: [{ key: "one", version: null, cells: ["two"] }] },
    }),
  ).resolves.toBe(true);
  expect(f.patch).toHaveBeenCalledTimes(1);
  expect(f.state.data.presentation).toBe(1);
  expect(f.frames.filter((x) => x.method === "ui/dataCommit")).toHaveLength(2);
  expect(
    f.store.snapshot(f.authority.owner, { binding: { ...f.authority.binding, kind: "panel" } }),
  ).toMatchObject({
    ok: true,
    value: {
      datasets: [
        { dataset: "one", presentation: 1 },
        { dataset: "two", presentation: 1 },
      ],
    },
  });
});
it("never patches a partial batch and resumes later with actual committed revisions", async () => {
  const f = setup();
  const commit = f.ui.data.commit.bind(f.ui.data);
  vi.spyOn(f.ui.data, "commit")
    .mockImplementationOnce(commit)
    .mockImplementationOnce(async () => ({
      ok: false,
      error: {
        code: "PLUGIN_E_RESOURCE_LIMIT",
        message: "busy",
        detail: { kind: "ui-data", reason: "queue" },
      },
    }));
  await expect(
    f.publisher.publish({
      one: code("one"),
      two: { header: { kind: "list" }, entries: [{ key: "one", version: null, cells: ["two"] }] },
    }),
  ).rejects.toThrow();
  expect(f.patch).not.toHaveBeenCalled();
  expect(f.frames.some((x) => x.method === "ui/dataAbort")).toBe(true);
  await expect(
    f.publisher.publish({
      one: code("next"),
      two: { header: { kind: "list" }, entries: [{ key: "one", version: null, cells: ["two"] }] },
    }),
  ).resolves.toBe(true);
  expect(f.state.data.presentation).toBe(2);
  const starts = f.frames
    .filter((x) => x.method === "ui/dataBegin")
    .map((x) => x.params as UiDataRequestMapV2["ui/dataBegin"]["params"]);
  expect(starts[2]).toMatchObject({ dataset: "one", baseRevision: 1, presentation: 2 });
});
it("packs Unicode rows within chunk bytes and preserves all entries", async () => {
  const f = setup();
  const rows = Array.from({ length: 50 }, (_, i) => ({
    key: String(i),
    version: null,
    cells: Array(3).fill("界".repeat(200)),
  }));
  await f.publisher.publish({ rows: { header: { kind: "list" }, entries: rows } });
  const chunks = f.frames.filter((x) => x.method === "ui/dataChunk");
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks)
    expect(Buffer.byteLength(JSON.stringify(chunk.params))).toBeLessThan(65536);
  expect(f.patch).toHaveBeenCalledOnce();
});
it("a hidden or disposed panel performs no presentation mutation", async () => {
  const f = setup();
  f.state.visible = false;
  await expect(f.publisher.publish({ one: code("hidden") })).resolves.toBe(false);
  expect(f.frames).toEqual([]);
  expect(f.patch).not.toHaveBeenCalled();
  f.publisher.dispose();
  f.state.visible = true;
  await expect(f.publisher.publish({ one: code("disposed") })).resolves.toBe(false);
});
