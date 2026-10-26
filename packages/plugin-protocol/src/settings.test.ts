import type { SettingsResourceV1 } from "./settings.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsRequestSchemas, settingsResourceV1Schema,
  validateSettingsValues, settingsValidationText, checkSettingsVersion } from "./settings.js";
import { jsonBytes, validateSettingsResource } from "./persistence-validation.js";
const field = (key = "a") => ({ key, label: { en: "A" }, type: "string" as const,
  default: "", minLength: 0, maxLength: 4000, maxBytes: 4096 });
const resource = (count = 1) => ({ schemaVersion: 1, title: { en: "Test" },
  fields: Array.from({ length: count }, (_, i) => field(`k${i}`)) });
const validate = (input: unknown) => validateSettingsResource(input, jsonBytes(input));
describe("settings v1", () => {
  it("accepts 128 fields and rejects 129, duplicates, dangerous segments and unknown keys", () => {
    expect(validate(resource(128)).fields).toHaveLength(128);
    expect(() => validate(resource(129))).toThrow();
    for (const key of ["constructor", "a.prototype", "a.__proto__", "A", "a..b", "a." ])
      expect(() => validate({ ...resource(), fields: [field(key)] })).toThrow();
    expect(validate({ ...resource(), fields: [field("device.a1")] }).fields[0]?.key).toBe("device.a1");
    expect(() => validate({ ...resource(), fields: [field(), field()] })).toThrow("duplicate-key");
    expect(settingsResourceV1Schema.safeParse({ ...resource(), extra: true }).success).toBe(false);
    expect(() => validateSettingsValues(resource(), [{ key: "unknown", value: true }], true)).toThrow("unknown-key");
  });
  it("measures original resource bytes and actual serialized values, including escaping", () => {
    expect(validateSettingsResource(resource(), 65536).fields).toHaveLength(1);
    expect(() => validateSettingsResource(resource(), 65537)).toThrow("size-limit");
    const r = resource(16);
    const values = r.fields.map(f => ({ key: f.key, value: "x".repeat(4000) }));
    const overhead = jsonBytes(values) - 64000;
    const exact = r.fields.map((f, i) => ({ key: f.key,
      value: i === 0 ? "\n".repeat(65536 - (64000 + overhead)) + "x".repeat(4000 - (65536 - (64000 + overhead))) : "x".repeat(4000) }));
    expect(jsonBytes(exact)).toBe(65536);
    expect(validateSettingsValues(r, exact, true)).toHaveLength(16);
    exact[1]!.value = "\n" + exact[1]!.value.slice(1);
    expect(() => validateSettingsValues(r, exact, true)).toThrow("size-limit");
    expect(() => validateSettingsValues(resource(), [{ key: "k0", value: "😀".repeat(1024) }], true)).not.toThrow();
    expect(() => validateSettingsValues(resource(), [{ key: "k0", value: "😀".repeat(1025) }], true)).toThrow();
    expect(() => validateSettingsValues(resource(), [{ key: "k0", value: "\ud800" }], true)).toThrow();
  });
  it("uses type-aware enums and validates defaults/ranges without coercion", () => {
    const e = { key: "choice", label: { en: "Choice" }, type: "enum", default: 1,
      options: [{ value: 1, label: { en: "Number" } }, { value: "1", label: { en: "String" } }] };
    expect(validate({ ...resource(), fields: [e] }).fields).toHaveLength(1);
    expect(() => validate({ ...resource(), fields: [{ ...e, options: [e.options[0], e.options[0]] }] })).toThrow();
    for (const value of [true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => validate({ ...resource(), fields: [{ ...e, default: value }] })).toThrow();
    expect(() => validate({ ...resource(), fields: [{ key: "n", label: { en: "N" }, type: "number", default: 2, minimum: 0, maximum: 1 }] })).toThrow();
    expect(() => validate({ ...resource(), fields: [{ ...field(), default: "a", maxLength: 0 }] })).toThrow();
    for (const schemaVersion of [true, 0, 2147483648, 1.5, NaN])
      expect(() => validate({ ...resource(), schemaVersion })).toThrow();
  });
  it("digest text ignores presentation/order but retains validation semantics", () => {
    const a = resource(2), b = { ...a, title: { en: "Translated" }, fields: [...a.fields].reverse().map(f => ({ ...f, label: { en: "Other" } })) };
    expect(settingsValidationText(a)).toBe(settingsValidationText(b));
    b.fields[0]!.maxBytes = 1;
    expect(settingsValidationText(a)).not.toBe(settingsValidationText(b));
    expect(() => checkSettingsVersion(2, 1, "a", "a")).toThrow("downgrade");
    expect(() => checkSettingsVersion(1, 2, "a", "b")).toThrow("migration-required");
    expect(() => checkSettingsVersion(1, 1, "a", "b")).toThrow("schema-changed-without-version");
    expect(() => checkSettingsVersion(1, 1, "a", "a")).not.toThrow();
  });
  it("loads committed vectors and rejects aliases", () => {
    const load = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/settings-storage-v1/${name}.json`, import.meta.url), "utf8"));
    for (const r of load("valid").cases.filter((c: {schema:string}) => c.schema === "settingsResourceV1").map((c: {input:unknown}) => c.input)) expect(() => validate(r)).not.toThrow();
    for (const r of load("invalid").cases.filter((c: {schema:string}) => c.schema === "settingsResourceV1").map((c: {input:unknown}) => c.input)) expect(() => validate(r)).toThrow();
    expect(Object.keys(settingsRequestSchemas)).toEqual(["settings/read", "settings/update", "settings/reset", "settings/watch", "settings/readMigration", "settings/migrate"]);
    expect("settings/unwatch" in settingsRequestSchemas).toBe(false);
    expect(settingsRequestSchemas["settings/update"].params.safeParse({ schemaVersion: 1, expectedRevision: null, changes: [], retry: true }).success).toBe(false);
  });
});

import { normalizeSettingsValues } from "./settings.js";
const dependent = (): SettingsResourceV1 => ({ schemaVersion: 1, title: { en: "Dependent" }, fields: [
  { key: "remember", label: { en: "Remember" }, type: "boolean" as const, default: true },
  { ...field("address"), resetWhen: { key: "remember", equals: false } },
] });
it("dependent defaults normalize full candidates without mutating inputs; committed inconsistency is rejected", () => {
  const r = validate(dependent());
  const values = [{ key: "remember", value: false }, { key: "address", value: "original" }];
  expect(normalizeSettingsValues(r, values)).toEqual([{ key: "remember", value: false }, { key: "address", value: "" }]);
  expect(values[1]!.value).toBe("original");
  expect(() => validateSettingsValues(r, values, true)).toThrow("invalid-value");
  expect(validateSettingsValues(r, [{ key: "address", value: "original" }], false)).toHaveLength(1);
  expect(() => normalizeSettingsValues(r, [{ key: "remember", value: false }])).toThrow();
  expect(normalizeSettingsValues(r, [{ key: "remember", value: true }, { key: "address", value: "original" }])[1]!.value).toBe("original");
});
it("dependent rules are strict, reference independent booleans, reject self/chains/cycles and invalid defaults", () => {
  for (const resetWhen of [{ key: "missing", equals: false }, { key: "address", equals: false }, { key: "remember", equals: 0 }, { key: "remember", equals: false, extra: true }, null]) {
    const r = dependent(); Object.assign(r.fields[1]!, { resetWhen }); expect(() => validate(r)).toThrow();
  }
  const chain = dependent(); Object.assign(chain.fields[0]!, { resetWhen: { key: "other", equals: false } });
  expect(() => validate({ ...chain, fields: [...chain.fields, { key: "other", label: { en: "Other" }, type: "boolean", default: true }] })).toThrow();
  const cycle = dependent(); Object.assign(cycle.fields[0]!, { resetWhen: { key: "address", equals: true } }); expect(() => validate(cycle)).toThrow();
  const nonBoolean = dependent(); Object.assign(nonBoolean.fields[0]!, { type: "string", default: "", minLength: 0, maxLength: 20, maxBytes: 20 }); expect(() => validate(nonBoolean)).toThrow();
  const invalidDefault = dependent(); Object.assign(invalidDefault.fields[1]!, { default: true }); expect(() => validate(invalidDefault)).toThrow();
});
it("dependent rule changes digest, while absent rules preserve prior digest bytes", () => {
  const r = dependent(), plain = { ...r, fields: [r.fields[0]!, field("address")] };
  expect(settingsValidationText(r)).not.toBe(settingsValidationText(plain));
  expect(settingsValidationText({ ...r, fields: [...r.fields].reverse() })).toBe(settingsValidationText(r));
  const before = settingsValidationText(r); r.fields[1]!.resetWhen!.equals = true;
  expect(settingsValidationText(r)).not.toBe(before);
});
