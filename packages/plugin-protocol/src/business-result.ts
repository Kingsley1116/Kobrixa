import { z } from "zod";
import type { Handle, DeviceErrorReason } from "./device-types.js";
export const PLUGIN_ERROR_CODES = [
  "PLUGIN_E_MANIFEST",
  "PLUGIN_E_API_VERSION",
  "PLUGIN_E_RESERVED_ID",
  "PLUGIN_E_DIAGNOSTIC_HELP",
  "PLUGIN_E_STATIC_LANGUAGE",
  "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
  "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
  "PLUGIN_E_DUPLICATE_ID",
  "PLUGIN_E_COMMAND_NAMESPACE",
  "PLUGIN_E_DUPLICATE_COMMAND",
  "PLUGIN_E_ACTIVATION",
  "PLUGIN_E_RUNTIME_NOT_ALLOWED",
  "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
  "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
  "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
  "PLUGIN_E_PROVIDER_CONFLICT",
  "PLUGIN_E_ENTRY",
  "PLUGIN_E_LAUNCH",
  "PLUGIN_E_HANDSHAKE",
  "PLUGIN_E_PROTOCOL",
  "PLUGIN_E_UNRESPONSIVE",
  "PLUGIN_E_CRASHED",
  "PLUGIN_E_CRASH_LOOP",
  "PLUGIN_E_TIMEOUT",
  "PLUGIN_E_CANCELLED",
  "PLUGIN_E_COMMAND_FAILED",
  "PLUGIN_E_UNKNOWN_COMMAND",
  "PLUGIN_E_UNKNOWN_PLUGIN",
  "PLUGIN_E_DISABLED",
  "PLUGIN_E_BUILTIN_REQUIRED",
  "PLUGIN_E_SAFE_MODE",
  "PLUGIN_E_STATE_SAVE",
  "PLUGIN_E_STATE_CORRUPT",
  "PLUGIN_E_SHUTTING_DOWN",
  "PLUGIN_E_SOURCE_TIMEOUT",
  "PLUGIN_E_SOURCE_EXISTS",
  "PLUGIN_E_DEVELOPER_MODE",
  "PLUGIN_E_SESSION_SOURCE",
  "PLUGIN_E_PYTHON_UNUSABLE",
  "PLUGIN_E_PERMISSION_DENIED",
  "PLUGIN_E_STALE_RESOURCE",
  "PLUGIN_E_RESOURCE_LIMIT",
  "PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN",
  "PLUGIN_E_DEVICE_UNAVAILABLE",
  "PLUGIN_E_DEVICE_CAPABILITY",
  "PLUGIN_E_DEVICE_BUSY",
  "PLUGIN_E_DEVICE_AUTHORITY",
  "PLUGIN_E_DEVICE_OPERATION",
  "PLUGIN_E_DEVICE_STOP_UNCONFIRMED",
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];
// 新增；每個方法以具體 Value／Detail union 匯出 schema，沒有 any JSON detail。
export type BusinessResult<Value, Detail, Code extends Stage3PluginErrorCode = PluginErrorCode> =
  | { ok: true; value: Value }
  | { ok: false; error: { code: Code; message: string; detail?: Detail } };

export type DispatchOutcome = "not-sent" | "sent" | "unknown";
export type DeviceErrorDetail = {
  kind: "device";
  reason: DeviceErrorReason;
  operationId?: Handle; // 只可附 caller 自己已取得的 operation。
  dispatch: DispatchOutcome;
  stopConfirmation: "not-required" | "pending" | "confirmed" | "unconfirmed";
};
export type PermissionErrorDetail = {
  kind: "permission";
  reason: "permission" | "user-action-required";
};
export type ResourceKindV150 =
  "operation" | "subscription" | "candidate" | "reservation" | "journal" | "rpc";
export type ResourceKind = ResourceKindV150; // 1.5.0；後續批次依下表擴充閉合 union。
export type ResourceErrorDetail = {
  kind: "resource";
  reason: "stale" | "quota" | "rate" | "queue";
  resource: ResourceKind;
  limit?: number; // nonnegative safe integer。
};

