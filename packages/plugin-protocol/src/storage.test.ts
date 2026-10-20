import { expect, it } from "vitest";
import { recordWriteSchema, storageRequestSchemas } from "./storage.js";
import { canonicalBase64Length } from "./persistence-validation.js";
const h = "00000000-0000-4000-8000-000000000001";
const write = { target: { mode: "create" }, kind: "lab.samples", schemaVersion: 1,
  label: "Samples", mediaType: "application/octet-stream", byteLength: 0, sha256: "0".repeat(64) };
it("accepts zero and 8 MiB and rejects coercion/unsafe/oversized lengths", () => {
  for (const byteLength of [0, 8388608]) expect(recordWriteSchema.safeParse({ ...write, byteLength }).success).toBe(true);
  for (const byteLength of [8388609, true, "0", NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(recordWriteSchema.safeParse({ ...write, byteLength }).success).toBe(false);
});
it("checks base64 without allocating decoded bytes", () => {
  for (const data of ["Zh==", "Zg", "Zg===", "Zg==\n", "_w==", "Zm9=", ""]) expect(() => canonicalBase64Length(data)).toThrow();
  expect(canonicalBase64Length("Zg==")).toBe(1);
  expect(canonicalBase64Length("Zm8=")).toBe(2);
  expect(canonicalBase64Length("Zm9v")).toBe(3);
  expect(canonicalBase64Length("", true)).toBe(0);
  const max = Buffer.alloc(262144).toString("base64");
  expect(max.length).toBe(349528);
  expect(storageRequestSchemas["storage/writeChunk"].params.safeParse({ write: h, offset: 0, data: max }).success).toBe(true);
  expect(storageRequestSchemas["storage/writeChunk"].params.safeParse({ write: h, offset: 0, data: Buffer.alloc(262145).toString("base64") }).success).toBe(false);
});
it("does not confuse a drain submission with a host saved report", () => {
  const schema = storageRequestSchemas["storage/drain"].result;
  expect(schema.safeParse({ ok: true, value: { status: "submitted", writes: [h] } }).success).toBe(true);
  expect(schema.safeParse({ ok: true, value: { status: "saved", writes: [] } }).success).toBe(false);
  expect(schema.safeParse({ ok: true, value: { status: "submitted", writes: [h, h, h] } }).success).toBe(false);
});
