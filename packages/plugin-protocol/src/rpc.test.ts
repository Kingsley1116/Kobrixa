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

import {
  PLUGIN_API_VERSION,
  settingsRequestSchemas,
  storageRequestSchemas,
  persistenceActionRequestSchemas,
} from "./index.js";

it("publishes all and only the domain persistence methods at 1.7", () => {
  expect(PLUGIN_API_VERSION).toBe("1.7.0");
  for (const [name, schemas] of Object.entries({
    ...settingsRequestSchemas,
    ...storageRequestSchemas,
    ...persistenceActionRequestSchemas,
  })) {
    expect(requestMethods).toHaveProperty([name]);
    expect(requestMethods[name as keyof typeof requestMethods]).toBe(schemas);
  }
  const installed = Object.keys(requestMethods).filter(
    (name) => name.startsWith("settings/") || name.startsWith("storage/") || name === "ui/copyText",
  );
  expect(installed.sort()).toEqual(
    Object.keys({
      ...settingsRequestSchemas,
      ...storageRequestSchemas,
      ...persistenceActionRequestSchemas,
    }).sort(),
  );
  expect(Object.hasOwn(requestMethods, "settings/unwatch")).toBe(false);
  expect(Object.hasOwn(notificationMethods, "settings.gap")).toBe(false);
});
it.each(["1.4.0", "1.5.0", "1.6.0"])(
  "retains legacy initialize and execute at %s",
  (apiVersion) => {
    const initialize = {
      apiVersion,
      pluginId: "test.legacy",
      locale: "en",
      grantedPermissions: [],
    };
    expect(requestMethods.initialize.params.safeParse(initialize).success).toBe(true);
    expect(
      requestMethods["command/execute"].params.safeParse({ command: "test.legacy.run" }).success,
    ).toBe(true);
    expect(requestMethods["command/execute"].result.safeParse(null).success).toBe(true);
    expect(
      requestMethods["command/execute"].result.safeParse({ ok: true, value: {} }).success,
    ).toBe(false);
  },
);
it("keeps owner fields out of persistence request params", () => {
  const params = { schemaVersion: 1 };
  expect(requestMethods["settings/read"].params.safeParse(params).success).toBe(true);
  for (const key of ["sourceKey", "pluginId", "generation", "owner", "path"])
    expect(
      requestMethods["settings/read"].params.safeParse({ ...params, [key]: "foreign" }).success,
    ).toBe(false);
});

const persistenceReasons = {
  PLUGIN_E_SETTINGS_SCHEMA: [
    "invalid-resource",
    "invalid-value",
    "duplicate-key",
    "unknown-key",
    "size-limit",
    "schema-changed-without-version",
    "migration-required",
    "downgrade",
    "unsupported-format",
    "corrupt",
  ],
  PLUGIN_E_SETTINGS_CONFLICT: ["revision-mismatch"],
  PLUGIN_E_SETTINGS_SAVE: [
    "disk-full",
    "permission",
    "read-only",
    "io",
    "sync-failed",
    "publish-uncertain",
    "import-pending",
  ],
  PLUGIN_E_STORAGE_QUOTA: ["record-count", "source-bytes", "host-bytes", "temporary-bytes"],
  PLUGIN_E_STORAGE_CONFLICT: [
    "revision-mismatch",
    "write-in-progress",
    "offset-mismatch",
    "sealed",
    "incomplete",
    "checksum-mismatch",
    "flush-incomplete",
    "export-not-ready",
  ],
  PLUGIN_E_STORAGE_IO: [
    "not-found",
    "disk-full",
    "permission",
    "read-only",
    "io",
    "sync-failed",
    "publish-uncertain",
    "corrupt",
    "import-pending",
    "input-changed",
    "clipboard-unavailable",
    "destination-changed",
    "unsupported-filesystem",
  ],
  PLUGIN_E_STORAGE_VERSION: ["unsupported-format", "schema-mismatch"],
} as const;
it("enforces closed code/kind/reason pairings rather than a Cartesian union", () => {
  const schemas = [settingsRequestSchemas, storageRequestSchemas, persistenceActionRequestSchemas];
  const resultSchemas = schemas.flatMap((map) => Object.values(map).map((entry) => entry.result));
  const accepts = (value: unknown) =>
    resultSchemas.some((schema) => schema.safeParse(value).success);
  const reasons = [
    ...new Set(Object.values(persistenceReasons).flat()),
    "deadline",
    "cancelled",
    "arbitrary",
  ];
  for (const [code, allowed] of Object.entries(persistenceReasons)) {
    for (const reason of reasons) {
      const value = {
        ok: false,
        error: { code, message: "Synthetic failure", detail: { kind: "persistence", reason } },
      };
      expect(accepts(value), `${code}/${reason}`).toBe(
        (allowed as readonly string[]).includes(reason),
      );
    }
    expect(
      accepts({
        ok: false,
        error: { code, message: "Synthetic failure", detail: { kind: "permission", reason: "io" } },
      }),
    ).toBe(false);
  }
  expect(
    accepts({
      ok: false,
      error: {
        code: "PLUGIN_E_PERMISSION_DENIED",
        message: "Denied",
        detail: { kind: "persistence", reason: "permission" },
      },
    }),
  ).toBe(false);
  expect(
    accepts({
      ok: false,
      error: {
        code: "PLUGIN_E_STALE_RESOURCE",
        message: "Stale",
        detail: { kind: "persistence", reason: "not-found" },
      },
    }),
  ).toBe(false);
});
