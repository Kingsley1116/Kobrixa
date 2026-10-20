import type { Id } from "./ui-types.js";
export type LocalId = string; // ASCII ^[a-z][a-z0-9-]{0,31}$
export type Text = { en: string; "zh-TW"?: string };
export type Scalar = string | number | boolean | null;
export type ValueSpec =
  | { type: "string"; maxLength: number; nullable: boolean }
  | { type: "number"; min: number; max: number; integer: boolean; nullable: boolean }
  | { type: "boolean"; nullable: boolean }
  | { type: "enum"; values: string[]; nullable: boolean };
export type DataSlot = { schema: ValueSpec; initial: Scalar };
export type Field = {
  schema: ValueSpec;
  initial: Scalar;
  required: boolean;
  requiredWhen?: Condition;
};
export type ValueRef = { scope: "data" | "form"; key: LocalId };
export type DisplayValue = { literal: Scalar } | { ref: ValueRef };
export type DisplayText = { text: Text } | { ref: { scope: "data"; key: LocalId } };
export type PanelResourceV1 = {
  kind: "panel";
  data: Record<LocalId, DataSlot>;
  fields: Record<LocalId, Field>;
  root: LocalId;
  nodes: UiNodeV1[];
};
export type StatusResourceV1 = {
  kind: "status";
  text: DisplayText;
  tone: "neutral" | "info" | "success" | "warning" | "error";
  data: Record<LocalId, DataSlot>;
  visibleWhen?: Condition;
};

export type Condition =
  | { op: "eq" | "ne"; left: ValueRef; right: Scalar }
  | { op: "lt" | "lte" | "gt" | "gte"; left: ValueRef; right: number }
  | { op: "all" | "any"; items: Condition[] } // 1–8
  | { op: "not"; item: Condition };
export type ArgumentBindings = Record<LocalId, DisplayValue>;
export type UiAction =
  | { kind: "command"; command: Id; arguments: ArgumentBindings }
  | { kind: "core"; action: "openPanel"; panelId: Id }
  | { kind: "core"; action: "stop"; operation: { scope: "data"; key: LocalId } }
  | { kind: "core"; action: "disconnect"; session: { scope: "data"; key: LocalId } }
  | { kind: "core"; action: "openRecovery" };

export type UiNodeBase = {
  id: LocalId;
  visibleWhen?: Condition;
  enabledWhen?: Condition;
};
export type UiNumberNode = {
  field: LocalId;
  label: Text;
  help?: Text;
  step: number;
  unit?: Text;
};
export type UiNodeV1 = UiNodeBase &
  (
    | { type: "group"; label?: Text; help?: Text; layout: "stack" | "row"; children: LocalId[] }
    | { type: "text"; value: DisplayText; emphasis: "normal" | "strong" }
    | { type: "help"; value: DisplayText }
    | { type: "textInput"; field: LocalId; label: Text; help?: Text; placeholder?: Text }
    | ({ type: "number" } & UiNumberNode)
    | ({ type: "range" } & UiNumberNode)
    | {
        type: "choice";
        field: LocalId;
        label: Text;
        help?: Text;
        presentation: "select" | "segmented";
        options: { value: string; label: Text }[];
      }
    | { type: "boolean"; field: LocalId; label: Text; help?: Text }
    | { type: "action"; label: Text; action: UiAction; variant: "normal" | "primary" | "danger" }
    | { type: "holdAction"; label: Text; command: Id; arguments: ArgumentBindings; help?: Text }
    | {
        type: "status";
        text: DisplayText;
        tone: "neutral" | "info" | "success" | "warning" | "error";
      }
    | { type: "alert"; text: DisplayText; severity: "info" | "warning" | "error" }
    | { type: "progress"; value: DisplayValue; max: number; label: Text }
    | { type: "keyValue"; rows: { id: LocalId; label: Text; value: DisplayValue; unit?: Text }[] }
  );

