import type { Handle, Counter } from "./device-types.js";
import type { BusinessResult, PermissionErrorDetail, ResourceErrorDetailFor, ResourceKindV160 } from "./business-result.js";
import type { PluginErrorCodeV160 } from "./errors.js";
import type { EventEnvelope } from "./events.js";
import type { Text, LocalId, Scalar, ValueSpec } from "./ui-resource.js";
import type { UI_LIMITS_V1 } from "./ui-limits.js";
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
export type Result<T> = BusinessResult<T, UiDetail | PermissionErrorDetail | ResourceErrorDetailFor<ResourceKindV160>, PluginErrorCodeV160>;
export type UiSubscriptionSnapshot = {
  instances: UiBinding[];
  states: UiStateSnapshot[];
  locale: "en" | "zh-TW";
  theme: "light" | "dark";
};