export type DefinitionMap<S extends Record<string, { params: z.ZodType; result: z.ZodType }>> = {
  [M in keyof S]: { params: z.input<S[M]["params"]>; result: z.output<S[M]["result"]> };
};

import type {
  Stage3PluginErrorCode,
  PluginErrorCodeV150,
  PluginErrorCodeV160,
  PluginErrorCodeV170,
} from "./errors.js";
export type ResourceKindV160 = ResourceKindV150 | "ui-binding";
export type ResourceKindV170 =
  | ResourceKindV160
  | "storage-write"
  | "storage-read"
  | "storage-list"
  | "storage-export"
  | "storage-watch";
export type ResourceErrorDetailFor<K extends ResourceKindV170> = Omit<
  ResourceErrorDetail,
  "resource"
> & { resource: K };
export type PublishedCommonFailure = Extract<
  BusinessResult<never, PermissionErrorDetail | ResourceErrorDetail>,
  { ok: false }
>;
export type ContractBatch = "1.5.0" | "1.6.0" | "1.7.0";
export type CodesByBatch = {
  "1.5.0": PluginErrorCodeV150;
  "1.6.0": PluginErrorCodeV160;
  "1.7.0": PluginErrorCodeV170;
};
export type ResourcesByBatch = {
  "1.5.0": ResourceKindV150;
  "1.6.0": ResourceKindV160;
  "1.7.0": ResourceKindV170;
};
export type CommonFailureFor<B extends ContractBatch> = Extract<
  BusinessResult<
    never,
    PermissionErrorDetail | ResourceErrorDetailFor<ResourcesByBatch[B]>,
    CodesByBatch[B]
  >,
  { ok: false }
>;

import { handleSchema, counterSchema, wireText } from "./device-types.js";
export const pluginErrorCodeSchema = z.enum(PLUGIN_ERROR_CODES);
export const deviceReasonByCode = {
  PLUGIN_E_DEVICE_UNAVAILABLE: [
    "provider-disabled",
    "disconnected",
    "quarantined",
    "ui-scope-unavailable",
  ],
  PLUGIN_E_DEVICE_CAPABILITY: ["unsupported-capability"],
  PLUGIN_E_DEVICE_BUSY: ["foreground", "recording", "connecting", "source-changing"],
  PLUGIN_E_DEVICE_AUTHORITY: [
    "unbound",
    "joining",
    "unsynced",
    "not-holder",
    "viewer",
    "authority-changed",
    "scope-expired",
  ],
  PLUGIN_E_DEVICE_OPERATION: [
    "preflight-program-running",
    "preflight-output-unknown",
    "preflight-output-moving",
    "motor-unavailable",
    "source-changed",
    "mode-unavailable",
    "provider-failure",
    "provider-contract",
    "journal-unwritable",
    "journal-corrupt",
    "identity-ambiguous",
  ],
  PLUGIN_E_DEVICE_STOP_UNCONFIRMED: [
    "readback-failed",
    "stop-deadline",
    "connection-lost",
    "provider-stalled",
  ],
  PLUGIN_E_TIMEOUT: ["deadline"],
  PLUGIN_E_CANCELLED: ["cancelled"],
  PLUGIN_E_DISABLED: ["disabled"],
  PLUGIN_E_SAFE_MODE: ["safe-mode"],
  PLUGIN_E_SHUTTING_DOWN: ["shutting-down"],
  PLUGIN_E_CRASHED: ["process-lost"],
  PLUGIN_E_PROTOCOL: ["protocol"],
  PLUGIN_E_PROVIDER_CONFLICT: ["provider-conflict"],
} as const;
const reasons = Object.values(deviceReasonByCode).flat();
export const deviceErrorDetailSchema = z.strictObject({
  kind: z.literal("device"),
  reason: z.enum(reasons),
  operationId: handleSchema.exactOptional(),
  dispatch: z.enum(["not-sent", "sent", "unknown"]),
  stopConfirmation: z.enum(["not-required", "pending", "confirmed", "unconfirmed"]),
});
export const permissionErrorDetailSchema = z.strictObject({
  kind: z.literal("permission"),
  reason: z.enum(["permission", "user-action-required"]),
});
export const resourceErrorDetailSchema = z.strictObject({
  kind: z.literal("resource"),
  reason: z.enum(["stale", "quota", "rate", "queue"]),
  resource: z.enum(["operation", "subscription", "candidate", "reservation", "journal", "rpc"]),
  limit: counterSchema.exactOptional(),
});
export const deviceFailureDetailSchema = z.union([
  deviceErrorDetailSchema,
  permissionErrorDetailSchema,
  resourceErrorDetailSchema,
]);
export const deviceErrorSchema = z.strictObject({
  code: pluginErrorCodeSchema,
  message: wireText(1, 2000),
  detail: deviceErrorDetailSchema,
});
export const businessResultSchema = <V extends z.ZodType, D extends z.ZodType>(
  value: V,
  detail: D,
) =>
  z.union([
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({
        code: pluginErrorCodeSchema,
        message: wireText(1, 2000),
        detail: detail.exactOptional(),
      }),
    }),
  ]);
