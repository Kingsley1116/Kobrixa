import type { z } from "zod";
import type { DefinitionMap, BusinessResult, DeviceErrorDetail, PermissionErrorDetail,
  ResourceErrorDetail } from "./business-result.js";
import type { Handle, CapabilityId, DeviceCandidate, DeviceSessionSnapshot, SourceCatalog,
  ReadSnapshot, InputModesValue, MotionSpec, MotionSnapshot, ReservationSnapshot,
  TelemetryFrame } from "./device-types.js";
export type DeviceFailureDetail = DeviceErrorDetail | PermissionErrorDetail | ResourceErrorDetail;
export type DeviceSubscriptionParams =
  | { topic: "catalog" }
  | { topic: "session"; sessionId: Handle }
  | { topic: "telemetry"; sessionId: Handle; channelIds: Handle[]; intervalMs: 500 | 30000 }
  | { topic: "motion"; operationId: Handle }
  | { topic: "reservation"; reservationId: Handle }
  | { topic: "authority"; contextRef: Handle };
export type AuthoritySnapshot = {
  contextRef: Handle | null; revision: number;
  state: "local" | "allowed" | "restricted" | "unbound";
  reason: "local" | "holder" | "joining" | "unsynced" | "not-holder" | "viewer" | "window-lost" | "unbound";
};
export type DeviceListValue = { revision: number; providers: Array<{
  providerId: string; state: "available" | "disabled" | "conflict" | "failed";
  capabilities: CapabilityId[];
}>; sessions: DeviceSessionSnapshot[] };
export type NegotiateValue = { devicesContractVersion: 1; eventVersion: 1;
  capabilities: Array<{ capability: string;
    state: "available" | "provider-unavailable" | "no-session" | "unsupported";
    providerId: string | null }>; requirementsSatisfied: boolean };
export type RecordingReadValue = { reservation: ReservationSnapshot; frames: TelemetryFrame[];
  gap: { fromSequence: number; toSequence: number; reason: "overflow" } | null;
  nextSequence: number; hasMore: boolean };
export type DeviceSubscriptionSnapshot = DeviceListValue | { session: DeviceSessionSnapshot;
  sources: SourceCatalog } | ReadSnapshot | MotionSnapshot | ReservationSnapshot | AuthoritySnapshot;
type D<P, V> = { params: z.ZodType<P, P>; result: z.ZodType<BusinessResult<V, DeviceFailureDetail>, BusinessResult<V, DeviceFailureDetail>> };
export declare const deviceRequestSchemas: {
  "devices/negotiate": D<Record<string, never>, NegotiateValue>;
  "devices/context": D<{ contextRef?: Handle }, AuthoritySnapshot>;
  "devices/list": D<Record<string, never>, DeviceListValue>;
  "devices/discover": D<{ providerId: string }, { candidates: DeviceCandidate[] }>;
  "devices/connect": D<{ target: { kind: "candidate"; candidateId: Handle } |
    { kind: "wifi-address"; providerId: string; address: string } }, { session: DeviceSessionSnapshot }>;
  "devices/disconnect": D<{ sessionId: Handle }, { session: DeviceSessionSnapshot }>;
  "devices/session": D<{ sessionId: Handle }, { session: DeviceSessionSnapshot; sources: SourceCatalog }>;
  "devices/read": D<{ sessionId: Handle; channelIds: Handle[]; freshness: "cached" | "fresh" }, ReadSnapshot>;
  "devices/inputModes/query": D<{ sessionId: Handle; portId: string; expectedSourceRevision: number }, InputModesValue>;
  "devices/inputModes/set": D<{ sessionId: Handle; portId: string; expectedSourceRevision: number;
    modeId: string; contextRef: Handle }, { sources: SourceCatalog; snapshot: ReadSnapshot }>;
  "devices/motion/prepare": D<{ sessionId: Handle; contextRef: Handle; motionScopeRef: Handle;
    motion: MotionSpec; gestureRef?: Handle }, { operation: MotionSnapshot }>;
  "devices/motion/start": D<{ operationId: Handle }, { operation: MotionSnapshot }>;
  "devices/motion/query": D<{ operationId: Handle }, { operation: MotionSnapshot }>;
  "devices/motion/stop": D<{ operationId: Handle; stopMode: "configured" | "brake" }, { operation: MotionSnapshot }>;
  "devices/recording/reserve": D<{ sessionId: Handle; channelIds: Handle[]; expectedSourceRevision: number },
    { reservation: ReservationSnapshot; firstFrame: TelemetryFrame }>;
  "devices/recording/query": D<{ reservationId: Handle }, { reservation: ReservationSnapshot }>;
  "devices/recording/read": D<{ reservationId: Handle; afterSequence: number; limit: number }, RecordingReadValue>;
  "devices/recording/release": D<{ reservationId: Handle }, { reservation: ReservationSnapshot }>;
  "devices/subscribe": D<DeviceSubscriptionParams, { subscriptionId: Handle; sequence: 0; snapshot: DeviceSubscriptionSnapshot }>;
  "events/ack": D<{ subscriptionId: Handle; sequence: number }, { acknowledged: number }>;
  "events/unsubscribe": D<{ subscriptionId: Handle }, { removed: boolean }>;
};
export type DeviceRequestMap = DefinitionMap<typeof deviceRequestSchemas>;
export type DeviceMethod = keyof DeviceRequestMap;
export type DeviceParams<M extends DeviceMethod> = DeviceRequestMap[M]["params"];
export type DeviceResult<M extends DeviceMethod> = DeviceRequestMap[M]["result"];
