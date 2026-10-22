import type { DispatchOutcome, DeviceErrorDetail, PluginErrorCode } from "./business-result.js";
// 新增；wire 上均為 JSON，品牌型別僅供 TS 編譯檢查。
export type Handle = string; // UUID v4，小寫 canonical；host 產生、永不重用。
export type Counter = number; // integer，0..Number.MAX_SAFE_INTEGER。
export type Timestamp = number; // Unix epoch milliseconds，0..Number.MAX_SAFE_INTEGER。
export type BoundedId = string; // 1..64 ASCII，^[A-Za-z0-9][A-Za-z0-9:._-]*$。
export type SessionRef = { sessionId: Handle };
export type OperationRef = { operationId: Handle };
export type ReservationRef = { reservationId: Handle };
export type SubscriptionRef = { subscriptionId: Handle };
export type ResourceOwner = {
  sourceKey: string; // 沿用 registry sourceKey 語法、max 160。
  pluginId: string; // 沿用 namespacedIdSchema。
  generation: Counter;
  hostEpoch: Handle;
  processEpoch: Handle;
};
// 新增；只列 wire 欄位，不暴露 DeviceDescriptor.metadata。
export type CapabilityId =
  | "connection.v1"
  | "telemetry.v1"
  | "inputModes.v1"
  | "finiteMotion.v1"
  | "recordingReservation.v1";
export type DeviceCandidate = {
  candidateId: Handle;
  providerId: string; // namespacedId。
  name: string; // 1..200 code points，單行。
  transport: "usb" | "wifi" | "mock"; // mock 只可由 test host 發布。
  address?: string; // IP literal，max 45；只在 Wi-Fi 顯示。
  identity: "stable" | "session-only" | "ambiguous";
  expiresInMs: number; // 0..30000，提示值，host monotonic clock 才具權威。
};
export type DeviceSessionSnapshot = {
  sessionId: Handle;
  providerId: string;
  providerGeneration: Counter;
  revision: Counter;
  name: string;
  transport: "usb" | "wifi" | "mock";
  capabilities: CapabilityId[]; // unique，最多 5。
  state: "connected" | "quarantined" | "disconnecting" | "disconnected";
  foreground: "none" | "motion" | "program" | "file" | "mode" | "recovery";
  recording: boolean;
  sourceRevision: Counter;
};
export type ChannelDefinition = {
  channelId: Handle;
  kind: "input" | "output-angle" | "battery-percent" | "battery-voltage";
  portId: BoundedId | null;
  typeId: BoundedId;
  modeId: BoundedId | null;
  component: number; // integer 0..7。
  name: string; // 1..80。
  modeName: string; // 0..80。
  unit: string; // 0..32。
  decimals: number; // integer 0..9。
  state: "ready" | "empty" | "initializing" | "unknown" | "error";
};
export type ActuatorDefinition = {
  actuatorId: Handle;
  portId: BoundedId;
  name: string; // 1..80。
  typeId: BoundedId;
  state: "ready" | "empty" | "initializing" | "unknown" | "error";
};
export type SourceCatalog = {
  sessionId: Handle;
  sourceRevision: Counter;
  channels: ChannelDefinition[]; // 最多 38：4×8 inputs、4 outputs、2 battery。
  actuators: ActuatorDefinition[]; // 最多 4。
};
export type TelemetryFrame = {
  sequence: Counter; // session sampler sequence，與 event sequence 分開。
  sampledAt: Timestamp; // host receipt wall clock，顯示／匯出用途。
  elapsedMs: number; // nonnegative finite，session monotonic origin。
  sourceRevision: Counter;
  status: "ok" | "busy" | "error" | "gap";
  values: Array<{ channelId: Handle; value: number | null }>; // 最多 38，finite numbers。
  program: "stopped" | "running" | "unknown";
  gap?: { fromSequence: Counter; toSequence: Counter; reason: "busy" | "overflow" | "read-error" };
};
export type ReadSnapshot = {
  sessionId: Handle;
  revision: Counter;
  status: "fresh" | "stale" | "busy" | "unavailable";
  ageMs: number | null; // monotonic age；沒有 sample 時 null。
  frame: TelemetryFrame | null;
};
export type InputModesValue = {
  sourceRevision: Counter;
  portId: BoundedId;
  typeId: BoundedId;
  currentModeId: BoundedId | null;
  modes: Array<{ modeId: BoundedId; name: string }>; // 0..8，name 1..80。
};
// 新增；三個 strict variants；不允許 mode 不相符的多餘 duration／degrees。
export type MotionBase = {
  actuatorId: Handle;
  power: number; // integer 1..100。
  direction: 1 | -1;
  brake: boolean;
};
export type MotionSpec =
  | (MotionBase & { mode: "jog" })
  | (MotionBase & { mode: "timed"; durationMs: number }) // integer 100..5000。
  | (MotionBase & { mode: "relative-angle"; degrees: number }); // integer 1..3600。
