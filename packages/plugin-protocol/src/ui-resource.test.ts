import { describe, expect, it } from "vitest";
import { uiResourceV1Schema, conditionSchema, valueSpecSchema } from "./ui-resource.js";
import { validateUiResource } from "./ui-validation.js";

const context = { pluginId: "test.ui", commands: [], panels: [] };
const panel = () => ({
  kind: "panel",
  data: {},
  fields: {},
  root: "root",
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["body"] },
    { id: "body", type: "text", value: { text: { en: "<b>plain text</b>" } }, emphasis: "normal" },
  ],
});
const validate = (value: unknown) =>
  validateUiResource(value, context, new TextEncoder().encode(JSON.stringify(value)).length);

describe("U01/U02 strict UI resources", () => {
  it("accepts HTML-looking text as uninterpreted text", () => {
    expect(validate(panel()).ok).toBe(true);
  });
  it.each(["style", "className", "onClick", "version"])("rejects unknown %s", (key) => {
    expect(validate({ ...panel(), [key]: "x" }).ok).toBe(false);
  });
  it("rejects missing en, extra locale, and unknown component", () => {
    const value = panel();
    expect(
      validate({
        ...value,
        nodes: [value.nodes[0], { ...value.nodes[1], value: { text: { "zh-TW": "標籤" } } }],
      }).ok,
    ).toBe(false);
    expect(
      validate({
        ...value,
        nodes: [value.nodes[0], { ...value.nodes[1], value: { text: { en: "ok", fr: "non" } } }],
      }).ok,
    ).toBe(false);
    expect(
      validate({ ...value, nodes: [value.nodes[0], { ...value.nodes[1], type: "iframe" }] }).ok,
    ).toBe(false);
  });
  it("rejects cycles, duplicate IDs, shared children and orphans", () => {
    for (const nodes of [
      [{ id: "root", type: "group", layout: "stack", children: ["root"] }],
      [...panel().nodes, panel().nodes[1]],
      [{ ...panel().nodes[0], children: ["body", "body"] }, panel().nodes[1]],
      [...panel().nodes, { ...panel().nodes[1], id: "orphan" }],
    ])
      expect(validate({ ...panel(), nodes }).ok).toBe(false);
  });
  it("forbids prototype keys and form references in status", () => {
    const value = JSON.parse(
      '{"kind":"panel","data":{"__proto__":{"schema":{"type":"boolean","nullable":false},"initial":true}},"fields":{},"root":"root","nodes":[]}',
    );
    expect(validate(value).ok).toBe(false);
    expect(
      uiResourceV1Schema.safeParse({
        kind: "status",
        data: {},
        tone: "neutral",
        text: { ref: { scope: "form", key: "field" } },
      }).success,
    ).toBe(false);
    expect(
      uiResourceV1Schema.safeParse({
        kind: "status",
        data: {},
        tone: "neutral",
        text: { text: { en: "Ready" } },
        action: { kind: "core", action: "openRecovery" },
      }).success,
    ).toBe(false);
  });
  it("unfolds conditions finitely, rejects regex and depth five", () => {
    let condition: unknown = { op: "eq", left: { scope: "data", key: "flag" }, right: true };
    for (let n = 0; n < 3; n++) condition = { op: "not", item: condition };
    expect(conditionSchema.safeParse(condition).success).toBe(true);
    expect(conditionSchema.safeParse({ op: "not", item: condition }).success).toBe(false);
    expect(
      conditionSchema.safeParse({ op: "regex", left: { scope: "data", key: "flag" }, right: "x" })
        .success,
    ).toBe(false);
  });
  it("has no coercion or defaults", () => {
    expect(valueSpecSchema.safeParse({ type: "boolean" }).success).toBe(false);
    expect(
      valueSpecSchema.safeParse({
        type: "number",
        min: 0,
        max: 1,
        integer: false,
        nullable: "false",
      }).success,
    ).toBe(false);
  });
});
