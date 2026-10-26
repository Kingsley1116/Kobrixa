import { z } from "zod";
import type { Handle } from "./device-types.js";
import type { BusinessResult, PermissionErrorDetail, ResourceErrorDetailFor, ResourceKindV170 } from "./business-result.js";
import { commonFailureSchemaFor } from "./business-result.js";
import type { PluginErrorCodeV170 } from "./errors.js";
import type { SettingsRevision, RecordRevision, Version, SettingKey } from "./settings.js";
export const persistenceCodeReasons = {
  PLUGIN_E_SETTINGS_SCHEMA: ["invalid-resource", "invalid-value", "duplicate-key", "unknown-key", "size-limit", "schema-changed-without-version", "migration-required", "downgrade", "unsupported-format", "corrupt"],
  PLUGIN_E_SETTINGS_CONFLICT: ["revision-mismatch"],
  PLUGIN_E_SETTINGS_SAVE: ["disk-full", "permission", "read-only", "io", "sync-failed", "publish-uncertain", "import-pending"],
  PLUGIN_E_STORAGE_QUOTA: ["record-count", "source-bytes", "host-bytes", "temporary-bytes"],
  PLUGIN_E_STORAGE_CONFLICT: ["revision-mismatch", "write-in-progress", "offset-mismatch", "sealed", "incomplete", "checksum-mismatch", "flush-incomplete", "export-not-ready"],
  PLUGIN_E_STORAGE_IO: ["not-found", "disk-full", "permission", "read-only", "io", "sync-failed", "publish-uncertain", "corrupt", "import-pending", "input-changed", "clipboard-unavailable", "destination-changed", "unsupported-filesystem"],
  PLUGIN_E_STORAGE_VERSION: ["unsupported-format", "schema-mismatch"],
} as const;
export type PersistenceReason = (typeof persistenceCodeReasons)[keyof typeof persistenceCodeReasons][number];
export type PersistenceDetail = {
  kind: "persistence"; reason: PersistenceReason;
  phase?: "validate" | "reserve" | "write" | "seal" | "publish" | "sync" | "recover";
  disposition?: "not-committed" | "committed" | "unknown";
  actualRevision?: SettingsRevision | RecordRevision; expectedVersion?: Version; actualVersion?: Version;
  limit?: number; requested?: number; retryable?: boolean;
  payload?: "complete-staging" | "checkpoint-only" | "none"; expiresAt?: number; commitId?: Handle; keys?: SettingKey[];
};
export type PersistenceFailureDetail = PermissionErrorDetail | ResourceErrorDetailFor<ResourceKindV170> | PersistenceDetail;
export type PersistenceResult<Value> = BusinessResult<Value, PersistenceFailureDetail, PluginErrorCodeV170>;
export const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
export const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const versionSchema = z.number().int().min(1).max(2147483647);
export const handleSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const revisionSchema = z.string().regex(/^r_[0-9a-f]{32}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const keySchema = z.string().max(64).regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/)
  .refine(value => !value.split(".").some(k => ["__proto__", "prototype", "constructor"].includes(k)));
export const durabilitySchema = z.enum(["file-and-directory-sync", "file-sync-only"]);
export const receiptSchema = z.strictObject({ revision: revisionSchema, commitId: handleSchema, durability: durabilitySchema });
export const wellFormedText = (text: string): boolean => !text.includes("\0") && [...text].every(c => {
  const n = c.codePointAt(0)!; return n < 0xd800 || n > 0xdfff;
});
export function boundedText(min: number, max: number, bytes: number, singleLine = false) {
  // eslint-disable-next-line no-control-regex -- Single-line text explicitly excludes C0 controls, DEL and line separators.
  return z.string().refine(s => wellFormedText(s) && [...s].length >= min && [...s].length <= max && utf8Bytes(s) <= bytes && (!singleLine || !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(s)));
}
const reasons = [...new Set(Object.values(persistenceCodeReasons).flat())] as [PersistenceReason, ...PersistenceReason[]];
export const persistenceDetailSchema = z.strictObject({
  kind: z.literal("persistence"), reason: z.enum(reasons),
  phase: z.enum(["validate", "reserve", "write", "seal", "publish", "sync", "recover"]).optional(),
  disposition: z.enum(["not-committed", "committed", "unknown"]).optional(),
  actualRevision: revisionSchema.optional(), expectedVersion: versionSchema.optional(), actualVersion: versionSchema.optional(),
  limit: safeIntegerSchema.optional(), requested: safeIntegerSchema.optional(), retryable: z.boolean().optional(),
  payload: z.enum(["complete-staging", "checkpoint-only", "none"]).optional(), expiresAt: safeIntegerSchema.optional(),
  commitId: handleSchema.optional(), keys: z.array(keySchema).max(16).optional(),
}).refine(d => jsonBytes(d) <= 2048).transform((d): PersistenceDetail => ({
  kind: d.kind, reason: d.reason,
  ...(d.phase === undefined ? {} : { phase: d.phase }),
  ...(d.disposition === undefined ? {} : { disposition: d.disposition }),
  ...(d.actualRevision === undefined ? {} : { actualRevision: d.actualRevision }),
  ...(d.expectedVersion === undefined ? {} : { expectedVersion: d.expectedVersion }),
  ...(d.actualVersion === undefined ? {} : { actualVersion: d.actualVersion }),
  ...(d.limit === undefined ? {} : { limit: d.limit }),
  ...(d.requested === undefined ? {} : { requested: d.requested }),
  ...(d.retryable === undefined ? {} : { retryable: d.retryable }),
  ...(d.payload === undefined ? {} : { payload: d.payload }),
  ...(d.expiresAt === undefined ? {} : { expiresAt: d.expiresAt }),
  ...(d.commitId === undefined ? {} : { commitId: d.commitId }),
  ...(d.keys === undefined ? {} : { keys: d.keys }),
}));
// These schemas validate the existing A branches verbatim; their TS definitions stay A-owned.
// The extra resource literals are isolated 1.7 candidates until H-P publishes the corresponding batch.
const permissionDetail = z.strictObject({ kind: z.literal("permission"), reason: z.enum(["permission", "user-action-required"]) });
const resourceDetail = z.strictObject({ kind: z.literal("resource"), reason: z.enum(["stale", "quota", "rate", "queue"]),
  resource: z.enum(["operation", "subscription", "candidate", "reservation", "journal", "rpc", "ui-binding", "storage-write", "storage-read", "storage-list", "storage-export", "storage-watch"]), limit: safeIntegerSchema.optional() }).transform(({ limit, ...detail }): ResourceErrorDetailFor<ResourceKindV170> =>
    ({ ...detail, ...(limit === undefined ? {} : { limit }) }));