export type MotionSnapshot = {
  operationId: Handle;
  sessionId: Handle;
  revision: Counter;
  phase:
    | "preparing"
    | "running"
    | "stopping"
    | "completed"
    | "stopped"
    | "timeout"
    | "failed"
    | "unconfirmed";
  stage:
    | "prepared"
    | "waiting-read"
    | "preflight"
    | "uploading-helper"
    | "awaiting-helper"
    | "arming"
    | "moving"
    | "readback"
    | "terminal";
  startAccepted: boolean;
  stopRequested: boolean;
  dispatch: DispatchOutcome;
  movement: "not-started" | "completed" | "interrupted" | "timed-out" | "unknown";
  stopConfirmation: "not-required" | "pending" | "confirmed" | "unconfirmed";
  brakeRequired: boolean;
  elapsedMs: number; // nonnegative finite，開始 movement 後的 host monotonic elapsed。
  angle: number | null;
  displacement: number | null;
  preparedRemainingMs: number; // integer 0..5000；消耗／終態後為 0。
  error?: { code: PluginErrorCode; message: string; detail: DeviceErrorDetail };
};
// 新增；沒有 record bytes、校正或 storage path。
export type ReservationSnapshot = {
  reservationId: Handle;
  sessionId: Handle;
  revision: Counter;
  state: "active" | "ending" | "ended";
  channels: ChannelDefinition[]; // 1..4，固定 source identity／mode pins。
  firstSequence: Counter;
  lastSequence: Counter;
  reason:
    | "active"
    | "released"
    | "source-changed"
    | "disconnected"
    | "suspended"
    | "core-disconnect"
    | "retired"
    | "renderer-lost"
    | "limit"
    | "overflow";
};
export type DeviceErrorReason =
  | "provider-disabled"
  | "disconnected"
  | "quarantined"
  | "ui-scope-unavailable"
  | "unsupported-capability"
  | "foreground"
  | "recording"
  | "connecting"
  | "source-changing"
  | "unbound"
  | "joining"
  | "unsynced"
  | "not-holder"
  | "viewer"
  | "authority-changed"
  | "scope-expired"
  | "preflight-program-running"
  | "preflight-output-unknown"
  | "preflight-output-moving"
  | "motor-unavailable"
  | "source-changed"
  | "mode-unavailable"
  | "provider-failure"
  | "provider-contract"
  | "journal-unwritable"
  | "journal-corrupt"
  | "identity-ambiguous"
  | "readback-failed"
  | "stop-deadline"
  | "connection-lost"
  | "provider-stalled"
  | "deadline"
  | "cancelled"
  | "disabled"
  | "safe-mode"
  | "shutting-down"
  | "process-lost"
  | "protocol"
  | "provider-conflict";

import type { z } from "zod";
export declare const handleSchema: z.ZodType<Handle>;
export declare const counterSchema: z.ZodType<Counter>;
