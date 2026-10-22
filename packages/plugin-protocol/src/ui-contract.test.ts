import { expect, expectTypeOf, it } from "vitest";
import { requestMethods } from "./methods.js";
import { UI_LIMITS_V1, UI_RESOURCE_VERSION } from "./ui-limits.js";
import type { CommandInvocation, UiBinding } from "./ui-types.js";
import type { UiRequestMap } from "./ui-methods.js";
it("freezes UI v1 without changing legacy envelopes (U06)", () => {
  expect(UI_RESOURCE_VERSION).toBe(1);
  expect(Object.isFrozen(UI_LIMITS_V1)).toBe(true);
  expect(UI_LIMITS_V1).toMatchObject({
    resourceBytes: 262144,
    hostBytes: 8388608,
    nodes: 256,
    depth: 8,
    challengeMs: 100,
    expiryMs: 350,
  });
  expect(requestMethods["command/execute"].result.parse(null)).toBe(null);
  expect(
    requestMethods.initialize.params.safeParse({
      apiVersion: "1.4.0",
      pluginId: "acme.ui",
      locale: "en",
      grantedPermissions: [],
      ui: true,
    }).success,
  ).toBe(false);
  expectTypeOf<UiRequestMap["command/invoke"]["params"]>().toEqualTypeOf<CommandInvocation>();
  expectTypeOf<UiBinding["uiResourceGeneration"]>().toEqualTypeOf<number>();
});

import { readFileSync } from "node:fs";
import { z } from "zod";

// F freezes the inventory envelope. Resource semantics are delivered by 3B1-T1.
const fixtureExpected = z.strictObject({
  numericCode: z.number().nullable(),
  businessCode: z.string().nullable(),
  reason: z.string().nullable(),
  permission: z.string().nullable(),
  lifetime: z.string().nullable(),
  persistedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const fixtureInput = z.strictObject({
  version: z.number().int().min(1).max(65535),
  resource: z.unknown(),
  raw: z.string(),
  rawBytes: z
    .number()
    .int()
    .min(0)
    .max(UI_LIMITS_V1.resourceBytes + 1),
  commands: z.array(z.unknown()).max(32),
  panels: z.array(z.string()).max(UI_LIMITS_V1.sourcePanels),
});
const fixtureCase = z
  .strictObject({
    id: z.string().min(1),
    schema: z.literal("ui-resource-case"),
    phase: z.literal("resource"),
    input: fixtureInput,
    valid: z.boolean(),
    expected: fixtureExpected,
  })
  .superRefine((value, context) => {
    if (!value.valid && (value.expected.businessCode === null || value.expected.reason === null)) {
      context.addIssue({
        code: "custom",
        message: "Invalid cases require businessCode and reason",
      });
    }
    if (value.valid && Object.values(value.expected).some((field) => field !== null)) {
      context.addIssue({ code: "custom", message: "Valid cases require six null expected fields" });
    }
  });
const fixtureFile = z.strictObject({
  formatVersion: z.literal(1),
  family: z.literal("declarative-ui-v1"),
  cases: z.array(fixtureCase).min(1),
});

it("freezes strict AM-31 UI fixture envelopes and measured UTF-8 bytes", () => {
  for (const name of ["valid", "invalid", "maximum"]) {
    const file = fixtureFile.parse(
      JSON.parse(
        readFileSync(
          new URL(`../test-fixtures/declarative-ui-v1/${name}.json`, import.meta.url),
          "utf8",
        ),
      ),
    );
    for (const entry of file.cases) {
      expect(Buffer.byteLength(entry.input.raw, "utf8")).toBe(entry.input.rawBytes);
      expect(JSON.parse(entry.input.raw)).toEqual(entry.input.resource);
    }
  }
});

it("rejects foreign fixture formats, dispatch keys, phases and extra fields", () => {
  const entry = {
    id: "envelope",
    schema: "ui-resource-case",
    phase: "resource",
    input: { version: 1, resource: {}, raw: "{}", rawBytes: 2, commands: [], panels: [] },
    valid: true,
    expected: {
      numericCode: null,
      businessCode: null,
      reason: null,
      permission: null,
      lifetime: null,
      persistedSha256: null,
    },
  };
  const file = { formatVersion: 1, family: "declarative-ui-v1", cases: [entry] };
  expect(fixtureFile.safeParse(file).success).toBe(true);
  for (const change of [{ formatVersion: 2 }, { family: "device-broker-v1" }, { extra: true }]) {
    expect(fixtureFile.safeParse({ ...file, ...change }).success).toBe(false);
  }
  for (const change of [
    { schema: "foreign" },
    { phase: "unknown" },
    { extra: true },
    { expected: { ...entry.expected, extra: true } },
    { expected: { ...entry.expected, reason: "schema" } },
    { input: { ...entry.input, extra: true } },
  ]) {
    expect(fixtureFile.safeParse({ ...file, cases: [{ ...entry, ...change }] }).success).toBe(
      false,
    );
  }
  for (const key of Object.keys(entry.expected)) {
    const expected = { ...entry.expected };
    Reflect.deleteProperty(expected, key);
    expect(fixtureFile.safeParse({ ...file, cases: [{ ...entry, expected }] }).success).toBe(false);
  }
});

it("requires both business code and reason on every invalid fixture", () => {
  const file = JSON.parse(
    readFileSync(
      new URL("../test-fixtures/declarative-ui-v1/invalid.json", import.meta.url),
      "utf8",
    ),
  );
  const entry = file.cases[0];
  for (const key of ["businessCode", "reason"]) {
    expect(
      fixtureCase.safeParse({ ...entry, expected: { ...entry.expected, [key]: null } }).success,
    ).toBe(false);
  }
});
