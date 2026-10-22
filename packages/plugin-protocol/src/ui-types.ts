import type { Handle, Counter } from "./device-types.js";
import type {
  BusinessResult,
  PermissionErrorDetail,
  ResourceErrorDetailFor,
  ResourceKindV160,
} from "./business-result.js";
import type { PluginErrorCodeV160 } from "./errors.js";
import type { EventEnvelope } from "./events.js";
import type { Text, LocalId, Scalar, ValueSpec } from "./ui-resource.js";
import { UI_LIMITS_V1 } from "./ui-limits.js";
export type Id = string;
export type UiResourceDeclaration = {
  version: number; // header 為 integer 1–65,535；本批次只支援 1
  path: string;
};
export type PanelDeclaration = {
  id: Id;
  title: Text;
  location: "right";
  resource: UiResourceDeclaration;
};
export type StatusDeclaration = {
  id: Id;
  title: Text;
  resource: UiResourceDeclaration;
};
export type ContextCommandDeclaration = {
  id: Id;
  title: Text;
  invocation: "context-v1";
  arguments: Record<LocalId, ValueSpec>; // 最多 32；所有 declared keys 必填
};
// contributes.panels?: PanelDeclaration[]，最多 4。
// contributes.status?: StatusDeclaration[]，最多 2。
// contributes.commands 保留舊 {id,title}；有 invocation 時須完整符合上型別。

// 新增 host-owned DTO；不是 feature 可寫入的 registration request。
export type UiOwner = {
  sourceKey: string;
  pluginId: Id;
  uiResourceGeneration: Counter;
};
export type UiCatalogEntry = UiOwner & {
  id: Id;
  kind: "panel" | "status";
  title: Text;
  version: 1;
  resourceDigest: string; // SHA-256，64 lower-case hex
  resourceBytes: number;
  availability: "available" | "unavailable";
  problem?: { code: string; message: string }; // 使用正式共用 error enum
};
export type UiCatalogPage = {
  hostEpoch: Handle;
  revision: Counter;
  entries: UiCatalogEntry[];
  nextCursor: Handle | null;
};
export type UiBinding = {
  contributionId: Id;
  panelInstance: Handle; // status 亦為 host-issued instance，kind 區分用途
  kind: "panel" | "status";
  uiResourceGeneration: Counter;
  generation: Counter;
  hostEpoch: Handle;
  processEpoch: Handle;
};
export type UiStateSnapshot = {
  binding: UiBinding;
  revision: Counter;
  data: Record<LocalId, Scalar>;
  formRevision: Counter;
  form: Record<LocalId, Scalar>;
  valid: boolean;
  visible: boolean;
  locale: "en" | "zh-TW";
};

// 新增；所有 context 欄位由 host 建立。
export type CommandInvocation = {
  version: 1;
  invocationId: Handle;
  command: Id;
  arguments: Record<LocalId, Scalar>;
  context: {
    contextRef: Handle | null; // 3A Handle；null 表示未綁 workbench，不是自行宣稱 role／holder
    origin: "panel" | "management";
    locale: "en" | "zh-TW";
    binding?: UiBinding;
    motionScopeRef?: Handle; // 3A DeviceIntentPort 發的 Handle，僅 panel context
    actionRef?: Handle; // host 真實使用者動作；§11.4 的 persistence action port
    form?: { revision: Counter; values: Record<LocalId, Scalar> };
    trigger:
      | { kind: "activate" }
      | { kind: "hold"; phase: "begin" | "end" | "cancel"; gestureRef: Handle };
  };
};
export type CommandValue = {
  output: Record<LocalId, Scalar>; // ≤32 keys；非任意 deep JSON
  fieldErrors: { field: LocalId; message: Text }[]; // ≤32
};
// command/invoke result = Result<CommandValue>

// API 1.6.0 註冊的 UI kinds；EventEnvelope 直接匯入 3A 正式型別。
export type UiEvent =
  | { kind: "ui.instances"; data: { instances: UiBinding[] } }
  | { kind: "ui.visibility"; data: { binding: UiBinding; visible: boolean } }
  | { kind: "ui.environment"; data: { locale: "en" | "zh-TW"; theme: "light" | "dark" } }
  | {
      kind: "ui.form";
      data: { binding: UiBinding; revision: Counter; values: Record<LocalId, Scalar> };
    }
  | { kind: "ui.state"; data: { binding: UiBinding; revision: Counter } }
  | { kind: "ui.revoked"; data: { binding: UiBinding; reason: UiRevokeReason } };