import { z } from "zod";
import { namespacedIdSchema } from "./common.js";
export const localIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]{0,31}$/);
const stringBody = z.string().min(1).max(8000);
const stringLabel = z.string().min(1).max(400);
export const uiTextSchema = z.strictObject({ en: stringBody, "zh-TW": stringBody.exactOptional() });
export const uiLabelSchema = z.strictObject({
  en: stringLabel,
  "zh-TW": stringLabel.exactOptional(),
});
export const uiScalarSchema = z.union([z.string().max(8000), z.number(), z.boolean(), z.null()]);
export const valueSpecSchema = z.union([
  z.strictObject({
    type: z.literal("string"),
    maxLength: z.number().int().min(1).max(4000),
    nullable: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("number"),
    min: z.number(),
    max: z.number(),
    integer: z.boolean(),
    nullable: z.boolean(),
  }),
  z.strictObject({ type: z.literal("boolean"), nullable: z.boolean() }),
  z.strictObject({
    type: z.literal("enum"),
    values: z.array(z.string().min(1).max(256)).min(1).max(32),
    nullable: z.boolean(),
  }),
]);
export const valueRefSchema = z.strictObject({
  scope: z.enum(["data", "form"]),
  key: localIdSchema,
});
const dataRefSchema = z.strictObject({ scope: z.literal("data"), key: localIdSchema });
export const displayValueSchema = z.union([
  z.strictObject({ literal: uiScalarSchema }),
  z.strictObject({ ref: valueRefSchema }),
]);
export const displayTextSchema = z.union([
  z.strictObject({ text: uiTextSchema }),
  z.strictObject({ ref: dataRefSchema }),
]);
function conditionAt(depth: number): z.ZodType<Condition, Condition> {
  const leaf = z.union([
    z.strictObject({ op: z.enum(["eq", "ne"]), left: valueRefSchema, right: uiScalarSchema }),
    z.strictObject({
      op: z.enum(["lt", "lte", "gt", "gte"]),
      left: valueRefSchema,
      right: z.number(),
    }),
  ]);
  if (depth === 1) return leaf;
  const child = conditionAt(depth - 1);
  return z.union([
    leaf,
    z.strictObject({ op: z.enum(["all", "any"]), items: z.array(child).min(1).max(8) }),
    z.strictObject({ op: z.literal("not"), item: child }),
  ]);
}
export const conditionSchema = conditionAt(4);
export const argumentBindingsSchema = z.record(localIdSchema, displayValueSchema);
export const uiActionSchema = z.union([
  z.strictObject({
    kind: z.literal("command"),
    command: namespacedIdSchema,
    arguments: argumentBindingsSchema,
  }),
  z.strictObject({
    kind: z.literal("core"),
    action: z.literal("openPanel"),
    panelId: namespacedIdSchema,
  }),
  z.strictObject({ kind: z.literal("core"), action: z.literal("stop"), operation: dataRefSchema }),
  z.strictObject({
    kind: z.literal("core"),
    action: z.literal("disconnect"),
    session: dataRefSchema,
  }),
  z.strictObject({ kind: z.literal("core"), action: z.literal("openRecovery") }),
]);
const base = {
  id: localIdSchema,
  visibleWhen: conditionSchema.exactOptional(),
  enabledWhen: conditionSchema.exactOptional(),
};
const input = { field: localIdSchema, label: uiLabelSchema, help: uiTextSchema.exactOptional() };
const numberInput = {
  ...input,
  step: z.number().min(Number.MIN_VALUE),
  unit: uiLabelSchema.exactOptional(),
};
const tone = z.enum(["neutral", "info", "success", "warning", "error"]);
export const uiNodeV1Schema = z.union([
  z.strictObject({
    ...base,
    type: z.literal("group"),
    label: uiLabelSchema.exactOptional(),
    help: uiTextSchema.exactOptional(),
    layout: z.enum(["stack", "row"]),
    children: z.array(localIdSchema).min(1).max(32),
  }),
  z.strictObject({
    ...base,
    type: z.literal("text"),
    value: displayTextSchema,
    emphasis: z.enum(["normal", "strong"]),
  }),
  z.strictObject({ ...base, type: z.literal("help"), value: displayTextSchema }),
  z.strictObject({
    ...base,
    ...input,
    type: z.literal("textInput"),
    placeholder: uiLabelSchema.exactOptional(),
  }),
  z.strictObject({ ...base, ...numberInput, type: z.literal("number") }),
  z.strictObject({ ...base, ...numberInput, type: z.literal("range") }),
  z.strictObject({
    ...base,
    ...input,
    type: z.literal("choice"),
    presentation: z.enum(["select", "segmented"]),
    options: z
      .array(z.strictObject({ value: z.string().min(1).max(256), label: uiLabelSchema }))
      .min(1)
      .max(32),
  }),
  z.strictObject({ ...base, ...input, type: z.literal("boolean") }),
  z.strictObject({
    ...base,
    type: z.literal("action"),
    label: uiLabelSchema,
    action: uiActionSchema,
    variant: z.enum(["normal", "primary", "danger"]),
  }),
  z.strictObject({
    ...base,
    type: z.literal("holdAction"),
    label: uiLabelSchema,
    command: namespacedIdSchema,
    arguments: argumentBindingsSchema,
    help: uiTextSchema.exactOptional(),
  }),
  z.strictObject({ ...base, type: z.literal("status"), text: displayTextSchema, tone }),
  z.strictObject({
    ...base,
    type: z.literal("alert"),
    text: displayTextSchema,
    severity: z.enum(["info", "warning", "error"]),
  }),
  z.strictObject({
    ...base,
    type: z.literal("progress"),
    value: displayValueSchema,
    max: z.number().min(Number.MIN_VALUE),
    label: uiLabelSchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("keyValue"),
    rows: z
      .array(
        z.strictObject({
          id: localIdSchema,
          label: uiLabelSchema,
          value: displayValueSchema,
          unit: uiLabelSchema.exactOptional(),
        }),
      )
      .min(1)
      .max(16),
  }),
]);
const dataSlotSchema = z.strictObject({ schema: valueSpecSchema, initial: uiScalarSchema });
const fieldSchema = z.strictObject({
  schema: valueSpecSchema,
  initial: uiScalarSchema,
  required: z.boolean(),
  requiredWhen: conditionSchema.exactOptional(),
});
export const panelResourceV1Schema = z.strictObject({
  kind: z.literal("panel"),
  data: z.record(localIdSchema, dataSlotSchema),
  fields: z.record(localIdSchema, fieldSchema),
  root: localIdSchema,
  nodes: z.array(uiNodeV1Schema).min(1).max(256),
});
export const statusResourceV1Schema = z.strictObject({
  kind: z.literal("status"),
  text: displayTextSchema,
  tone,
  data: z.record(localIdSchema, dataSlotSchema),
  visibleWhen: conditionSchema.exactOptional(),
});
export const uiResourceV1Schema = z.union([panelResourceV1Schema, statusResourceV1Schema]);
