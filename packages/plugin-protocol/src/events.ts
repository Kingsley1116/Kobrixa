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

import type { UiEvent } from "./ui-types.js";
import type { SettingsRevision, Version, SettingKey } from "./settings.js";

export type Stage3EventData = {
  [K in keyof typeof deviceEventDataSchemas]: z.output<(typeof deviceEventDataSchemas)[K]>;
} & {
  [K in UiEvent["kind"]]: Extract<UiEvent, { kind: K }>["data"];
} & {
  "settings.changed": {
    revision: SettingsRevision;
    schemaVersion: Version;
    changedKeys: SettingKey[];
    cause: "update" | "reset" | "migrate" | "import";
  };
};

import { z } from "zod";
import {
  handleSchema as h,
  resourceOwnerSchema,
  deviceSessionSnapshotSchema as session,
  readSnapshotSchema,
  telemetryFrameSchema as frame,
  reservationSnapshotSchema,
  overflowGapSchema,
} from "./device-types.js";
import {
  deviceListValueSchema,
  authoritySnapshotSchema,
  motionSnapshotSchema,
} from "./device-methods.js";
const base = {
  version: z.literal(1),
  subscriptionId: h,
  owner: resourceOwnerSchema,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const event = <K extends EventKindV150, D extends z.ZodType>(
  kind: K,
  delivery: "control" | "telemetry",
  data: D,
) => z.strictObject({ ...base, kind: z.literal(kind), delivery: z.literal(delivery), data });
export const eventEnvelopeSchema = z.discriminatedUnion("kind", [
  event("devices.catalog", "control", deviceListValueSchema),
  event("devices.session", "control", z.strictObject({ session, sourcesChanged: z.boolean() })),
  event(
    "devices.telemetry",
    "telemetry",
    z.strictObject({ sessionId: h, frames: z.array(frame).max(64), snapshot: readSnapshotSchema }),
  ),
  event("devices.motion", "control", motionSnapshotSchema),
  event("devices.reservation", "control", reservationSnapshotSchema),
  event(
    "devices.recordingFrames",
    "telemetry",
    z.strictObject({
      reservationId: h,
      frames: z.array(frame).max(64),
      gap: overflowGapSchema.nullable(),
    }),
  ),
  event("devices.authority", "control", authoritySnapshotSchema),
  event(
    "events.resyncRequired",
    "control",
    z.strictObject({ reason: z.enum(["overflow", "ack-timeout"]), affected: z.array(h).max(32) }),
  ),
]);
export type DeviceEvent = z.output<typeof eventEnvelopeSchema>;

export const deviceEventDataSchemas = {
  "devices.catalog": eventEnvelopeSchema.options[0].shape.data,
  "devices.session": eventEnvelopeSchema.options[1].shape.data,
  "devices.telemetry": eventEnvelopeSchema.options[2].shape.data,
  "devices.motion": eventEnvelopeSchema.options[3].shape.data,
  "devices.reservation": eventEnvelopeSchema.options[4].shape.data,
  "devices.recordingFrames": eventEnvelopeSchema.options[5].shape.data,
  "devices.authority": eventEnvelopeSchema.options[6].shape.data,
  "events.resyncRequired": eventEnvelopeSchema.options[7].shape.data,
} as const;
