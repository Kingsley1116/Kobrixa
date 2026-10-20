import type { Handle, ResourceOwner, Counter } from "./device-types.js";
// 新增通用通知名稱 events/deliver；kind 決定 data 的 strict schema。
export type EventKindV150 =
  | "devices.catalog"
  | "devices.session"
  | "devices.telemetry"
  | "devices.motion"
  | "devices.reservation"
  | "devices.recordingFrames"
  | "devices.authority"
  | "events.resyncRequired";
export type EventKind = EventKindV150; // 後續 API 批次由唯一 registry 擴充。
export type EventEnvelope<Data> = {
  version: 1;
  subscriptionId: Handle;
  owner: ResourceOwner;
  sequence: Counter; // 每 subscription 從 1 增加。
  delivery: "control" | "telemetry";
  kind: EventKind; // 本 API 批次 event registry 的閉合 enum，與 data schema 配對。
  data: Data;
};

import type { z } from "zod";
import type { DeviceSessionSnapshot, ReadSnapshot, TelemetryFrame, MotionSnapshot, ReservationSnapshot } from "./device-types.js";
import type { DeviceListValue, AuthoritySnapshot, RecordingReadValue } from "./device-methods.js";
import type { UiEvent } from "./ui-types.js";
import type { SettingsRevision, Version, SettingKey } from "./settings.js";

// Declaration-only data schemas. A-T1 supplies validators; future batches remain
// type projections until their publication and never enter the 1.4.0 registry.
export declare const deviceEventDataSchemas: {
  "devices.catalog": z.ZodType<DeviceListValue>;
  "devices.session": z.ZodType<{ session: DeviceSessionSnapshot; sourcesChanged: boolean }>;
  "devices.telemetry": z.ZodType<{ sessionId: Handle; frames: TelemetryFrame[]; snapshot: ReadSnapshot }>;
  "devices.motion": z.ZodType<MotionSnapshot>;
  "devices.reservation": z.ZodType<ReservationSnapshot>;
  "devices.recordingFrames": z.ZodType<{ reservationId: Handle; frames: TelemetryFrame[]; gap: RecordingReadValue["gap"] }>;
  "devices.authority": z.ZodType<AuthoritySnapshot>;
  "events.resyncRequired": z.ZodType<{ reason: "overflow" | "ack-timeout"; affected: Handle[] }>;
};
export type Stage3EventData = {
  [K in keyof typeof deviceEventDataSchemas]: z.output<(typeof deviceEventDataSchemas)[K]>;
} & {
  [K in UiEvent["kind"]]: Extract<UiEvent, { kind: K }>["data"];
} & {
  "settings.changed": { revision: SettingsRevision; schemaVersion: Version;
    changedKeys: SettingKey[]; cause: "update" | "reset" | "migrate" | "import" };
};
