import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uiRequestSchemas } from "./ui-methods.js";
import {
  uiDataRequestSchemasV2 as methods,
  uiDataEventSchemaV2,
  uiDataFailureSchemaV2,
  validateUiDataReadValueV2,
  validateUiDataSnapshotValueV2,
  assertUiDataFrameBudgetV2,
} from "./ui-v2-methods.js";
const handle = "00000000-0000-4000-8000-000000000001";
const binding = {
  contributionId: "test.lab.panel",
  panelInstance: handle,
  kind: "panel",
  uiResourceGeneration: 1,
  generation: 1,
  hostEpoch: handle,
  processEpoch: handle,
};
const base = { binding, dataset: "code" };
const sha256 = "a".repeat(64);
const meta = { revision: 1, presentation: 1, byteLength: 20, sha256 };
const begin = () => ({
  ...base,
  baseRevision: 0,
  presentation: 1,
  header: { kind: "code" },
  entryCount: 0,
  byteLength: 20,
  sha256,
});
const page = () => ({
  ok: true,
  value: {
    ...meta,
    header: { kind: "code" },
    chunk: { kind: "code", entries: [] as string[] },
    nextOffset: 0,
    done: true,
  },
});
describe("unpublished UI v2 data-plane method leaves", () => {
  it("exports all six strict method shapes and the bounded invalidation event", () => {
    expect(Object.keys(methods)).toHaveLength(6);
    for (const method of Object.values(methods)) {
      for (const schema of [method.params, method.result]) {
        const exported = JSON.stringify(z.toJSONSchema(schema));
        expect(exported).toContain('"additionalProperties":false');
      }
    }
    expect(z.toJSONSchema(uiDataEventSchemaV2)).toBeDefined();
    expect(
      uiDataEventSchemaV2.safeParse({
        kind: "ui.data",
        data: { ...base, revision: 1, presentation: 1 },
      }).success,
    ).toBe(true);
    expect(
      uiDataEventSchemaV2.safeParse({
        kind: "ui.data",
        data: { ...base, revision: 1, presentation: 1, payload: "x" },
      }).success,
    ).toBe(false);
  });
  it("allows absent-base admission but rejects non-panel, forged owner and unsafe counters", () => {
    expect(methods["ui/dataBegin"].params.safeParse(begin()).success).toBe(true);
    for (const change of [
      { binding: { ...binding, kind: "status" } },
      { binding: { ...binding, pluginId: "test.lab" } },
      { baseRevision: -1 },
      { baseRevision: Number.MAX_SAFE_INTEGER + 1 },
      { presentation: 0 },
      { entryCount: 16385 },
      { byteLength: 524289 },
      { sha256: "A".repeat(64) },
      { extra: 1 },
    ])
      expect(methods["ui/dataBegin"].params.safeParse({ ...begin(), ...change }).success).toBe(
        false,
      );
  });
  it("bounds chunk shape and read page requests without coercion", () => {
    const chunk = {
      ...base,
      transfer: handle,
      offset: 0,
      chunk: { kind: "code", entries: ["hi"] },
    };
    expect(methods["ui/dataChunk"].params.safeParse(chunk).success).toBe(true);
    expect(methods["ui/dataChunk"].params.safeParse({ ...chunk, offset: "0" }).success).toBe(false);
    for (const limit of [1, 256])
      expect(
        methods["ui/dataRead"].params.safeParse({ ...base, revision: 1, offset: 0, limit }).success,
      ).toBe(true);
    for (const limit of [0, 257, 1.5, Infinity])
      expect(
        methods["ui/dataRead"].params.safeParse({ ...base, revision: 1, offset: 0, limit }).success,
      ).toBe(false);
    expect(
      methods["ui/dataRead"].params.safeParse({ ...base, revision: 0, offset: 0, limit: 1 })
        .success,
    ).toBe(false);
  });
  it("pairs header/chunk kinds even before semantic admission", () => {
    expect(methods["ui/dataRead"].result.safeParse(page()).success).toBe(true);
    const mismatch = page();
    mismatch.value.chunk.kind = "table";
    expect(methods["ui/dataRead"].result.safeParse(mismatch).success).toBe(false);
    const bad = page();
    bad.value.byteLength = 524289;
    expect(methods["ui/dataRead"].result.safeParse(bad).success).toBe(false);
  });
  it("accepts bounded metadata-only snapshots and terminal receipts", () => {
    const schema = methods["ui/dataSnapshot"].result;
    expect(schema.safeParse({ ok: true, value: { datasets: [] } }).success).toBe(true);
    expect(
      schema.safeParse({
        ok: true,
        value: { datasets: Array.from({ length: 8 }, (_, i) => ({ ...meta, dataset: `d-${i}` })) },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ok: true,
        value: { datasets: Array.from({ length: 9 }, (_, i) => ({ ...meta, dataset: `d-${i}` })) },
      }).success,
    ).toBe(false);
    expect(methods["ui/dataCommit"].result.safeParse({ ok: true, value: meta }).success).toBe(true);
    expect(
      methods["ui/dataAbort"].result.safeParse({ ok: true, value: { aborted: false } }).success,
    ).toBe(true);
  });
  it("pairs each business code/reason and keeps v1 result parsers isolated", () => {
    const pairs = {
      PLUGIN_E_UI_RESOURCE: ["schema", "reference", "offset", "checksum"],
      PLUGIN_E_STALE_RESOURCE: ["revision", "expired", "stale"],
      PLUGIN_E_RESOURCE_LIMIT: ["quota", "rate", "queue"],
      PLUGIN_E_UI_VERSION: ["version"],
    };
    for (const [code, reasons] of Object.entries(pairs))
      for (const reason of Object.values(pairs).flat()) {
        const error = {
          ok: false,
          error: { code, message: "Rejected", detail: { kind: "ui-data", reason } },
        };
        expect(uiDataFailureSchemaV2.safeParse(error).success).toBe(reasons.includes(reason));
        expect(uiRequestSchemas["ui/patch"].result.safeParse(error).success).toBe(false);
      }
    expect(
      uiDataFailureSchemaV2.safeParse({
        ok: false,
        error: {
          code: "PLUGIN_E_PERMISSION_DENIED",
          message: "Missing permission",
          detail: { kind: "permission", reason: "permission" },
        },
      }).success,
    ).toBe(true);
  });
});

