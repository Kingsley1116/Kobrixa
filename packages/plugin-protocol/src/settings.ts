import { z } from "zod";
import type { Handle } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import { boundedText, jsonBytes, keySchema, versionSchema, revisionSchema, receiptSchema,
  handleSchema, persistenceResultSchema, PersistenceValidationError } from "./persistence-primitives.js";
export type Version = number; // integer，1..2_147_483_647
export type SettingsRevision = string; // /^r_[0-9a-f]{32}$/，host 隨機產生，只能在 settings domain 比較相等
export type RecordRevision = string; // 同一格式；僅在同 source／record domain 比較相等
export type RecordId = string; // host 產生的 lowercase UUID v4，永不重用
// Handle／Counter type-only 匯入 3A 的共用型別，不在本案重新定義。
export type Sha256 = string; // /^[0-9a-f]{64}$/
export type SettingKey = string; // /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/，最多 64 bytes
export type Scalar = boolean | number | string;
export type Values = Array<{ key: SettingKey; value: Scalar }>;
export type Durability = "file-and-directory-sync" | "file-sync-only";
export type Receipt<R extends SettingsRevision | RecordRevision> = {
  revision: R;
  commitId: Handle;
  durability: Durability;
};

export type SettingsText = { en: string; "zh-TW"?: string };
export type CommonField = { key: SettingKey; label: SettingsText; help?: SettingsText };
export type SettingsField = CommonField &
  (
    | { type: "boolean"; default: boolean }
    | { type: "number"; default: number; minimum: number; maximum: number }
    | { type: "integer"; default: number; minimum: number; maximum: number }
    | { type: "string"; default: string; minLength: number; maxLength: number; maxBytes: number }
    | {
        type: "enum";
        default: string | number;
        options: Array<{ value: string | number; label: SettingsText }>;
      }
  );
export type SettingsResourceV1 = {
  schemaVersion: Version;
  title: SettingsText;
  fields: SettingsField[];
};

export type SettingsSnapshot = {
  schemaVersion: Version;
  revision: SettingsRevision | null; // null 只表示尚無 committed settings
  values: Values; // 完整 effective values，含 defaults，最多 64 KiB
};
export type SettingsMutation = { snapshot: SettingsSnapshot; receipt: Receipt<SettingsRevision> };

const settingsText = (value: { en: string; "zh-TW"?: string | undefined }): SettingsText =>
  ({ en: value.en, ...(value["zh-TW"] === undefined ? {} : { "zh-TW": value["zh-TW"] }) });
const title = z.strictObject({ en: boundedText(1, 200, 800, true), "zh-TW": boundedText(1, 200, 800, true).optional() }).transform(settingsText);
const help = z.strictObject({ en: boundedText(0, 2000, 8192), "zh-TW": boundedText(0, 2000, 8192).optional() }).transform(settingsText);
const common = { key: keySchema, label: title, help: help.optional() };
const scalar = z.union([z.boolean(), z.number(), boundedText(0, 4000, 4096)]);
const optionValue = z.union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), boundedText(0, 4000, 4096)]);
export const settingsFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("boolean"), default: z.boolean() }),
  z.strictObject({ ...common, type: z.literal("number"), default: z.number(), minimum: z.number(), maximum: z.number() }),
  z.strictObject({ ...common, type: z.literal("integer"), default: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), minimum: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), maximum: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ ...common, type: z.literal("string"), default: boundedText(0, 4000, 4096), minLength: z.number().int().min(0).max(4000), maxLength: z.number().int().min(0).max(4000), maxBytes: z.number().int().min(1).max(4096) }),
  z.strictObject({ ...common, type: z.literal("enum"), default: optionValue, options: z.array(z.strictObject({ value: optionValue, label: title })).min(1).max(32) }),
]).transform(({ help, ...field }): SettingsField => ({ ...field, ...(help === undefined ? {} : { help }) }));
export const valuesSchema = z.array(z.strictObject({ key: keySchema, value: scalar })).max(128)
  .refine(v => new Set(v.map(x => x.key)).size === v.length && jsonBytes(v) <= 65536);
