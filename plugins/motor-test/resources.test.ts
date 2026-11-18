import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UI_LIMITS_V1,
  acceptsValue,
  contextCommandDeclarationSchema,
  deviceDeclarationProblems,
  panelResourceV1Schema,
  pluginManifestSchema,
  statusResourceV1Schema,
  uiBytes,
  uiDeclarationProblems,
  validateUiData,
  validateUiResource,
  type Condition,
  type PanelResourceV1,
  type UiScalar,
  type ValueSpec,
} from "@kobrixa/plugin-protocol";
import { PORTS, initialForm, motionFromForm, presentMotion } from "./src/model.js";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const manifest = pluginManifestSchema.parse(read("kobrixa-plugin.json"));
const panel = panelResourceV1Schema.parse(read("panel.json"));
const status = statusResourceV1Schema.parse(read("status.json"));
const commands = manifest.contributes!.commands!.map((command) =>
  contextCommandDeclarationSchema.parse(command),
);
const context = { pluginId: manifest.id, commands, panels: manifest.contributes!.panels! };
const initialData = (resource: typeof panel | typeof status) =>
  Object.fromEntries(Object.entries(resource.data).map(([key, slot]) => [key, slot.initial]));

// Evaluate declarative conditions over fixtures only; these are resource proofs, not renderer acceptance.
function matches(
  condition: Condition | undefined,
  form: Record<string, UiScalar>,
  data = initialData(panel),
): boolean {
  if (!condition) return true;
  if (condition.op === "all") return condition.items.every((item) => matches(item, form, data));
  if (condition.op === "any") return condition.items.some((item) => matches(item, form, data));
  if (condition.op === "not") return !matches(condition.item, form, data);
  if (!("left" in condition)) throw new Error("Unexpected condition");
  const value = (condition.left.scope === "form" ? form : data)[condition.left.key];
  if (condition.op === "eq") return value === condition.right;
  if (condition.op === "ne") return value !== condition.right;
  throw new Error("Unexpected comparison in motor resources");
}
function visibleFields(form: Record<string, UiScalar>): string[] {
  const fields: string[] = [];
  const visit = (id: string) => {
    const node = panel.nodes.find((node) => node.id === id)!;
    if (!matches(node.visibleWhen, form) || !matches(node.enabledWhen, form)) return;
    if ("field" in node) fields.push(node.field);
    if (node.type === "group") node.children.forEach(visit);
  };
  visit(panel.root);
  return fields;
}
function maximal(schema: ValueSpec): UiScalar {
  switch (schema.type) {
    case "string":
      return "😀".repeat(schema.maxLength);
    case "number":
      return schema.max;
    case "boolean":
      return true;
    case "enum":
      return schema.values.reduce((a, b) => (uiBytes(a) > uiBytes(b) ? a : b));
  }
}
const validatePanel = (value: PanelResourceV1) =>
  validateUiResource(value, context, uiBytes(value));

it("declares only the approved public identity, API, capabilities, permissions and lazy entry", () => {
  expect(manifest).toMatchObject({
    id: "kobrixa.motor-test",
    apiVersion: "^1.6.0",
    runtime: { kind: "node", entry: "main.cjs" },
    activationEvents: ["onPanel:kobrixa.motor-test.panel"],
    requires: { devices: [{ capability: "finiteMotion.v1", required: true }] },
  });
  expect(manifest.permissions).toEqual([
    "devices.read",
    "devices.control",
    "ui.panels",
    "ui.status",
  ]);
  expect(uiDeclarationProblems(manifest)).toEqual([]);
  expect(deviceDeclarationProblems(manifest)).toEqual([]);
  expect(context.panels).toEqual([
    {
      id: "kobrixa.motor-test.panel",
      title: { en: "Motor test", "zh-TW": "馬達測試" },
      location: "right",
      resource: { version: 1, path: "panel.json" },
    },
  ]);
  expect(manifest.contributes!.status).toEqual([
    {
      id: "kobrixa.motor-test.status",
      title: { en: "Motor test status", "zh-TW": "馬達測試狀態" },
      resource: { version: 1, path: "status.json" },
    },
  ]);
  expect(commands.map((command) => command.id)).toEqual(
    ["select-current", "refresh", "start", "jog"].map((id) => `kobrixa.motor-test.${id}`),
  );
});

