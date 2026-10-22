import type { z } from "zod";
type Wire<T> = z.ZodType<T, T>;
import type { Handle } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { PersistenceResult } from "./persistence-validation.js";

// 新增概念型別；正式 Zod 及其 inferred TS types 由 protocol integrator 發布。
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

export declare const settingsRequestSchemas: {
  "settings/read": { params: Wire<{ schemaVersion: Version }>; result: Wire<PersistenceResult<SettingsSnapshot>> };
  "settings/update": { params: Wire<{ schemaVersion: Version; expectedRevision: SettingsRevision | null; changes: Values }>; result: Wire<PersistenceResult<SettingsMutation>> };
  "settings/reset": { params: Wire<{ schemaVersion: Version; expectedRevision: SettingsRevision | null; keys: SettingKey[] }>; result: Wire<PersistenceResult<SettingsMutation>> };
  "settings/watch": { params: Wire<{ schemaVersion: Version }>; result: Wire<PersistenceResult<{ subscriptionId: Handle; sequence: 0; snapshot: SettingsSnapshot }>> };
  "settings/readMigration": { params: Wire<Record<string, never>>; result: Wire<PersistenceResult<{ stored: SettingsSnapshot; declaredSchemaVersion: Version }>> };
  "settings/migrate": { params: Wire<{ fromSchemaVersion: Version; schemaVersion: Version; expectedRevision: SettingsRevision; values: Values }>; result: Wire<PersistenceResult<SettingsMutation>> };
};
export type SettingsRequestMap = DefinitionMap<typeof settingsRequestSchemas>;
