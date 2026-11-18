import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { uiFormRequestSchemasV2 as schemas, validUiFormWireV2 as valid } from "./ui-v2-form.js";
import { panelResourceV2Schema } from "./ui-v2-resource.js";
import { panelResourceV1Schema } from "./ui-resource.js";
import { RpcPeer } from "./peer.js";
import { createMemoryChannelPair } from "./memory-channel.js";
const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  contributionId: "test.lab.panel",
  panelInstance: id,
  kind: "panel" as const,
  uiResourceGeneration: 1,
  generation: 1,
  hostEpoch: id,
  processEpoch: id,
};
const params = { binding, baseFormRevision: 2, set: { a: "-" } };
const result = { ok: true as const, value: { formRevision: 3, form: { a: "-", b: false } } };
const schema = schemas["ui/formPatch"];
const peers: RpcPeer[] = [];
afterEach(() => peers.splice(0).forEach((p) => p.close()));
function pair(ready = true, version: 1 | 2 = 2) {
  const [local, remote] = createMemoryChannelPair();
  const peer = new RpcPeer(local);
  peers.push(peer);
  peer.setUiCandidate(true);
  peer.setUiSession(version, ready);
  return { peer, remote };
}
it("exports strict bounded schemas and a true-only optional panel flag without widening v1", () => {
  const fields = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, null]));
  expect(schema.params.safeParse({ ...params, set: fields }).success).toBe(true);
  expect(valid("params", { ...params, set: { ...fields, extra: null } })).toBe(false);
  expect(valid("params", { ...params, set: {} })).toBe(false);
  expect(
    schema.params.safeParse({ ...params, binding: { ...binding, kind: "status" } }).success,
  ).toBe(false);
  expect(schema.params.safeParse({ ...params, extra: 1 }).success).toBe(false);
  const exported = z.toJSONSchema(schema.params);
  expect(exported.properties?.set).toMatchObject({ minProperties: 1, maxProperties: 32 });
  const panel = {
    kind: "panel",
    data: {},
    fields: {},
    root: "root",
    nodes: [{ id: "root", type: "group", layout: "stack", children: ["leaf"] }],
    datasets: {},
    presentationKey: "presentation",
  };
  expect(panelResourceV2Schema.safeParse({ ...panel, formSync: true }).success).toBe(true);
  for (const formSync of [false, undefined, "true"])
    expect(panelResourceV2Schema.safeParse({ ...panel, formSync }).success).toBe(false);
  const v1 = {
    kind: panel.kind,
    data: panel.data,
    fields: panel.fields,
    root: panel.root,
    nodes: panel.nodes,
  };
  expect(panelResourceV1Schema.safeParse(v1).success).toBe(true);
  expect(panelResourceV1Schema.safeParse({ ...v1, formSync: true }).success).toBe(false);
});
it("validates exact 16KiB, scalar strings, original prototypes and correlated success", () => {
  const set = {
    a: "x".repeat(4000),
    b: "x".repeat(4000),
    c: "x".repeat(4000),
    d: "x".repeat(4000),
    e: "x".repeat(348),
  };
  expect(new TextEncoder().encode(JSON.stringify(set)).length).toBe(16384);
  expect(valid("params", { ...params, set })).toBe(true);
  expect(
    valid("result", { ok: true, value: { formRevision: 3, form: set } }, { ...params, set }),
  ).toBe(true);
  expect(
    valid(
      "result",
      { ok: true, value: { formRevision: 3, form: { ...set, e: set.e + "x" } } },
      { ...params, set: { a: set.a } },
    ),
  ).toBe(false);
  const full = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, null]));
  expect(
    valid(
      "result",
      { ok: true, value: { formRevision: 3, form: full } },
      { ...params, set: { f0: null } },
    ),
  ).toBe(true);
  expect(
    valid(
      "result",
      { ok: true, value: { formRevision: 3, form: { ...full, extra: null } } },
      { ...params, set: { f0: null } },
    ),
  ).toBe(false);
  expect(valid("params", { ...params, set: { ...set, e: set.e + "x" } })).toBe(false);
  for (const a of [NaN, Infinity, "\ud800", "\u0000", "x".repeat(4001)])
    expect(valid("params", { ...params, set: { a } })).toBe(false);
  for (const set of [
    JSON.parse('{"constructor":1}'),
    JSON.parse('{"__proto__":1}'),
    Object.assign(Object.create({ x: 1 }), { a: 1 }),
  ])
    expect(valid("params", { ...params, set })).toBe(false);
  expect(valid("result", result, params)).toBe(true);
  expect(valid("result", { ok: true, value: { formRevision: 4, form: { a: "-" } } }, params)).toBe(
    false,
  );
  expect(
    valid("result", { ok: true, value: { formRevision: 3, form: { a: "changed" } } }, params),
  ).toBe(false);
  expect(valid("result", { ok: true, value: { formRevision: 3, form: {} } }, params)).toBe(false);
  expect(valid("result", { ok: true, value: { formRevision: 3, form: set } }, params)).toBe(false);
});
it.each([
  [false, 2],
  [true, 1],
] as const)("rejects transport before readiness or in v1 (%s,%s)", async (ready, version) => {
  const { peer, remote } = pair(ready, version);
  const called = vi.fn(() => result);
  peer.handle("ui/formPatch", called);
  await expect(peer.request("ui/formPatch", params)).rejects.toThrow("not ready");
  remote.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ui/formPatch", params }));
  await new Promise((r) => setImmediate(r));
  expect(called).not.toHaveBeenCalled();
});
it("uses real peer correlation and returns existing stale errors unchanged", async () => {
  const { peer, remote } = pair();
  const error = {
    ok: false,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE",
      message: "Stale form.",
      detail: { kind: "resource", reason: "stale", resource: "ui-binding" },
    },
  };
  remote.onMessage((text) =>
    remote.send(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(text).id, result: error })),
  );
  expect(await peer.request("ui/formPatch", params)).toEqual(error);
});
it("rejects original oversized whitespace request and escaped response frames", async () => {
  const { peer, remote } = pair();
  const called = vi.fn(() => result);
  peer.handle("ui/formPatch", called);
  remote.send(
    " ".repeat(65536) + JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ui/formPatch", params }),
  );
  await new Promise((r) => setImmediate(r));
  expect(called).not.toHaveBeenCalled();
  remote.onMessage((text) => {
    const q = JSON.parse(text);
    if (q.method)
      remote.send(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }) + " ".repeat(65536));
  });
  await expect(peer.request("ui/formPatch", params)).rejects.toThrow("64 KiB");
});