it("passes actual v1 structural, reference, argument and byte validators", () => {
  for (const [name, resource] of [
    ["panel.json", panel],
    ["status.json", status],
  ] as const) {
    const bytes = readFileSync(new URL(name, import.meta.url)).byteLength;
    expect(validateUiResource(resource, context, bytes)).toEqual({ ok: true, value: resource });
    expect(validateUiData(resource, initialData(resource)).ok).toBe(true);
  }
  expect(status.tone).toBe("neutral");
  expect(status.visibleWhen).toBeUndefined();
  expect(initialData(panel)).toMatchObject({
    available: false,
    "can-start": false,
    operation: null,
  });
  expect(String(panel.data.availability!.initial)).toContain("Unavailable");
});

it("has exactly 25 fields, each with one input and matching four-port defaults", () => {
  expect(Object.keys(panel.fields)).toHaveLength(25);
  expect(
    Object.fromEntries(Object.entries(panel.fields).map(([key, field]) => [key, field.initial])),
  ).toEqual(initialForm());
  const inputs = panel.nodes.flatMap((node) => ("field" in node ? [node.field] : []));
  expect(inputs.sort()).toEqual(Object.keys(panel.fields).sort());
});

for (const port of PORTS) {
  for (const mode of ["jog", "timed", "relative-angle"] as const) {
    it(`${port} ${mode}: only active fields validate; other drafts can be invalid`, () => {
      const prefix = port.toLowerCase();
      const form = { ...initialForm(), port, [`${prefix}-mode`]: mode };
      const expected = [
        "port",
        `${prefix}-mode`,
        `${prefix}-power`,
        `${prefix}-brake`,
        ...(mode === "jog" ? [] : [`${prefix}-direction`]),
        ...(mode === "timed"
          ? [`${prefix}-seconds`]
          : mode === "relative-angle"
            ? [`${prefix}-degrees`]
            : []),
      ];
      expect(visibleFields(form).sort()).toEqual(expected.sort());
      for (const key of Object.keys(form)) if (!expected.includes(key)) form[key] = null;
      for (const key of visibleFields(form)) {
        const field = panel.fields[key]!;
        expect(field.required || matches(field.requiredWhen, form)).toBe(true);
        expect(acceptsValue(field.schema, form[key]!)).toBe(true);
      }
      const actuator = {
        actuatorId: "11111111-1111-4111-8111-111111111111",
        portId: port,
        name: "Motor",
        typeId: "large",
        state: "ready" as const,
      };
      expect(motionFromForm(form, actuator, 1).ok).toBe(true);
      form[`${prefix}-power`] = null;
      const field = panel.fields[`${prefix}-power`]!;
      expect(matches(field.requiredWhen, form)).toBe(true);
      expect(motionFromForm(form, actuator, 1).ok).toBe(false);
    });
  }
}

it("aligns field domains with the model and preserves arbitrary finite seconds before rounding", () => {
  for (const port of PORTS) {
    const prefix = port.toLowerCase();
    expect(panel.fields[`${prefix}-power`]!.schema).toEqual({
      type: "number",
      min: 1,
      max: 100,
      integer: true,
      nullable: true,
    });
    expect(panel.fields[`${prefix}-seconds`]!.schema).toEqual({
      type: "number",
      min: 0.1,
      max: 5,
      integer: false,
      nullable: true,
    });
    expect(panel.fields[`${prefix}-degrees`]!.schema).toEqual({
      type: "number",
      min: 1,
      max: 3600,
      integer: true,
      nullable: true,
    });
    const node = panel.nodes.find((node) => node.id === `${prefix}-seconds`)!;
    if (node.type !== "number") throw new Error("Missing seconds input");
    // UI v1 requires a numeric step. 2^-56 is the smallest IEEE-754 spacing in
    // [0.1, 5], so it adds no decimal quantization before Math.round(ms).
    expect(node.step).toBe(2 ** -56);
    for (const seconds of [0.1, 0.10000000000000002, 0.10049, 0.1005, 1.2345, Math.PI, 5]) {
      const grid = (seconds - 0.1) / node.step;
      expect(Math.abs(grid - Math.round(grid))).toBeLessThanOrEqual(
        1e-9 * Math.max(1, Math.abs(grid)),
      );
      expect(acceptsValue(panel.fields[`${prefix}-seconds`]!.schema, seconds)).toBe(true);
    }
  }
});

