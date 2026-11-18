import { expect, it } from "vitest";
import { uiRequestSchemas } from "./ui-methods.js";
import { requestMethods } from "./methods.js";
import { validateCommandInvocation } from "./ui-validation.js";
it("U06 keeps the four-field initialize and null legacy command", () => {
  expect(
    requestMethods.initialize.params.parse({
      apiVersion: "1.4.0",
      pluginId: "test.ui",
      locale: "en",
      grantedPermissions: [],
    }),
  ).toEqual({
    apiVersion: "1.4.0",
    pluginId: "test.ui",
    locale: "en",
    grantedPermissions: [],
  });
  expect(requestMethods["command/execute"].result.parse(null)).toBeNull();
  expect(
    uiRequestSchemas["ui/negotiate"].result.safeParse({
      ok: true,
      value: {
        commandEnvelopeVersions: [1, 1],
        uiResourceVersions: [1],
      },
    }).success,
  ).toBe(false);
});
it("U07 rejects fabricated context and management panel authority", () => {
  const value = {
    version: 1,
    invocationId: "00000000-0000-4000-8000-000000000001",
    command: "test.ui.run",
    arguments: {},
    context: {
      contextRef: null,
      origin: "management",
      locale: "en",
      trigger: { kind: "activate" },
    },
  };
  expect(validateCommandInvocation(value).ok).toBe(true);
  expect(
    validateCommandInvocation({ ...value, context: { ...value.context, role: "holder" } }).ok,
  ).toBe(false);
  expect(
    validateCommandInvocation({
      ...value,
      context: { ...value.context, motionScopeRef: value.invocationId },
    }).ok,
  ).toBe(false);
  expect(
    validateCommandInvocation({ ...value, arguments: { actionRef: value.invocationId } }).ok,
  ).toBe(false);
});

import { validUiWire } from "./ui-validation.js";
it("U05/U07 catches non-exportable semantic limits at the peer boundary", () => {
  expect(validUiWire("ui/subscribe", "params", { topics: ["state"] })).toBe(false);
  expect(validUiWire("ui/subscribe", "params", { topics: ["instances", "instances"] })).toBe(false);
  expect(validUiWire("ui/patch", "params", { set: {} })).toBe(false);
  expect(
    validUiWire("ui/state", "result", { ok: false, error: { message: "x".repeat(2001) } }),
  ).toBe(false);
  const call = {
    version: 1,
    invocationId: "00000000-0000-4000-8000-000000000001",
    command: "test.ui.run",
    arguments: {},
    context: {
      contextRef: null,
      origin: "management",
      locale: "en",
      trigger: { kind: "activate" },
    },
  };
  expect(
    validUiWire(
      "command/invoke",
      "result",
      {
        ok: true,
        value: { output: {}, fieldErrors: [{ field: "foreign", message: { en: "No" } }] },
      },
      call,
    ),
  ).toBe(false);
});

it.each(["PLUGIN_E_COMMAND_FAILED", "PLUGIN_E_CANCELLED", "PLUGIN_E_TIMEOUT"])(
  "serializes cached command outcome %s",
  (code) => {
    expect(
      uiRequestSchemas["command/invoke"].result.safeParse({
        ok: false,
        error: { code, message: "Command did not complete." },
      }).success,
    ).toBe(true);
    expect(
      uiRequestSchemas["command/invoke"].result.safeParse({
        ok: false,
        error: { code, message: "Command did not complete.", extra: true },
      }).success,
    ).toBe(false);
  },
);
