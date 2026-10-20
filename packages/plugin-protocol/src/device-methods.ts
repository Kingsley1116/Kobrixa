import { z } from "zod";
import { namespacedIdSchema } from "./common.js";
import {
  businessResultSchema,
  deviceFailureDetailSchema,
  deviceErrorSchema,
  type DefinitionMap,
} from "./business-result.js";
import {
  handleSchema as h,
  counterSchema as c,
  boundedIdSchema as b,
  capabilitySchema,
  requirementCapabilitySchema,
  addressSchema,
  deviceCandidateSchema,
  deviceSessionSnapshotSchema as session,
  sourceCatalogSchema as sources,
  readSnapshotSchema as read,
  inputModesValueSchema,
  motionSpecSchema,
  reservationSnapshotSchema as reservation,
  telemetryFrameSchema as frame,
  overflowGapSchema,
} from "./device-types.js";
const empty = z.strictObject({});
export const authoritySnapshotSchema = z.strictObject({
  contextRef: h.nullable(),
  revision: c,
  state: z.enum(["local", "allowed", "restricted", "unbound"]),
  reason: z.enum([
    "local",
    "holder",
    "joining",
    "unsynced",
    "not-holder",
    "viewer",
    "window-lost",
    "unbound",
  ]),
});
export const deviceListValueSchema = z.strictObject({
  revision: c,
  providers: z
    .array(
      z.strictObject({
        providerId: namespacedIdSchema,
        state: z.enum(["available", "disabled", "conflict", "failed"]),
        capabilities: z.array(capabilitySchema).max(5),
      }),
    )
    .max(8),
  sessions: z.array(session).max(1),
});
export const motionSnapshotSchema = z.strictObject({
  operationId: h,
  sessionId: h,
  revision: c,
  phase: z.enum([
    "preparing",
    "running",
    "stopping",
    "completed",
    "stopped",
    "timeout",
    "failed",
    "unconfirmed",
  ]),
  stage: z.enum([
    "prepared",
    "waiting-read",
    "preflight",
    "uploading-helper",
    "awaiting-helper",
    "arming",
    "moving",
    "readback",
    "terminal",
  ]),
  startAccepted: z.boolean(),
  stopRequested: z.boolean(),
  dispatch: z.enum(["not-sent", "sent", "unknown"]),
  movement: z.enum(["not-started", "completed", "interrupted", "timed-out", "unknown"]),
  stopConfirmation: z.enum(["not-required", "pending", "confirmed", "unconfirmed"]),
  brakeRequired: z.boolean(),
  elapsedMs: z.number().min(0),
  angle: z.number().nullable(),
  displacement: z.number().nullable(),
  preparedRemainingMs: z.number().int().min(0).max(5000),
  error: deviceErrorSchema.exactOptional(),
});
export const deviceSubscriptionParamsSchema = z.discriminatedUnion("topic", [
  z.strictObject({ topic: z.literal("catalog") }),
  z.strictObject({ topic: z.literal("session"), sessionId: h }),
  z.strictObject({
    topic: z.literal("telemetry"),
    sessionId: h,
    channelIds: z.array(h).min(1).max(38),
    intervalMs: z.union([z.literal(500), z.literal(30000)]),
  }),
  z.strictObject({ topic: z.literal("motion"), operationId: h }),
  z.strictObject({ topic: z.literal("reservation"), reservationId: h }),
  z.strictObject({ topic: z.literal("authority"), contextRef: h }),
]);
const pair = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({
  params,
  result: businessResultSchema(value, deviceFailureDetailSchema),
});
const operation = z.strictObject({ operation: motionSnapshotSchema }),
  reserved = z.strictObject({ reservation });
const sessionValue = z.strictObject({ session }),
  sessionSources = z.strictObject({ session, sources });