export type UiEventEnvelope = Omit<EventEnvelope<UiEvent["data"]>, "kind" | "data"> & UiEvent;

export type UiRevokeReason =
  | "release"
  | "pointer-cancel"
  | "focus-loss"
  | "hidden"
  | "closed"
  | "form-change"
  | "action-disabled"
  | "heartbeat-expired"
  | "authority-lost"
  | "generation-retired"
  | "resource-replaced"
  | "renderer-gone"
  | "process-gone"
  | "provider-gone"
  | "safe-mode"
  | "shutdown"
  | "overflow";
export type UiDetail = {
  kind: "ui";
  reason:
    | "read"
    | "path"
    | "schema"
    | "reference"
    | "cycle"
    | "translation"
    | "limit"
    | "renderer"
    | "version"
    | "negotiation";
  contributionId?: Id;
  fieldPath?: string;
  limit?: keyof typeof UI_LIMITS_V1;
  allowed?: Counter;
  actual?: Counter;
};
export type Result<T> = BusinessResult<
  T,
  UiDetail | PermissionErrorDetail | ResourceErrorDetailFor<ResourceKindV160>,
  PluginErrorCodeV160
>;
export type UiSubscriptionSnapshot = {
  instances: UiBinding[];
  states: UiStateSnapshot[];
  locale: "en" | "zh-TW";
  theme: "light" | "dark";
};

