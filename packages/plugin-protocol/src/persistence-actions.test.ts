import { expect, it } from "vitest";
import { persistenceActionRequestSchemas as schemas } from "./persistence-actions.js";
const actionRef = "00000000-0000-4000-8000-000000000001";
it("bounds plain clipboard text by both code points and UTF-8 bytes", () => {
  const parse = (text: string) => schemas["ui/copyText"].params.safeParse({ actionRef, text }).success;
  expect(parse("😀".repeat(16384))).toBe(true);
  expect(parse("😀".repeat(16385))).toBe(false);
  expect(parse("a".repeat(16385))).toBe(false);
  expect(parse("\0")).toBe(false);
  expect(parse("\udfff")).toBe(false);
  expect(schemas["ui/copyText"].params.safeParse({ actionRef, text: "x", html: "x" }).success).toBe(false);
});
it("keeps destination paths and fabricated cancellation out of results", () => {
  expect(schemas["storage/exportBegin"].result.safeParse({ ok: true, value: { export: actionRef, state: "waiting", expiresAt: 1, path: "/tmp/x" } }).success).toBe(false);
  expect(schemas["storage/exportCancel"].result.safeParse({ ok: true, value: { disposition: "cancelled" } }).success).toBe(false);
});