const snapshot = z.union([
  deviceListValueSchema,
  sessionSources,
  read,
  motionSnapshotSchema,
  reservation,
  authoritySnapshotSchema,
]);
export const deviceRequestSchemas = {
  "devices/negotiate": pair(
    empty,
    z.strictObject({
      devicesContractVersion: z.literal(1),
      eventVersion: z.literal(1),
      capabilities: z
        .array(
          z.strictObject({
            capability: requirementCapabilitySchema,
            state: z.enum(["available", "provider-unavailable", "no-session", "unsupported"]),
            providerId: namespacedIdSchema.nullable(),
          }),
        )
        .max(10),
      requirementsSatisfied: z.boolean(),
    }),
  ),
  "devices/context": pair(
    z.strictObject({ contextRef: h.exactOptional() }),
    authoritySnapshotSchema,
  ),
  "devices/list": pair(empty, deviceListValueSchema),
  "devices/discover": pair(
    z.strictObject({ providerId: namespacedIdSchema }),
    z.strictObject({ candidates: z.array(deviceCandidateSchema).max(32) }),
  ),
  "devices/connect": pair(
    z.strictObject({
      target: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("candidate"), candidateId: h }),
        z.strictObject({
          kind: z.literal("wifi-address"),
          providerId: namespacedIdSchema,
          address: addressSchema,
        }),
      ]),
    }),
    sessionValue,
  ),
  "devices/disconnect": pair(z.strictObject({ sessionId: h }), sessionValue),
  "devices/session": pair(z.strictObject({ sessionId: h }), sessionSources),
  "devices/read": pair(
    z.strictObject({
      sessionId: h,
      channelIds: z.array(h).min(1).max(38),
      freshness: z.enum(["cached", "fresh"]),
    }),
    read,
  ),
  "devices/inputModes/query": pair(
    z.strictObject({ sessionId: h, portId: b, expectedSourceRevision: c }),
    inputModesValueSchema,
  ),
  "devices/inputModes/set": pair(
    z.strictObject({
      sessionId: h,
      portId: b,
      expectedSourceRevision: c,
      modeId: b,
      contextRef: h,
    }),
    z.strictObject({ sources, snapshot: read }),
  ),
  "devices/motion/prepare": pair(
    z.strictObject({
      sessionId: h,
      contextRef: h,
      motionScopeRef: h,
      motion: motionSpecSchema,
      gestureRef: h.exactOptional(),
    }),
    operation,
  ),
  "devices/motion/start": pair(z.strictObject({ operationId: h }), operation),
  "devices/motion/query": pair(z.strictObject({ operationId: h }), operation),
  "devices/motion/stop": pair(
    z.strictObject({ operationId: h, stopMode: z.enum(["configured", "brake"]) }),
    operation,
  ),
  "devices/recording/reserve": pair(
    z.strictObject({
      sessionId: h,
      channelIds: z.array(h).min(1).max(4),
      expectedSourceRevision: c,
    }),
    z.strictObject({ reservation, firstFrame: frame }),
  ),
  "devices/recording/query": pair(z.strictObject({ reservationId: h }), reserved),
  "devices/recording/read": pair(
    z.strictObject({ reservationId: h, afterSequence: c, limit: z.number().int().min(1).max(64) }),
    z.strictObject({
      reservation,
      frames: z.array(frame).max(64),
      gap: overflowGapSchema.nullable(),
      nextSequence: c,
      hasMore: z.boolean(),
    }),
  ),
  "devices/recording/release": pair(z.strictObject({ reservationId: h }), reserved),
  "devices/subscribe": pair(
    deviceSubscriptionParamsSchema,
    z.strictObject({ subscriptionId: h, sequence: z.literal(0), snapshot }),
  ),
  "events/ack": pair(
    z.strictObject({ subscriptionId: h, sequence: c }),
    z.strictObject({ acknowledged: c }),
  ),
  "events/unsubscribe": pair(
    z.strictObject({ subscriptionId: h }),
    z.strictObject({ removed: z.boolean() }),
  ),
} as const;
export type DeviceRequestMap = DefinitionMap<typeof deviceRequestSchemas>;
export type DeviceMethod = keyof DeviceRequestMap;
export type DeviceParams<M extends DeviceMethod> = DeviceRequestMap[M]["params"];
export type DeviceResult<M extends DeviceMethod> = DeviceRequestMap[M]["result"];
export type DeviceFailureDetail = z.output<typeof deviceFailureDetailSchema>;
export type DeviceSubscriptionParams = z.output<typeof deviceSubscriptionParamsSchema>;
export type DeviceSubscriptionSnapshot = z.output<typeof snapshot>;
export type AuthoritySnapshot = z.output<typeof authoritySnapshotSchema>;
export type DeviceListValue = z.output<typeof deviceListValueSchema>;
export type NegotiateValue = Extract<DeviceResult<"devices/negotiate">, { ok: true }>["value"];
export type RecordingReadValue = Extract<
  DeviceResult<"devices/recording/read">,
  { ok: true }
>["value"];