it("measures the whole read result at the exact byte boundary", () => {
  const p = page();
  p.value.chunk.entries = Array(48).fill("x".repeat(1000));
  p.value.nextOffset = 49;
  const size = () => new TextEncoder().encode(JSON.stringify(p)).byteLength;
  p.value.chunk.entries.push("x".repeat(49152 - size() - 3));
  expect(size()).toBe(49152);
  expect(() =>
    validateUiDataReadValueV2(p.value, { revision: 1, offset: 0, limit: 256 }),
  ).not.toThrow();
  p.value.chunk.entries[48] += "x";
  expect(size()).toBe(49153);
  expect(() =>
    validateUiDataReadValueV2(p.value, { revision: 1, offset: 0, limit: 256 }),
  ).toThrow();
});
it("rejects duplicate snapshot identities and bounds the complete RPC envelope", () => {
  expect(() =>
    validateUiDataSnapshotValueV2({
      datasets: [
        { ...meta, dataset: "a" },
        { ...meta, dataset: "a" },
      ],
    }),
  ).toThrow();
  expect(() =>
    validateUiDataSnapshotValueV2({ datasets: [{ ...meta, dataset: "constructor" }] }),
  ).toThrow();
  const frame = { jsonrpc: "2.0" as const, id: 1, result: { text: "" } };
  const size = () => new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  frame.result.text = "x".repeat(65536 - size());
  expect(size()).toBe(65536);
  expect(() => assertUiDataFrameBudgetV2(JSON.stringify(frame))).not.toThrow();
  frame.result.text += "x";
  expect(() => assertUiDataFrameBudgetV2(JSON.stringify(frame))).toThrow();
});

it("binds read progress to the original request and rejects empty nonterminal pages", () => {
  const request = { revision: 1, offset: 2, limit: 1 };
  const p = page();
  p.value.chunk.entries = ["a"];
  p.value.nextOffset = 3;
  expect(() => validateUiDataReadValueV2(p.value, request)).not.toThrow();
  for (const change of [
    { nextOffset: 0 },
    { nextOffset: 4 },
    { revision: 2 },
    { chunk: { kind: "code", entries: ["a", "b"] }, nextOffset: 4 },
  ])
    expect(() => validateUiDataReadValueV2({ ...p.value, ...change }, request)).toThrow();
  const empty = { ...p.value, chunk: { kind: "code", entries: [] }, nextOffset: 2, done: true };
  expect(() => validateUiDataReadValueV2(empty, request)).not.toThrow();
  expect(() => validateUiDataReadValueV2({ ...empty, done: false }, request)).toThrow();
});
it("counts whitespace and escapes from the actual incoming frame", () => {
  const raw = '{"jsonrpc":"2.0","id":1,"result":{"text":"' + "\\u0078".repeat(12000) + '"}}';
  expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(65536);
  expect(JSON.stringify(JSON.parse(raw)).length).toBeLessThan(65536);
  expect(() => assertUiDataFrameBudgetV2(raw)).toThrow();
  expect(() => assertUiDataFrameBudgetV2(new TextEncoder().encode(raw))).toThrow();
});
