import { z } from "zod";
import { namespacedIdSchema } from "./common.js";
import { handleSchema } from "./device-types.js";
import {
  localIdSchema,
  uiLabelSchema,
  uiActionSchema,
  argumentBindingsSchema,
  conditionSchema,
  uiNodeV1Schema,
  panelResourceV1Schema,
  statusResourceV1Schema,
  type Condition,
  type Text,
  type ValueRef,
  type ValueSpec,
  type DisplayValue,
} from "./ui-resource.js";
import { datasetDeclarationV2Schema } from "./ui-v2-data.js";
import { UI_LIMITS_V1 as L } from "./ui-limits.js";
import type { Result, UiDetail } from "./ui-types.js";
import {
  uiBytes,
  uiFailure,
  validString,
  validValueSpec,
  acceptsValue,
  validateUiData,
  type UiValidationContext,
} from "./ui-validation.js";

const dataRef = z.strictObject({ scope: z.literal("data"), key: localIdSchema });
export const uiCommandV2Schema = z.strictObject({
  command: namespacedIdSchema,
  arguments: argumentBindingsSchema,
});
export const rowCommandV2Schema = uiCommandV2Schema.extend({
  rowKeyArg: localIdSchema,
  rowVersionArg: localIdSchema,
  datasetRevisionArg: localIdSchema,
});
export const cursorCommandV2Schema = uiCommandV2Schema.extend({
  timeArg: localIdSchema,
  presentationArg: localIdSchema,
  readings: z
    .array(
      z.strictObject({
        dataset: localIdSchema,
        series: localIdSchema,
        rawKey: localIdSchema,
        valueKey: localIdSchema,
      }),
    )
    .min(1)
    .max(8),
});
const recordingStop = z.strictObject({
  kind: z.literal("core"),
  action: z.literal("stopRecording"),
  reservation: dataRef,
});
const dialogAction = z.strictObject({
  kind: z.literal("view"),
  action: z.enum(["openDialog", "closeDialog"]),
  dialogId: localIdSchema,
});
export const uiActionV2Schema = z.union([uiActionSchema, recordingStop, dialogAction]);
const base = {
  id: localIdSchema,
  visibleWhen: conditionSchema.exactOptional(),
  enabledWhen: conditionSchema.exactOptional(),
};
const labeled = { ...base, label: uiLabelSchema };
const rowAction = z.union([
  z.strictObject({ kind: z.literal("command"), command: rowCommandV2Schema }),
  z.strictObject({
    kind: z.literal("view"),
    action: z.literal("openDialog"),
    dialogId: localIdSchema,
  }),
]);
export const uiNodeV2Schema = z.union([
  ...uiNodeV1Schema.options.filter((s) => s.shape.type.value !== "action"),
  z.strictObject({
    ...labeled,
    type: z.literal("action"),
    action: uiActionV2Schema,
    variant: z.enum(["normal", "primary", "danger"]),
  }),
  z.strictObject({
    ...labeled,
    type: z.literal("lineChart"),
    dataset: localIdSchema,
    cursorGroup: localIdSchema,
    timeView: z.enum(["default", "inspect"]),
    onCursor: cursorCommandV2Schema,
  }),
  z.strictObject({
    ...labeled,
    type: z.literal("table"),
    dataset: localIdSchema,
    onSelect: rowCommandV2Schema.exactOptional(),
  }),
  z.strictObject({
    ...labeled,
    type: z.literal("list"),
    dataset: localIdSchema,
    actions: z
      .array(z.strictObject({ id: localIdSchema, label: uiLabelSchema, action: rowAction }))
      .max(3),
  }),
  z.strictObject({
    ...labeled,
    type: z.literal("code"),
    dataset: localIdSchema,
    copy: uiCommandV2Schema,
  }),
  z.strictObject({
    ...labeled,
    type: z.literal("dialog"),
    children: z.array(localIdSchema).min(1).max(32),
    confirm: z
      .strictObject({ label: uiLabelSchema, command: rowCommandV2Schema, dataset: localIdSchema })
      .exactOptional(),
  }),
]);
export const panelResourceV2Schema = panelResourceV1Schema.extend({
  nodes: z.array(uiNodeV2Schema).min(1).max(256),
  datasets: z.record(localIdSchema, datasetDeclarationV2Schema),
  presentationKey: localIdSchema,
});
export const statusResourceV2Schema = statusResourceV1Schema.extend({
  actions: z
    .array(
      z.strictObject({
        id: localIdSchema,
        label: uiLabelSchema,
        action: z.union([
          z.strictObject({
            kind: z.literal("core"),
            action: z.literal("openPanel"),
            panelId: namespacedIdSchema,
          }),
          recordingStop,
        ]),
      }),
    )
    .max(2),
});
export const uiResourceV2Schema = z.union([panelResourceV2Schema, statusResourceV2Schema]);
export type UiNodeV2 = z.infer<typeof uiNodeV2Schema>;
export type PanelResourceV2 = z.infer<typeof panelResourceV2Schema>;
export type StatusResourceV2 = z.infer<typeof statusResourceV2Schema>;
export type UiResourceV2 = PanelResourceV2 | StatusResourceV2;
const own = (v: object, k: string) => Object.hasOwn(v, k);
function keyValid(key: string): boolean {
  return (
    /^[a-z][a-z0-9-]{0,31}$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key)
  );
}
function hasForbiddenKey(value: unknown): boolean {
  // Zod record parsing can omit __proto__. Inspect the original JSON before
  // parsing, including nested records, so an invalid key cannot become valid.
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return false;
}
function compatible(source: ValueSpec, target: ValueSpec): boolean {
  if (source.nullable && !target.nullable) return false;
  if (source.type === "enum" && target.type === "string")
    return source.values.every((value) => [...value].length <= target.maxLength);
  if (source.type !== target.type) return false;
  if (source.type === "string" && target.type === "string")
    return source.maxLength <= target.maxLength;
  if (source.type === "number" && target.type === "number")
    return (
      source.min >= target.min && source.max <= target.max && (!target.integer || source.integer)
    );
  if (source.type === "enum" && target.type === "enum")
    return source.values.every((value) => target.values.includes(value));
  return true;
}
class Invalid extends Error {
  constructor(
    readonly reason: UiDetail["reason"],
    readonly path: string,
  ) {
    super("Invalid UI resource.");
  }
}
export function validateUiResourceV2(
  value: unknown,
  context: UiValidationContext,
  rawBytes: number,
  version: number = 2,
): Result<UiResourceV2> {
  if (version !== 2) return uiFailure("version");
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > L.resourceBytes)
    return uiFailure(
      "limit",
      "$",
      "resourceBytes",
      Number.isSafeInteger(rawBytes) && rawBytes >= 0 ? rawBytes : undefined,
    );
  if (hasForbiddenKey(value)) return uiFailure("schema", "$");
  const parsed = uiResourceV2Schema.safeParse(value);
  if (!parsed.success) {
    // Classify structural failures without relaxing the resource grammar.
    const classify = (item: unknown): "translation" | "limit" | undefined => {
      if (!item || typeof item !== "object") return undefined;
      if (Array.isArray(item)) {
        for (const child of item) {
          const reason = classify(child);
          if (reason) return reason;
        }
        return undefined;
      }
      const record = item as Record<string, unknown>;
      if (Array.isArray(record.nodes) && record.nodes.length > L.nodes) return "limit";
      for (const [key, child] of Object.entries(record)) {
        if (
          ["text", "label", "help", "unit", "placeholder"].includes(key) &&
          child &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          !("ref" in child) &&
          !("text" in child) &&
          !("en" in child)
        )
          return "translation";
        const reason = classify(child);
        if (reason) return reason;
      }
      return undefined;
    };
    return uiFailure(classify(value) ?? "schema", "$");
  }
  const resource = parsed.data;
  try {
    const fail = (reason: UiDetail["reason"], path: string): never => {
      throw new Invalid(reason, path);
    };
    const text = (v: Text, label: boolean, path: string) => {
      for (const s of Object.values(v)) {
        if ([...s].length > (label ? 200 : 4000)) fail("limit", path);
        if (!validString(s, label ? 200 : 4000, !label, true)) fail("translation", path);
      }
    };
    const fields = resource.kind === "panel" ? resource.fields : {};
    if (Object.keys(resource.data).length > 64 || Object.keys(fields).length > 32)
      fail("limit", "$");
    for (const [kind, record] of [
      ["data", resource.data],
      ["fields", fields],
    ] as const) {
      for (const [key, slot] of Object.entries(record)) {
        if (
          !keyValid(key) ||
          !validValueSpec(slot.schema) ||
          !acceptsValue(slot.schema, slot.initial)
        )
          fail("schema", `$.${kind}.${key}`);
      }
    }
    const ref = (r: ValueRef): ValueSpec => {
      const record = r.scope === "data" ? resource.data : fields;
      if (!own(record, r.key)) return fail("reference", "$.ref");
      return record[r.key]!.schema;
    };
    const reservation = (r: z.infer<typeof dataRef>, path: string) => {
      const schema = ref(r);
      if (schema.type !== "string" || !schema.nullable || schema.maxLength !== 36)
        fail("reference", path);
      const initial = resource.data[r.key]!.initial;
      if (initial !== null && !handleSchema.safeParse(initial).success) fail("reference", path);
    };
    let totalConditions = 0;
    const condition = (c: Condition) => {
      let size = 0;
      const walk = (v: Condition, depth: number): void => {
        if (++size > 32 || ++totalConditions > 256 || depth > 4) fail("limit", "$.condition");
        if (v.op === "not") return walk(v.item, depth + 1);
        if (v.op === "all" || v.op === "any") {
          v.items.forEach((item) => walk(item, depth + 1));
          return;
        }
        if (!("left" in v)) return;
        const s = ref(v.left);
        if (v.op === "eq" || v.op === "ne") {
          const expected = s.type === "enum" ? "string" : s.type;
          const compatible =
            v.right === null
              ? s.nullable
              : typeof v.right === expected &&
                (typeof v.right !== "string" || validString(v.right, 4000));
          if (!compatible) fail("reference", "$.condition.right");
        } else if (s.type !== "number") fail("reference", "$.condition.left");
      };
      walk(c, 1);
    };
    const display = (d: DisplayValue) => {
      if ("ref" in d) ref(d.ref);
    };
    const displayText = (d: { text: Text } | { ref: { scope: "data"; key: string } }) => {
      if ("text" in d) text(d.text, false, "$.text");
      else if (ref(d.ref).type !== "string") fail("reference", "$.text.ref");
    };
    const command = (id: string, bindings: Record<string, DisplayValue>) => {
      const target = context.commands.find((c) => c.id === id);
      if (!id.startsWith(`${context.pluginId}.`) || !target) return fail("reference", "$.command");
      const keys = Object.keys(bindings);
      if (
        keys.length > 32 ||
        keys.length !== Object.keys(target.arguments).length ||
        uiBytes(bindings) > L.argumentBytes
      )
        fail("limit", "$.arguments");
      for (const key of keys) {
        if (!keyValid(key) || !own(target.arguments, key)) fail("reference", "$.arguments");
        const binding = bindings[key]!;
        const expected = target.arguments[key]!;
        if (
          "literal" in binding
            ? !acceptsValue(expected, binding.literal)
            : !compatible(ref(binding.ref), expected)
        )
          fail("reference", "$.arguments");
      }
    };
    if (resource.kind === "status") {
      displayText(resource.text);
      if (resource.visibleWhen) condition(resource.visibleWhen);
      if (new Set(resource.actions.map((a) => a.id)).size !== resource.actions.length)
        fail("reference", "$.actions");
      for (const entry of resource.actions) {
        text(entry.label, true, "$.actions.label");
        const action = entry.action;
        if (action.action === "stopRecording") {
          reservation(action.reservation, "$.actions.reservation");
        } else if (
          !action.panelId.startsWith(`${context.pluginId}.`) ||
          !context.panels.some((p) => p.id === action.panelId)
        )
          fail("reference", "$.actions.panelId");
      }
    } else {
      const nodes = new Map(resource.nodes.map((n) => [n.id, n]));
      if (nodes.size !== resource.nodes.length || nodes.get(resource.root)?.type !== "group")
        fail("reference", "$.nodes");
      const seen = new Set<string>();
      const dialogOf = new Map<string, string>();
      const walk = (id: string, depth: number, dialog?: string) => {
        if (depth > 8) fail("limit", "$.nodes");
        if (seen.has(id)) fail("cycle", "$.nodes");
        const n = nodes.get(id);
        if (!n) return fail("reference", "$.children");
        seen.add(id);
        if (dialog) dialogOf.set(id, dialog);
        if (n.type === "dialog") {
          if (dialog !== n.id) fail("reference", "$.dialog.nested");
          n.children.forEach((child) => walk(child, depth + 1, n.id));
        } else if (n.type === "group")
          n.children.forEach((child) => walk(child, depth + 1, dialog));
      };
      walk(resource.root, 1);
      for (const node of resource.nodes) if (node.type === "dialog") walk(node.id, 1, node.id);
      if (seen.size !== nodes.size) fail("reference", "$.nodes");
      const used = new Set<string>();
      for (const n of resource.nodes) {
        if (!keyValid(n.id)) fail("schema", "$.nodes.id");
        if (n.visibleWhen) condition(n.visibleWhen);
        if (n.enabledWhen) condition(n.enabledWhen);
        if ("label" in n && n.label) text(n.label, true, "$.nodes.label");
        if ("help" in n && n.help) text(n.help, false, "$.nodes.help");
        if ("unit" in n && n.unit) text(n.unit, true, "$.nodes.unit");
        if (n.type === "textInput" && n.placeholder)
          text(n.placeholder, true, "$.nodes.placeholder");
        if ("field" in n) {
          if (!own(fields, n.field) || used.has(n.field)) fail("reference", "$.nodes.field");
          used.add(n.field);
          const f = fields[n.field]!;
          const s = f.schema;
          const type =
            n.type === "textInput"
              ? "string"
              : n.type === "choice"
                ? "enum"
                : n.type === "boolean"
                  ? "boolean"
                  : "number";
          if (s.type !== type) fail("reference", "$.nodes.field");
          if (
            n.type === "textInput" &&
            typeof f.initial === "string" &&
            !validString(f.initial, 4000, false)
          )
            fail("schema", "$.fields.initial");
          if ((n.type === "number" || n.type === "range") && s.type === "number") {
            if (s.integer && !Number.isSafeInteger(n.step)) fail("schema", "$.nodes.step");
            if (n.type === "range" && typeof f.initial === "number") {
              const q = (f.initial - s.min) / n.step;
              if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q)))
                fail("schema", "$.fields.initial");
            }
          }
          if (n.type === "choice" && s.type === "enum") {
            const options = n.options.map((o) => o.value);
            if (
              new Set(options).size !== options.length ||
              options.length !== s.values.length ||
              options.some((v) => !s.values.includes(v)) ||
              (n.presentation === "segmented" && options.length > 8)
            )
              fail("reference", "$.nodes.options");
            n.options.forEach((o) => text(o.label, true, "$.nodes.options.label"));
          }
        }
        if (n.type === "text" || n.type === "help") displayText(n.value);
        if (n.type === "status" || n.type === "alert") displayText(n.text);
        if (n.type === "progress") {
          display(n.value);
          if ("ref" in n.value) {
            if (ref(n.value.ref).type !== "number") fail("reference", "$.nodes.value");
            const values = n.value.ref.scope === "data" ? resource.data : fields;
            const initial = values[n.value.ref.key]!.initial;
            if (initial !== null && (typeof initial !== "number" || initial < 0 || initial > n.max))
              fail("reference", "$.nodes.value");
          }
          if (
            "literal" in n.value &&
            n.value.literal !== null &&
            (typeof n.value.literal !== "number" || n.value.literal < 0 || n.value.literal > n.max)
          )
            fail("schema", "$.nodes.value");
        }
        if (n.type === "keyValue") {
          if (new Set(n.rows.map((r) => r.id)).size !== n.rows.length)
            fail("schema", "$.nodes.rows");
          n.rows.forEach((r) => {
            if (!keyValid(r.id)) fail("schema", "$.nodes.rows.id");
            text(r.label, true, "$.nodes.rows.label");
            if (r.unit) text(r.unit, true, "$.nodes.rows.unit");
            display(r.value);
          });
        }
        if (n.type === "holdAction") command(n.command, n.arguments);
        if (n.type === "action") {
          const a = n.action;
          if (a.kind === "command") command(a.command, a.arguments);
          else if (a.kind === "core" && a.action === "openPanel") {
            if (
              !a.panelId.startsWith(`${context.pluginId}.`) ||
              !context.panels.some((p) => p.id === a.panelId)
            )
              fail("reference", "$.action.panelId");
          } else if (a.kind === "core" && (a.action === "stop" || a.action === "disconnect")) {
            const s = ref(a.action === "stop" ? a.operation : a.session);
            if (s.type !== "string" || !s.nullable) fail("reference", "$.action.ref");
          }
        }
      }
      validatePanelExtensions(resource, context, dialogOf, command, reservation, fail);
      if (used.size !== Object.keys(fields).length) fail("reference", "$.fields");
      for (const field of Object.values(fields))
        if (field.requiredWhen) condition(field.requiredWhen);
      if (
        uiBytes(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.initial]))) >
        L.formBytes
      )
        fail("limit", "$.fields");
    }
    const initial = Object.fromEntries(
      Object.entries(resource.data).map(([key, slot]) => [key, slot.initial]),
    );
    const checked = validateUiData(
      // Project only the v1 data-validation inputs, preserving the resource budget
      // and progress bounds without passing v2-only nodes/actions to the v1 parser.
      resource.kind === "panel"
        ? {
            kind: "panel",
            root: resource.root,
            fields: resource.fields,
            data: resource.data,
            nodes: resource.nodes.filter((node) => node.type === "progress"),
          }
        : {
            kind: "status",
            text: resource.text,
            tone: resource.tone,
            data: resource.data,
          },
      initial,
    );
    if (!checked.ok) return checked;
    return { ok: true, value: resource };
  } catch (error) {
    if (error instanceof Invalid) return uiFailure(error.reason, error.path);
    throw error;
  }
}

