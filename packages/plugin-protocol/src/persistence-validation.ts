import type { Handle } from "./device-types.js";
import type { BusinessResult, PermissionErrorDetail, ResourceErrorDetailFor, ResourceKindV170 } from "./business-result.js";
import type { PluginErrorCodeV170 } from "./errors.js";
import type { SettingsRevision, RecordRevision, Version, SettingKey } from "./settings.js";
export type PersistenceReason =
  | "invalid-resource"
  | "invalid-value"
  | "duplicate-key"
  | "unknown-key"
  | "size-limit"
  | "schema-changed-without-version"
  | "migration-required"
  | "downgrade"
  | "unsupported-format"
  | "corrupt"
  | "revision-mismatch"
  | "disk-full"
  | "permission"
  | "read-only"
  | "io"
  | "sync-failed"
  | "publish-uncertain"
  | "import-pending"
  | "record-count"
  | "source-bytes"
  | "host-bytes"
  | "temporary-bytes"
  | "write-in-progress"
  | "offset-mismatch"
  | "sealed"
  | "incomplete"
  | "checksum-mismatch"
  | "flush-incomplete"
  | "export-not-ready"
  | "not-found"
  | "input-changed"
  | "clipboard-unavailable"
  | "destination-changed"
  | "unsupported-filesystem"
  | "schema-mismatch";
export type PersistenceDetail = {
  kind: "persistence";
  reason: PersistenceReason; // 下表七個 settings／storage codes 的 closed reason union
  phase?: "validate" | "reserve" | "write" | "seal" | "publish" | "sync" | "recover";
  disposition?: "not-committed" | "committed" | "unknown";
  actualRevision?: SettingsRevision | RecordRevision; // 僅同 source、讀取權限具備且已知時提供
  expectedVersion?: Version;
  actualVersion?: Version;
  limit?: number;
  requested?: number;
  retryable?: boolean;
  payload?: "complete-staging" | "checkpoint-only" | "none";
  expiresAt?: number; // UTC epoch milliseconds，顯示用；host 以 monotonic clock 執行期限
  commitId?: Handle;
  keys?: SettingKey[]; // 最多 16；不含值；其餘錯誤由重新驗證取得
};
// 前兩個 branch 原樣 type-only 匯入 3A，僅組合本案會返回的 detail。
export type PersistenceFailureDetail = PermissionErrorDetail | ResourceErrorDetailFor<ResourceKindV170> | PersistenceDetail;
export type PersistenceResult<Value> = BusinessResult<Value, PersistenceFailureDetail, PluginErrorCodeV170>;