const message = boundedText(0, 2000, 8000);
const lifecycle = ["PLUGIN_E_TIMEOUT", "PLUGIN_E_CANCELLED", "PLUGIN_E_DISABLED", "PLUGIN_E_SAFE_MODE", "PLUGIN_E_SHUTTING_DOWN"] as const;
const persistenceCodes = ["PLUGIN_E_SETTINGS_SCHEMA", "PLUGIN_E_SETTINGS_SAVE", "PLUGIN_E_SETTINGS_CONFLICT", "PLUGIN_E_STORAGE_QUOTA", "PLUGIN_E_STORAGE_CONFLICT", "PLUGIN_E_STORAGE_IO", "PLUGIN_E_STORAGE_VERSION"] as const;
const code = z.enum(["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_RESOURCE_LIMIT", ...persistenceCodes, ...lifecycle]);
export const persistenceErrorSchema = z.strictObject({ code, message,
  detail: z.union([persistenceDetailSchema, permissionDetail, resourceDetail]).optional(),
}).superRefine((e, ctx) => {
  let valid = false;
  const d = e.detail;
  if (e.code in persistenceCodeReasons) valid = d === undefined || (d.kind === "persistence" &&
    (persistenceCodeReasons[e.code as keyof typeof persistenceCodeReasons] as readonly string[]).includes(d.reason));
  else if (e.code === "PLUGIN_E_PERMISSION_DENIED") valid = d === undefined || d.kind === "permission";
  else if (e.code === "PLUGIN_E_STALE_RESOURCE") valid = d === undefined || (d.kind === "resource" && d.reason === "stale");
  else if (e.code === "PLUGIN_E_RESOURCE_LIMIT") valid = d === undefined || (d.kind === "resource" && d.reason !== "stale");
  else valid = d === undefined;
  if (!valid || (d !== undefined && jsonBytes(d) > 2048)) ctx.addIssue({ code: "custom", message: "Invalid code/detail pair" });
}).transform(({ detail, ...error }) => ({ ...error, ...(detail === undefined ? {} : { detail }) }));
export function persistenceResultSchema<S extends z.ZodType>(value: S) {
  return z.union([
    z.strictObject({ ok: z.literal(true), value }),
    commonFailureSchemaFor("1.7.0"),
    z.strictObject({ ok: z.literal(false), error: persistenceErrorSchema }),
  ]);
}
// H-P owns BusinessResult's defaulted third Code parameter and the V170 projections.
// This inferred schema compiles against PersistenceResult without asserting a published union.
const projectedCompileCheck: z.ZodType<PersistenceResult<string>> = persistenceResultSchema(z.string());
void projectedCompileCheck;
export function canonicalBase64Length(text: string, allowEmpty = false): number {
  if (text === "" && allowEmpty) return 0;
  if (text.length === 0 || text.length > 349528 || text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("invalid-base64");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(text[text.length - padding - 1]!);
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) throw new Error("invalid-base64-tail-bits");
  const bytes = text.length / 4 * 3 - padding;
  if (bytes > 262144) throw new Error("size-limit");
  return bytes;
}
export const chunkSchema = (allowEmpty = false) => z.string().refine(text => {
  try { canonicalBase64Length(text, allowEmpty); return true; } catch { return false; }
});
export class PersistenceValidationError extends Error {
  constructor(readonly reason: PersistenceReason) { super(reason); }
}
