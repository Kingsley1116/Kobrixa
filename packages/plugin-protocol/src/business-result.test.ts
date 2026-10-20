import { expect, it } from "vitest";
import { deviceRequestSchemas } from "./device-methods.js";
import { validateDeviceWire } from "./device-validation.js";
const check = (code: string, detail: unknown) => {
  const value = { ok: false, error: { code, message: "Rejected", detail } };
  deviceRequestSchemas["devices/list"].result.parse(value);
  validateDeviceWire("devices/list.result", value);
};
it("F18 closed shared code/kind/reason pairs", () => {
  for (const reason of ["permission", "user-action-required"])
    check("PLUGIN_E_PERMISSION_DENIED", { kind: "permission", reason });
  check("PLUGIN_E_STALE_RESOURCE", { kind: "resource", reason: "stale", resource: "operation" });
  for (const reason of ["quota", "rate", "queue"])
    check("PLUGIN_E_RESOURCE_LIMIT", { kind: "resource", reason, resource: "rpc", limit: 16 });
  for (const [code, detail] of [
    ["PLUGIN_E_DEVICE_BUSY", { kind: "permission", reason: "permission" }],
    ["PLUGIN_E_RESOURCE_LIMIT", { kind: "resource", reason: "stale", resource: "rpc" }],
    ["PLUGIN_E_STALE_RESOURCE", { kind: "resource", reason: "stale", resource: "storage" }],
    [
      "PLUGIN_E_DEVICE_OPERATION",
      {
        kind: "device",
        reason: "cancelled",
        dispatch: "not-sent",
        stopConfirmation: "not-required",
      },
    ],
  ] as const)
    expect(() => check(code, detail)).toThrow();
});

import { commonFailureSchema, commonFailureSchemaFor } from "./business-result.js";
import type {
  BusinessResult,
  ResourceErrorDetailFor,
  ResourceKindV170,
} from "./business-result.js";
import type { PluginErrorCodeV170 } from "./errors.js";
it("future resource projections compile but are rejected by the P150 schema", () => {
  const future: BusinessResult<
    never,
    ResourceErrorDetailFor<ResourceKindV170>,
    PluginErrorCodeV170
  > = {
    ok: false,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE",
      message: "stale",
      detail: { kind: "resource", reason: "stale", resource: "storage-watch" },
    },
  };
  expect(commonFailureSchema.safeParse(future).success).toBe(false);
  expect(commonFailureSchemaFor("1.6.0").safeParse(future).success).toBe(false);
  expect(commonFailureSchemaFor("1.7.0").safeParse(future).success).toBe(true);
  expect(
    commonFailureSchemaFor("1.7.0").safeParse({
      ...future,
      error: { ...future.error, code: "PLUGIN_E_RESOURCE_LIMIT" },
    }).success,
  ).toBe(false);
});

import { PLUGIN_API_VERSION } from "./limits.js";
it("keeps public P150 closed while isolated UI results compile", () => {
  const failure = {
    ok: false,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE",
      message: "stale",
      detail: { kind: "resource", reason: "stale", resource: "ui-binding" },
    },
  };
  expect(commonFailureSchemaFor("1.5.0").safeParse(failure).success).toBe(false);
  expect(commonFailureSchemaFor("1.6.0").safeParse(failure).success).toBe(true);
  expect(commonFailureSchema.safeParse(failure).success).toBe(
    String(PLUGIN_API_VERSION) !== "1.5.0",
  );
  expect(
    commonFailureSchemaFor("1.6.0").safeParse({
      ...failure,
      error: { ...failure.error, detail: { ...failure.error.detail, resource: "storage-watch" } },
    }).success,
  ).toBe(false);
});

it("keeps every persistence code and resource outside the P160 publication", () => {
  for (const resource of [
    "storage-write",
    "storage-read",
    "storage-list",
    "storage-export",
    "storage-watch",
  ]) {
    expect(
      commonFailureSchema.safeParse({
        ok: false,
        error: {
          code: "PLUGIN_E_STALE_RESOURCE",
          message: "stale",
          detail: { kind: "resource", reason: "stale", resource },
        },
      }).success,
    ).toBe(false);
  }
  for (const code of [
    "PLUGIN_E_SETTINGS_SCHEMA",
    "PLUGIN_E_SETTINGS_CONFLICT",
    "PLUGIN_E_SETTINGS_SAVE",
    "PLUGIN_E_STORAGE_QUOTA",
    "PLUGIN_E_STORAGE_CONFLICT",
    "PLUGIN_E_STORAGE_IO",
    "PLUGIN_E_STORAGE_VERSION",
  ]) {
    expect(pluginErrorCodeSchema.safeParse(code).success).toBe(false);
  }
});
import { pluginErrorCodeSchema } from "./business-result.js";
