import { describe, expect, it } from "vitest";
import {
  validateUiResource,
  validateUiData,
  evaluateCondition,
  acceptsValue,
} from "./ui-validation.js";
import type { PanelResourceV1, Condition, ValueSpec } from "./ui-resource.js";
const context = { pluginId: "test.ui", panels: [], commands: [] };
const make = (): PanelResourceV1 => ({
  kind: "panel",
  root: "root",
  data: {
    progress: {
      schema: { type: "number", min: 0, max: 100, integer: false, nullable: true },
      initial: 0,
    },
  },
  fields: {
    count: {
      schema: { type: "number", min: 0, max: 10, integer: true, nullable: true },
      initial: null,
      required: true,
    },
  },
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["count", "progress"] },
    { id: "count", type: "range", field: "count", label: { en: "Count" }, step: 1 },
    {
      id: "progress",
      type: "progress",
      value: { ref: { scope: "data", key: "progress" } },
      max: 50,
      label: { en: "Done" },
    },
  ],
});
const check = (value: unknown, bytes = 1000) => validateUiResource(value, context, bytes);
describe("U01/U02/U03/U05 semantic pass", () => {
  it("checks raw bytes independently of parsed content", () => {
    expect(check(make(), 262144).ok).toBe(true);
    expect(check(make(), 262145)).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_E_UI_RESOURCE", detail: { reason: "limit" } },
    });
  });
  it("counts Unicode code points and rejects lone surrogates", () => {
    const p = make();
    p.nodes[1] = { ...p.nodes[1]!, label: { en: "😀".repeat(200) } } as (typeof p.nodes)[number];
    expect(check(p).ok).toBe(true);
    p.nodes[1] = { ...p.nodes[1]!, label: { en: "😀".repeat(201) } } as (typeof p.nodes)[number];
    expect(check(p).ok).toBe(false);
    p.nodes[1] = { ...p.nodes[1]!, label: { en: "\ud800" } } as (typeof p.nodes)[number];
    expect(check(p).ok).toBe(false);
  });
  it("checks every branch and exact field-to-input mapping", () => {
    const p = make();
    p.nodes[0]!.visibleWhen = {
      op: "any",
      items: [
        { op: "eq", left: { scope: "data", key: "progress" }, right: 0 },
        { op: "eq", left: { scope: "data", key: "missing" }, right: 0 },
      ],
    };
    expect(check(p).ok).toBe(false);
    const q = make();
    q.fields.unused = q.fields.count!;
    expect(check(q).ok).toBe(false);
    const r = make();
    r.fields.count!.schema = { type: "boolean", nullable: true };
    expect(check(r).ok).toBe(false);
  });
  it("rejects progress overflow atomically and does not mutate either input", () => {
    const p = make();
    const data = { progress: 51 };
    expect(validateUiData(p, data).ok).toBe(false);
    expect(data).toEqual({ progress: 51 });
    expect(p.data.progress!.initial).toBe(0);
    expect(validateUiData(p, { progress: null }).ok).toBe(true);
  });
  it("uses strict scalar equality and false numerical comparisons for invalid draft", () => {
    const condition: Condition = { op: "eq", left: { scope: "form", key: "count" }, right: 0 };
    expect(evaluateCondition(condition, {}, { count: false })).toBe(false);
    expect(evaluateCondition({ ...condition, op: "lt", right: 5 }, {}, { count: null })).toBe(
      false,
    );
    expect(
      acceptsValue({ type: "number", min: 0, max: 10, integer: true, nullable: false }, false),
    ).toBe(false);
  });
  it("rejects fractional integer bounds, enum duplicates and unsafe integers", () => {
    for (const schema of [
      { type: "number", min: 0.1, max: 2, integer: true, nullable: true },
      { type: "enum", values: ["a", "a"], nullable: true },
      { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER + 1, integer: true, nullable: true },
    ]) {
      const p = make();
      p.fields.count!.schema = schema as ValueSpec;
      expect(check(p).ok).toBe(false);
    }
  });
});

import { readFileSync } from "node:fs";
import type { UiValidationContext } from "./ui-validation.js";
it("U01/U02/U03 executes the shared materialized corpus", () => {
  for (const file of ["valid", "invalid", "maximum"]) {
    const document = JSON.parse(
      readFileSync(
        new URL(`../test-fixtures/declarative-ui-v1/${file}.json`, import.meta.url),
        "utf8",
      ),
    );
    expect(Object.keys(document).sort()).toEqual(["cases", "family", "formatVersion"]);
    expect(document.formatVersion).toBe(1);
    expect(document.family).toBe("declarative-ui-v1");
    const cases = document.cases;

    for (const record of cases) {
      expect(record.schema).toBe("ui-resource-case");
      expect(record.phase).toBe("resource");
      const fixture = record.input;
      expect(new TextEncoder().encode(fixture.raw).length).toBe(fixture.rawBytes);
      expect(JSON.parse(fixture.raw)).toEqual(fixture.resource);
      const context: UiValidationContext = {
        pluginId: "acme.ui",
        commands: fixture.commands,
        panels: fixture.panels.map((id: string) => ({
          id,
          title: { en: "Panel" },
          location: "right",
          resource: { version: 1, path: "panel.json" },
        })),
      };
      const result = validateUiResource(
        fixture.resource,
        context,
        fixture.rawBytes,
        fixture.version,
      );
      if (!record.valid && !result.ok) {
        expect(result.error.code, record.id).toBe(record.expected.businessCode);
        expect(result.error.detail?.reason, record.id).toBe(record.expected.reason);
      }
      const accepted = result.ok;
      expect(accepted, record.id).toBe(record.valid);
    }
  }
});