it("declares an unconditional existing core Stop outside all conditional port groups", () => {
  const stop = panel.nodes.find((node) => node.id === "stop")!;
  expect(stop).toEqual({
    id: "stop",
    type: "action",
    label: { en: "Stop (brake)", "zh-TW": "停止（煞車）" },
    variant: "danger",
    action: { kind: "core", action: "stop", operation: { scope: "data", key: "operation" } },
  });
  const root = panel.nodes.find((node) => node.id === panel.root)!;
  expect(root.type).toBe("group");
  if (root.type !== "group") return;
  expect(root.children).toContain("stop");
  expect(root.enabledWhen).toBeUndefined();
  expect(root.visibleWhen).toBeUndefined();
  // The resource is unconditional. Generic host invalid-form gating still needs
  // its owning fix; this assertion does not claim runtime Stop acceptance.
});

it("bounds maximal data/form values and raw JSON UTF-8 within v1 budgets", () => {
  expect(panel.nodes.length).toBeLessThanOrEqual(UI_LIMITS_V1.nodes);
  expect(Object.keys(panel.data).length).toBeLessThanOrEqual(UI_LIMITS_V1.dataSlots);
  for (const resource of [panel, status]) {
    const max = Object.fromEntries(
      Object.entries(resource.data).map(([key, slot]) => [key, maximal(slot.schema)]),
    );
    expect(validateUiData(resource, max).ok).toBe(true);
    expect(uiBytes(max)).toBeLessThanOrEqual(
      resource.kind === "panel" ? UI_LIMITS_V1.dataBytes : UI_LIMITS_V1.statusDataBytes,
    );
  }
  const maxForm = Object.fromEntries(
    Object.entries(panel.fields).map(([key, field]) => [key, maximal(field.schema)]),
  );
  expect(uiBytes(maxForm)).toBeLessThanOrEqual(UI_LIMITS_V1.formBytes);
  expect(validateUiResource(panel, context, UI_LIMITS_V1.resourceBytes + 1).ok).toBe(false);
});

it("requires bilingual labels/help and bounded localized presentation data", () => {
  function walk(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if ("en" in value)
      expect(value).toMatchObject({ en: expect.any(String), "zh-TW": expect.any(String) });
    Object.values(value).forEach(walk);
  }
  [manifest, panel, status].forEach(walk);
  const id = "11111111-1111-4111-8111-111111111111";
  for (const locale of ["en", "zh-TW"] as const) {
    const presentation = presentMotion(
      {
        operationId: id,
        sessionId: id,
        revision: 1,
        phase: "unconfirmed",
        stage: "readback",
        startAccepted: true,
        stopRequested: true,
        dispatch: "unknown",
        movement: "unknown",
        stopConfirmation: "unconfirmed",
        brakeRequired: true,
        elapsedMs: 10000,
        angle: null,
        displacement: null,
        preparedRemainingMs: 0,
      },
      { mode: "relative-angle", actuatorId: id, power: 20, direction: 1, brake: true, degrees: 90 },
      locale,
    );
    expect(validateUiData(panel, { ...initialData(panel), ...presentation.data }).ok).toBe(true);
    expect(validateUiData(status, { summary: presentation.data.summary }).ok).toBe(true);
  }
});

describe("actual validators reject resource drift", () => {
  it("rejects missing command refs and mismatched declared arguments", () => {
    expect(validateUiResource(panel, { ...context, commands: [] }, uiBytes(panel)).ok).toBe(false);
    const changed = structuredClone(commands);
    changed.find((command) => command.id.endsWith(".jog"))!.arguments.direction = {
      type: "enum",
      values: ["forward"],
      nullable: false,
    };
    expect(validateUiResource(panel, { ...context, commands: changed }, uiBytes(panel)).ok).toBe(
      false,
    );
  });
  it("rejects invalid data refs, choice-field drift and duplicate field inputs", () => {
    const brokenRef = structuredClone(panel);
    brokenRef.nodes.push({
      id: "bad",
      type: "status",
      text: { ref: { scope: "data", key: "missing" } },
      tone: "neutral",
    });
    const root = brokenRef.nodes.find((node) => node.id === brokenRef.root)!;
    if (root.type === "group") root.children.push("bad");
    expect(validatePanel(brokenRef).ok).toBe(false);
    const wrongChoice = structuredClone(panel);
    const choice = wrongChoice.nodes.find((node) => node.id === "port")!;
    if (choice.type === "choice") choice.options.pop();
    expect(validatePanel(wrongChoice).ok).toBe(false);
    const duplicate = structuredClone(panel);
    const input = duplicate.nodes.find((node) => node.id === "a-power")!;
    duplicate.nodes.push({ ...input, id: "duplicate" });
    const parent = duplicate.nodes.find((node) => node.id === duplicate.root)!;
    if (parent.type === "group") parent.children.push("duplicate");
    expect(validatePanel(duplicate).ok).toBe(false);
  });
});