export function unwrap<Value, Detail>(result: BusinessResult<Value, Detail>): Value {
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), {
    name: "PluginBusinessError",
    code: result.error.code,
    detail: result.error.detail,
  });
}

const resources150 = [
  "operation",
  "subscription",
  "candidate",
  "reservation",
  "journal",
  "rpc",
] as const;
const resources160 = [...resources150, "ui-binding"] as const;
const resources170 = [
  ...resources160,
  "storage-write",
  "storage-read",
  "storage-list",
  "storage-export",
  "storage-watch",
] as const;
export function commonFailureSchemaFor<B extends ContractBatch>(
  batch: B,
): z.ZodType<CommonFailureFor<B>> {
  const resource = z.strictObject({
    kind: z.literal("resource"),
    reason: z.enum(["stale", "quota", "rate", "queue"]),
    resource: z.enum(
      batch === "1.5.0" ? resources150 : batch === "1.6.0" ? resources160 : resources170,
    ),
    limit: counterSchema.exactOptional(),
  });
  const shape = z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "PLUGIN_E_PERMISSION_DENIED",
        "PLUGIN_E_STALE_RESOURCE",
        "PLUGIN_E_RESOURCE_LIMIT",
      ]),
      message: wireText(1, 2000),
      detail: z.union([permissionErrorDetailSchema, resource]),
    }),
  });
  return z.custom<CommonFailureFor<B>>((input) => {
    const parsed = shape.safeParse(input);
    if (!parsed.success) return false;
    const { code, detail } = parsed.data.error;
    return detail.kind === "permission"
      ? code === "PLUGIN_E_PERMISSION_DENIED"
      : code ===
          (detail.reason === "stale" ? "PLUGIN_E_STALE_RESOURCE" : "PLUGIN_E_RESOURCE_LIMIT");
  });
}
export const commonFailureSchema: z.ZodType<PublishedCommonFailure> = z.union([
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal("PLUGIN_E_PERMISSION_DENIED"),
      message: wireText(1, 2000),
      detail: permissionErrorDetailSchema,
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal("PLUGIN_E_STALE_RESOURCE"),
      message: wireText(1, 2000),
      detail: z.strictObject({
        kind: z.literal("resource"),
        reason: z.literal("stale"),
        resource: z.enum(resources150),
        limit: counterSchema.exactOptional(),
      }),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal("PLUGIN_E_RESOURCE_LIMIT"),
      message: wireText(1, 2000),
      detail: z.strictObject({
        kind: z.literal("resource"),
        reason: z.enum(["quota", "rate", "queue"]),
        resource: z.enum(resources150),
        limit: counterSchema.exactOptional(),
      }),
    }),
  }),
]);
