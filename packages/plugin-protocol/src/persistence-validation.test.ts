import { expect, it, vi } from "vitest";
import { z } from "zod";
import { persistenceResultSchema, persistenceCodeReasons, jsonBytes } from "./persistence-validation.js";
it("has closed code/kind/reason pairs, distinct from numeric JSON-RPC errors", () => {
  const schema = persistenceResultSchema(z.strictObject({ done: z.literal(true) }));
  for (const [code, reasons] of Object.entries(persistenceCodeReasons)) {
    for (const reason of reasons) expect(schema.safeParse({ ok: false, error: { code, message: "Failed", detail: { kind: "persistence", reason } } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code, message: "Failed", detail: { kind: "persistence", reason: "deadline" } } }).success).toBe(false);
  }
  for (const error of [
    { code: -32602, message: "shape" },
    { code: "PLUGIN_E_STORAGE_QUOTA", message: "x", detail: { kind: "persistence", reason: "disk-full" } },
    { code: "PLUGIN_E_PERMISSION_DENIED", message: "x", detail: { kind: "persistence", reason: "permission" } },
    { code: "PLUGIN_E_TIMEOUT", message: "x", detail: { kind: "persistence", reason: "cancelled" } },
  ]) expect(schema.safeParse({ ok: false, error }).success).toBe(false);
  expect(schema.safeParse({ ok: false, error: { code: "PLUGIN_E_TIMEOUT", message: "x" } }).success).toBe(true);
  expect(schema.safeParse({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "x", detail: { kind: "resource", reason: "stale", resource: "storage-read" } } }).success).toBe(true);
  expect(jsonBytes("😀")).toBe(6);
});

it.each(["storage", "persistence-validation"])("initializes when %s is imported first", async (first) => {
  vi.resetModules();
  if (first === "storage") await import("./storage.js");
  else await import("./persistence-validation.js");
  const { settingsRequestSchemas } = await import("./settings.js");
  expect(settingsRequestSchemas["settings/read"].params.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
});
