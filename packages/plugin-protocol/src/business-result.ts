import type { z } from "zod";
import type { Handle, DeviceErrorReason } from "./device-types.js";
export const PLUGIN_ERROR_CODES = ["PLUGIN_E_MANIFEST", "PLUGIN_E_API_VERSION", "PLUGIN_E_RESERVED_ID", "PLUGIN_E_DIAGNOSTIC_HELP", "PLUGIN_E_STATIC_LANGUAGE", "PLUGIN_E_STATIC_LANGUAGE_CONFLICT", "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION", "PLUGIN_E_DUPLICATE_ID", "PLUGIN_E_COMMAND_NAMESPACE", "PLUGIN_E_DUPLICATE_COMMAND", "PLUGIN_E_ACTIVATION", "PLUGIN_E_RUNTIME_NOT_ALLOWED", "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN", "PLUGIN_E_BACKEND_REQUIRES_BUILTIN", "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN", "PLUGIN_E_PROVIDER_CONFLICT", "PLUGIN_E_ENTRY", "PLUGIN_E_LAUNCH", "PLUGIN_E_HANDSHAKE", "PLUGIN_E_PROTOCOL", "PLUGIN_E_UNRESPONSIVE", "PLUGIN_E_CRASHED", "PLUGIN_E_CRASH_LOOP", "PLUGIN_E_TIMEOUT", "PLUGIN_E_CANCELLED", "PLUGIN_E_COMMAND_FAILED", "PLUGIN_E_UNKNOWN_COMMAND", "PLUGIN_E_UNKNOWN_PLUGIN", "PLUGIN_E_DISABLED", "PLUGIN_E_BUILTIN_REQUIRED", "PLUGIN_E_SAFE_MODE", "PLUGIN_E_STATE_SAVE", "PLUGIN_E_STATE_CORRUPT", "PLUGIN_E_SHUTTING_DOWN", "PLUGIN_E_SOURCE_TIMEOUT", "PLUGIN_E_SOURCE_EXISTS", "PLUGIN_E_DEVELOPER_MODE", "PLUGIN_E_SESSION_SOURCE", "PLUGIN_E_PYTHON_UNUSABLE", "PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_RESOURCE_LIMIT", "PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN", "PLUGIN_E_DEVICE_UNAVAILABLE", "PLUGIN_E_DEVICE_CAPABILITY", "PLUGIN_E_DEVICE_BUSY", "PLUGIN_E_DEVICE_AUTHORITY", "PLUGIN_E_DEVICE_OPERATION", "PLUGIN_E_DEVICE_STOP_UNCONFIRMED"] as const;
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

import type { Stage3PluginErrorCode, PluginErrorCodeV150, PluginErrorCodeV160, PluginErrorCodeV170 } from "./errors.js";
export type ResourceKindV160 = ResourceKindV150 | "ui-binding";
export type ResourceKindV170 = ResourceKindV160 | "storage-write" | "storage-read" | "storage-list" | "storage-export" | "storage-watch";
export type ResourceErrorDetailFor<K extends ResourceKindV170> = Omit<ResourceErrorDetail, "resource"> & { resource: K };
export type PublishedCommonFailure = Extract<BusinessResult<never, PermissionErrorDetail | ResourceErrorDetail>, { ok: false }>;
export type ContractBatch = "1.5.0" | "1.6.0" | "1.7.0";
export type CodesByBatch = { "1.5.0": PluginErrorCodeV150; "1.6.0": PluginErrorCodeV160; "1.7.0": PluginErrorCodeV170 };
export type ResourcesByBatch = { "1.5.0": ResourceKindV150; "1.6.0": ResourceKindV160; "1.7.0": ResourceKindV170 };
export type CommonFailureFor<B extends ContractBatch> = Extract<BusinessResult<never, PermissionErrorDetail | ResourceErrorDetailFor<ResourcesByBatch[B]>, CodesByBatch[B]>, { ok: false }>;
export declare const commonFailureSchema: z.ZodType<PublishedCommonFailure>;
export declare function commonFailureSchemaFor<B extends ContractBatch>(batch: B): z.ZodType<CommonFailureFor<B>>;