export const settingsResourceV1Schema: z.ZodType<SettingsResourceV1> = z.strictObject({ schemaVersion: versionSchema, title, fields: z.array(settingsFieldSchema).min(1).max(128) });
export const settingsSnapshotSchema = z.strictObject({ schemaVersion: versionSchema, revision: revisionSchema.nullable(), values: valuesSchema });
export const settingsMutationSchema = z.strictObject({ snapshot: settingsSnapshotSchema, receipt: receiptSchema });
export const settingsChangedSchema = z.strictObject({ revision: revisionSchema, schemaVersion: versionSchema,
  changedKeys: z.array(keySchema).max(128), cause: z.enum(["update", "reset", "migrate", "import"]) });
const failure = (reason: ConstructorParameters<typeof PersistenceValidationError>[0]): never => { throw new PersistenceValidationError(reason); };
export function validateSettingsValues(resource: SettingsResourceV1, input: unknown, complete: boolean): Values {
  if (jsonBytes(input) > 65536) return failure("size-limit");
  const parsed = valuesSchema.safeParse(input);
  if (!parsed.success) return failure("invalid-value");
  const values = parsed.data;
  const fields = new Map(resource.fields.map(f => [f.key, f]));
  if (complete && values.length !== fields.size) return failure("invalid-value");
  for (const { key, value } of values) {
    const f = fields.get(key);
    if (!f) return failure("unknown-key");
    switch (f.type) {
      case "boolean": if (typeof value !== "boolean") return failure("invalid-value"); break;
      case "number": case "integer":
        if (typeof value !== "number" || !Number.isFinite(value) || value < f.minimum || value > f.maximum || (f.type === "integer" && !Number.isSafeInteger(value))) return failure("invalid-value");
        break;
      case "string":
        if (typeof value !== "string" || !boundedText(f.minLength, f.maxLength, f.maxBytes).safeParse(value).success) return failure("invalid-value");
        break;
      case "enum": if (!f.options.some(o => typeof o.value === typeof value && o.value === value)) return failure("invalid-value"); break;
    }
  }
  return values;
}

export function settingsValidationText(resource: SettingsResourceV1): string {
  return JSON.stringify({ schemaVersion: resource.schemaVersion, fields: [...resource.fields].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(f => {
    const base = { key: f.key, type: f.type, default: f.default };
    if (f.type === "number" || f.type === "integer") return { ...base, minimum: f.minimum, maximum: f.maximum };
    if (f.type === "string") return { ...base, minLength: f.minLength, maxLength: f.maxLength, maxBytes: f.maxBytes };
    if (f.type === "enum") return { ...base, options: f.options.map(o => [typeof o.value, o.value]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) };
    return base;
  }) });
}
export function checkSettingsVersion(storedVersion: number, declaredVersion: number, storedDigest: string, declaredDigest: string): void {
  if (storedVersion > declaredVersion) failure("downgrade");
  if (storedVersion < declaredVersion) failure("migration-required");
  if (storedDigest !== declaredDigest) failure("schema-changed-without-version");
}
const request = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({ params, result: persistenceResultSchema(value) });
export const settingsRequestSchemas = {
  "settings/read": request(z.strictObject({ schemaVersion: versionSchema }), settingsSnapshotSchema),
  "settings/update": request(z.strictObject({ schemaVersion: versionSchema, expectedRevision: revisionSchema.nullable(), changes: valuesSchema.min(1) }), settingsMutationSchema),
  "settings/reset": request(z.strictObject({ schemaVersion: versionSchema, expectedRevision: revisionSchema.nullable(), keys: z.array(keySchema).min(1).max(128).refine(v => new Set(v).size === v.length) }), settingsMutationSchema),
  "settings/watch": request(z.strictObject({ schemaVersion: versionSchema }), z.strictObject({ subscriptionId: handleSchema, sequence: z.literal(0), snapshot: settingsSnapshotSchema })),
  "settings/readMigration": request(z.strictObject({}) as z.ZodType<Record<string, never>, Record<string, never>>, z.strictObject({ stored: settingsSnapshotSchema, declaredSchemaVersion: versionSchema })),
  "settings/migrate": request(z.strictObject({ fromSchemaVersion: versionSchema, schemaVersion: versionSchema, expectedRevision: revisionSchema, values: valuesSchema }), settingsMutationSchema),
};
export type SettingsRequestMap = DefinitionMap<typeof settingsRequestSchemas>;