import { z } from "zod";
import { namespacedIdSchema, pluginLocaleSchema } from "./common.js";
import { commonFailureSchema } from "./business-result.js";
import { handleSchema, counterSchema } from "./device-types.js";
import {
  localIdSchema,
  uiTextSchema,
  uiLabelSchema,
  uiScalarSchema,
  valueSpecSchema,
} from "./ui-resource.js";
export const uiResourceDeclarationSchema = z.strictObject({
  version: z.number().int().min(1).max(65535),
  path: z.string().min(1).max(600),
});
export const panelDeclarationSchema = z.strictObject({
  id: namespacedIdSchema,
  title: uiLabelSchema,
  location: z.literal("right"),
  resource: uiResourceDeclarationSchema,
});
export const statusDeclarationSchema = z.strictObject({
  id: namespacedIdSchema,
  title: uiLabelSchema,
  resource: uiResourceDeclarationSchema,
});
export const contextCommandDeclarationSchema = z.strictObject({
  id: namespacedIdSchema,
  title: uiLabelSchema,
  invocation: z.literal("context-v1"),
  arguments: z.record(localIdSchema, valueSpecSchema),
});
export const uiBindingSchema = z.strictObject({
  contributionId: namespacedIdSchema,
  panelInstance: handleSchema,
  kind: z.enum(["panel", "status"]),
  uiResourceGeneration: counterSchema,
  generation: counterSchema,
  hostEpoch: handleSchema,
  processEpoch: handleSchema,
});
const scalars = z.record(localIdSchema, uiScalarSchema);
export const uiStateSnapshotSchema = z.strictObject({
  binding: uiBindingSchema,
  revision: counterSchema,
  data: scalars,
  formRevision: counterSchema,
  form: scalars,
  valid: z.boolean(),
  visible: z.boolean(),
  locale: pluginLocaleSchema,
});
export const uiSubscriptionSnapshotSchema = z.strictObject({
  instances: z.array(uiBindingSchema).max(6),
  states: z.array(uiStateSnapshotSchema).max(1),
  locale: pluginLocaleSchema,
  theme: z.enum(["light", "dark"]),
});
export const commandInvocationSchema = z.strictObject({
  version: z.literal(1),
  invocationId: handleSchema,
  command: namespacedIdSchema,
  arguments: scalars,
  context: z.strictObject({
    contextRef: handleSchema.nullable(),
    origin: z.enum(["panel", "management"]),
    locale: pluginLocaleSchema,
    binding: uiBindingSchema.exactOptional(),
    motionScopeRef: handleSchema.exactOptional(),
    actionRef: handleSchema.exactOptional(),
    form: z.strictObject({ revision: counterSchema, values: scalars }).exactOptional(),
    trigger: z.union([
      z.strictObject({ kind: z.literal("activate") }),
      z.strictObject({
        kind: z.literal("hold"),
        phase: z.enum(["begin", "end", "cancel"]),
        gestureRef: handleSchema,
      }),
    ]),
  }),
});
export const commandValueSchema = z.strictObject({
  output: scalars,
  fieldErrors: z.array(z.strictObject({ field: localIdSchema, message: uiTextSchema })).max(32),
});
const detailFields = {
  kind: z.literal("ui"),
  contributionId: namespacedIdSchema.exactOptional(),
  fieldPath: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_$.[\]-]*$/)
    .exactOptional(),
  limit: z
    .enum(
      Object.keys(UI_LIMITS_V1) as [keyof typeof UI_LIMITS_V1, ...(keyof typeof UI_LIMITS_V1)[]],
    )
    .exactOptional(),
  allowed: counterSchema.exactOptional(),
  actual: counterSchema.exactOptional(),
};
export const uiResourceDetailSchema = z.strictObject({
  ...detailFields,
  reason: z.enum([
    "read",
    "path",
    "schema",
    "reference",
    "cycle",
    "translation",
    "limit",
    "renderer",
  ]),
});
export const uiVersionDetailSchema = z.strictObject({
  ...detailFields,
  reason: z.enum(["version", "negotiation"]),
});
export const uiFailureSchema = z.union([
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal("PLUGIN_E_UI_RESOURCE"),
      message: z.string().max(4000),
      detail: uiResourceDetailSchema.exactOptional(),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal("PLUGIN_E_UI_VERSION"),
      message: z.string().max(4000),
      detail: uiVersionDetailSchema.exactOptional(),
    }),
  }),
]);
export function uiResultSchema<T>(value: z.ZodType<T>): z.ZodType<Result<T>> {
  return z.union([
    z.strictObject({ ok: z.literal(true), value }),
    commonFailureSchema,
    uiFailureSchema,
  ]);
}
export const uiRevokeReasonSchema = z.enum([
  "release",
  "pointer-cancel",
  "focus-loss",
  "hidden",
  "closed",
  "form-change",
  "action-disabled",
  "heartbeat-expired",
  "authority-lost",
  "generation-retired",
  "resource-replaced",
  "renderer-gone",
  "process-gone",
  "provider-gone",
  "safe-mode",
  "shutdown",
  "overflow",
]);
export const uiEventSchema = z.union([
  z.strictObject({
    kind: z.literal("ui.instances"),
    data: z.strictObject({ instances: z.array(uiBindingSchema).max(6) }),
  }),
  z.strictObject({
    kind: z.literal("ui.visibility"),
    data: z.strictObject({ binding: uiBindingSchema, visible: z.boolean() }),
  }),
  z.strictObject({
    kind: z.literal("ui.environment"),
    data: z.strictObject({ locale: pluginLocaleSchema, theme: z.enum(["light", "dark"]) }),
  }),
  z.strictObject({
    kind: z.literal("ui.form"),
    data: z.strictObject({ binding: uiBindingSchema, revision: counterSchema, values: scalars }),
  }),
  z.strictObject({
    kind: z.literal("ui.state"),
    data: z.strictObject({ binding: uiBindingSchema, revision: counterSchema }),
  }),
  z.strictObject({
    kind: z.literal("ui.revoked"),
    data: z.strictObject({ binding: uiBindingSchema, reason: uiRevokeReasonSchema }),
  }),
]);

import { resourceOwnerSchema } from "./device-types.js";
const uiEnvelopeFields = {
  version: z.literal(1),
  subscriptionId: handleSchema,
  owner: resourceOwnerSchema,
  sequence: counterSchema,
  delivery: z.literal("control"),
};
export const uiEventEnvelopeSchema = z.union([
  uiEventSchema.options[0].extend(uiEnvelopeFields),
  uiEventSchema.options[1].extend(uiEnvelopeFields),
  uiEventSchema.options[2].extend(uiEnvelopeFields),
  uiEventSchema.options[3].extend(uiEnvelopeFields),
  uiEventSchema.options[4].extend(uiEnvelopeFields),
  uiEventSchema.options[5].extend(uiEnvelopeFields),
]);