type CommandV2 = z.infer<typeof uiCommandV2Schema>;
type RowCommandV2 = z.infer<typeof rowCommandV2Schema>;
function validatePanelExtensions(
  resource: PanelResourceV2,
  context: UiValidationContext,
  dialogOf: Map<string, string>,
  command: (id: string, args: Record<string, DisplayValue>) => void,
  reservation: (r: z.infer<typeof dataRef>, path: string) => void,
  fail: (reason: UiDetail["reason"], path: string) => never,
) {
  const declarations = Object.entries(resource.datasets);
  if (
    declarations.length > 8 ||
    declarations.filter(([, d]) => d.kind === "chart").length > 4 ||
    declarations.filter(([, d]) => d.kind === "code").length > 1
  )
    fail("limit", "$.datasets");
  const presentation = resource.data[resource.presentationKey];
  if (
    !presentation ||
    presentation.schema.type !== "number" ||
    presentation.schema.nullable ||
    !presentation.schema.integer ||
    presentation.schema.min !== 0 ||
    presentation.schema.max !== Number.MAX_SAFE_INTEGER ||
    presentation.initial !== 0
  )
    fail("reference", "$.presentationKey");
  for (const [, d] of declarations) {
    if (d.kind === "code") continue;
    const items = d.kind === "chart" ? d.series : d.columns;
    if (
      items.some((item) => !keyValid(item.id)) ||
      new Set(items.map((i) => i.id)).size !== items.length
    )
      fail("reference", "$.datasets.keys");
    for (const item of items)
      for (const label of Object.values(item.label))
        if (!validString(label, 200, false, true)) fail("translation", "$.datasets.label");
  }
  const nodes = new Map(resource.nodes.map((n) => [n.id, n]));
  const referencedDialogs = new Set<string>();
  const checkDataset = (id: string, kind: string) => {
    const d = resource.datasets[id];
    if (!d || d.kind !== kind) fail("reference", "$.dataset");
    return d!;
  };
  const eventCommand = (c: CommandV2, events: Record<string, ValueSpec>) => {
    const target = context.commands.find((t) => t.id === c.command);
    if (!target || !c.command.startsWith(`${context.pluginId}.`)) fail("reference", "$.command");
    for (const [key, type] of Object.entries(events)) {
      if (
        own(c.arguments, key) ||
        !target!.arguments[key] ||
        !compatible(type, target!.arguments[key]!)
      )
        fail("reference", "$.event.arguments");
    }
    // Reuse all v1 static argument checks against only the static declaration.
    const staticKeys = Object.keys(target!.arguments).filter((k) => !own(events, k));
    if (
      staticKeys.length !== Object.keys(c.arguments).length ||
      staticKeys.some((k) => !own(c.arguments, k))
    )
      fail("reference", "$.arguments");
    const full = { ...c.arguments };
    for (const [key, type] of Object.entries(events))
      full[key] = { literal: type.type === "string" ? "" : type.type === "number" ? 0 : null };
    command(c.command, full);
  };
  const counter: ValueSpec = {
    type: "number",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
    nullable: false,
  };
  const rowCommand = (c: RowCommandV2) => {
    const keys = [c.rowKeyArg, c.rowVersionArg, c.datasetRevisionArg];
    if (new Set(keys).size !== 3) fail("reference", "$.row.arguments");
    eventCommand(c, {
      [c.rowKeyArg]: { type: "string", maxLength: 128, nullable: false },
      [c.rowVersionArg]: { type: "string", maxLength: 128, nullable: true },
      [c.datasetRevisionArg]: counter,
    });
  };
  const openDialog = (source: UiNodeV2, id: string, dataset?: string) => {
    const dialog = nodes.get(id);
    if (dialog?.type !== "dialog" || dialogOf.has(source.id)) fail("reference", "$.dialog.open");
    if (dialog.confirm && (!dataset || dialog.confirm.dataset !== dataset))
      fail("reference", "$.dialog.confirm");
    referencedDialogs.add(id);
  };
  const charts = resource.nodes.filter((n) => n.type === "lineChart");
  if (new Set(charts.map((n) => n.cursorGroup)).size > 1) fail("reference", "$.cursorGroup");
  const expectedReadings = new Set<string>();
  for (const chart of charts) {
    const d = checkDataset(chart.dataset, "chart");
    if (d.kind === "chart")
      for (const series of d.series) expectedReadings.add(`${chart.dataset}/${series.id}`);
  }
  let sharedCursor: string | undefined;
  for (const node of resource.nodes) {
    if (node.type === "action") {
      const a = node.action;
      if (a.kind === "core" && a.action === "stopRecording") {
        reservation(a.reservation, "$.reservation");
      } else if (a.kind === "view") {
        if (a.action === "openDialog") openDialog(node, a.dialogId);
        else if (dialogOf.get(node.id) !== a.dialogId) fail("reference", "$.dialog.close");
      }
    } else if (node.type === "lineChart") {
      if (node.timeView === "inspect" && !dialogOf.has(node.id))
        fail("reference", "$.chart.inspect");
      const c = node.onCursor;
      if (c.timeArg === c.presentationArg) fail("reference", "$.cursor.arguments");
      eventCommand(c, {
        [c.timeArg]: {
          type: "number",
          min: 0,
          max: Number.MAX_VALUE,
          integer: false,
          nullable: false,
        },
        [c.presentationArg]: counter,
      });
      const readings = c.readings.map((r) => `${r.dataset}/${r.series}`);
      if (
        readings.length !== expectedReadings.size ||
        new Set(readings).size !== readings.length ||
        readings.some((r) => !expectedReadings.has(r))
      )
        fail("reference", "$.cursor.readings");
      const outputs = c.readings.flatMap((r) => [r.rawKey, r.valueKey]);
      if (outputs.some((key) => !keyValid(key)) || new Set(outputs).size !== outputs.length)
        fail("reference", "$.cursor.outputs");
      const identity = JSON.stringify(c);
      if (sharedCursor !== undefined && sharedCursor !== identity)
        fail("reference", "$.cursor.shared");
      sharedCursor = identity;
    } else if (node.type === "table") {
      checkDataset(node.dataset, "table");
      if (node.onSelect) rowCommand(node.onSelect);
    } else if (node.type === "list") {
      checkDataset(node.dataset, "list");
      if (new Set(node.actions.map((a) => a.id)).size !== node.actions.length)
        fail("reference", "$.list.actions");
      for (const a of node.actions) {
        for (const label of Object.values(a.label))
          if (!validString(label, 200, false, true)) fail("translation", "$.list.label");
        if (a.action.kind === "command") rowCommand(a.action.command);
        else openDialog(node, a.action.dialogId, node.dataset);
      }
    } else if (node.type === "code") {
      checkDataset(node.dataset, "code");
      command(node.copy.command, node.copy.arguments);
    } else if (node.type === "dialog" && node.confirm) {
      const d = resource.datasets[node.confirm.dataset];
      if (d?.kind !== "table" && d?.kind !== "list") fail("reference", "$.dialog.dataset");
      for (const label of Object.values(node.confirm.label))
        if (!validString(label, 200, false, true)) fail("translation", "$.dialog.label");
      rowCommand(node.confirm.command);
    }
  }
  for (const node of resource.nodes)
    if (node.type === "dialog" && !referencedDialogs.has(node.id))
      fail("reference", "$.dialog.unreachable");
}
