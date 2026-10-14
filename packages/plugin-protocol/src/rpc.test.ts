import { describe, expect, it } from "vitest";
import { jsonRpcMessageSchema, notificationMethods, requestMethods } from "./index.js";

const ok = (value: unknown) => jsonRpcMessageSchema.safeParse(value).success;

describe("JSON-RPC envelope", () => {
  it("accepts the four message shapes", () => {
    expect(ok({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBe(true);
    expect(ok({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } })).toBe(true);
    expect(ok({ jsonrpc: "2.0", id: 1, result: null })).toBe(true);
    expect(ok({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })).toBe(
      true,
    );
  });
  it("rejects malformed envelopes", () => {
    expect(ok({ jsonrpc: "1.0", id: 1, method: "x" })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1, method: "x", extra: true })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1, result: null, error: { code: 1, message: "" } })).toBe(
      false,
    );
    expect(ok({ jsonrpc: "2.0", id: 1, method: "x", params: [1] })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1.5, method: "x" })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1, result: "text" })).toBe(false);
  });
});

describe("method schemas", () => {
  it("rejects a plugin that declares its own identity", () => {
    const params = requestMethods["ui/showMessage"].params;
    expect(params.safeParse({ severity: "info", message: "hi" }).success).toBe(true);
    expect(
      params.safeParse({ severity: "info", message: "hi", pluginId: "kobrixa.basic-plus" }).success,
    ).toBe(false);
  });
  it("validates handshake locale and cancellation ids", () => {
    const initialize = requestMethods.initialize.params;
    const base = {
      apiVersion: "1.0.0",
      pluginId: "acme.x",
      locale: "zh-TW",
      grantedPermissions: [],
    };
    expect(initialize.safeParse(base).success).toBe(true);
    expect(initialize.safeParse({ ...base, locale: "fr" }).success).toBe(false);
    expect(notificationMethods["$/cancelRequest"].safeParse({ id: "a" }).success).toBe(true);
  });
  it("rejects message text with control characters but allows newlines", () => {
    const params = requestMethods["ui/showMessage"].params;
    expect(params.safeParse({ severity: "info", message: "a\nb\tc" }).success).toBe(true);
    expect(params.safeParse({ severity: "info", message: "a\u0000" }).success).toBe(false);
  });
});
