import type { Handle, Counter, Timestamp, ResourceOwner, MotionSnapshot, ReservationSnapshot, DeviceErrorReason } from "@kobrixa/plugin-protocol";
import type { BusinessResult, DispatchOutcome, DeviceErrorDetail, PermissionErrorDetail, ResourceErrorDetail } from "@kobrixa/plugin-protocol";
import type { CoreActionReference } from "./core-actions.js";
export type OperationClass =
  | "connection"
  | "passive-read"
  | "mode-read"
  | "mode-write"
  | "finite-motion"
  | "program-launch"
  | "program-stop"
  | "file-read"
  | "file-write"
  | "deployment"
  | "recording-reservation"
  | "safety-stop"
  | "reconciliation";
export type PhysicalIdentity = {
  providerId: string;
  family: string; // BoundedId，EV3 為 ev3。
  basis: "serial" | "endpoint" | "unknown";
  digest: string | null; // SHA-256 hex，固定 64；不存 native path。
  strength: "stable" | "session-only";
};
export type AuthorityBinding = { ref: Handle; epoch: Handle } | null;
export type Principal =
  | { kind: "plugin"; owner: ResourceOwner; authorityContext: AuthorityBinding }
  | (Extract<JournalOwner, { kind: "core" }> & { authorityContext: AuthorityBinding });
// 新增 journal schema；不屬於 devices RPC，也不是可重播命令。
export type JournalOwner =
  | { kind: "plugin"; owner: ResourceOwner }
  | {
      kind: "core";
      adapter:
        | "deployment"
        | "program"
        | "remote-files"
        | "monitor"
        | "battery"
        | "motor"
        | "lab"
        | "recovery";
      hostEpoch: Handle;
      workbenchInstance: Handle;
    };
export type SafetyFaultEntry = {
  id: Handle;
  revision: Counter;
  owner: JournalOwner;
  providerId: string;
  providerGeneration: Counter;
  physical: PhysicalIdentity;
  sessionId: Handle;
  operationId: Handle;
  operationClass: "finite-motion" | "program-launch" | "safety-stop";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  state: "pending" | "active-program" | "unconfirmed" | "resolved";
  dispatch: DispatchOutcome;
  movement: MotionSnapshot["movement"];
  stopRequested: boolean;
  stopConfirmation: "not-required" | "pending" | "confirmed" | "unconfirmed";
  cause: DeviceErrorReason | "none" | "host-restarted";
  resolution: null | {
    kind: "not-issued" | "confirmed-on-original-session" | "observed-idle";
    at: Timestamp;
    sessionId: Handle;
    identityEvidence: "same-session" | "serial-match" | "user-confirmed-device";
  };
};
export type FaultJournalDocument = {
  schemaVersion: 1;
  revision: Counter;
  entries: SafetyFaultEntry[];
  integrity: { algorithm: "sha256"; digest: string }; // 64 lowercase hex。
};
export type MotionScopeBinding = {
  owner: ResourceOwner;
  contextRef: Handle;
  panelInstance: Handle;
  uiResourceGeneration: Counter;
  workbenchInstance: Handle;
};
export interface DeviceIntentPort {
  bindMotionScope(binding: MotionScopeBinding): Handle;
  pulsePanel(scope: Handle, trustedSequence: Counter): void;
  beginGesture(scope: Handle, trustedSequence: Counter): Handle;
  pulseGesture(gesture: Handle, trustedSequence: Counter): void;
  endGesture(gesture: Handle, reason: "released" | "cancelled"): void;
  revokeScope(
    scope: Handle,
    reason: "hidden" | "closed" | "window-lost" | "resource-retired",
  ): void;
}
export type RetirementReason =
  "disabled" | "reload" | "crashed" | "renderer-lost" | "shutdown" | "safe-mode";
export type DeviceDrainGrant = {
  owner: ResourceOwner;
  reservationId: Handle;
  lastSequence: Counter;
  expiresMonotonicMs: number;
};
export type DeviceDisposition = {
  stopConfirmed: boolean;
  faultIds: Handle[];
  journalCommitted: boolean;
};
export interface DeviceResourceParticipant {
  retire(
    owner: ResourceOwner,
    reason: RetirementReason,
  ): {
    drain: DeviceDrainGrant | null;
    settled: Promise<DeviceDisposition>;
  };
  retireProvider(providerId: string, providerGeneration: Counter): Promise<DeviceDisposition>;
  beginShutdown(): Promise<DeviceDisposition>;
}
export type ReservationBinding = {
  owner: ResourceOwner;
  reservationId: Handle;
  sessionId: Handle;
  providerGeneration: Counter;
};
export type ReservationEnded = ReservationBinding & {
  reason: Exclude<ReservationSnapshot["reason"], "active">;
  lastSequence: Counter;
  endedMonotonicMs: number; // 首次 end 的 host clock；重複通知不變。
  drain: DeviceDrainGrant | null;
};
export interface ReservationBindingPort {
  validate(owner: ResourceOwner, reservationId: Handle): ReservationBinding | null;
  onEnded(listener: (event: ReservationEnded) => void): () => void;
}
export type SessionQuiesceCause =
  { reason: "core-disconnect"; action: CoreActionReference } | { reason: "suspended" };
export type SessionQuiescence = {
  sessionId: Handle;
  ended: readonly ReservationEnded[];
  settled: Promise<DeviceDisposition>;
};
export interface DeviceSessionControlPort {
  quiesce(sessionId: Handle, cause: SessionQuiesceCause): SessionQuiescence;
  disconnect(
    sessionId: Handle,
    action: CoreActionReference,
  ): Promise<
    BusinessResult<
      { sessionId: Handle; disconnected: true },
      DeviceErrorDetail | PermissionErrorDetail | ResourceErrorDetail
    >
  >;
  resume(sessionId: Handle): void;
}
export type DeviceRecoverySnapshot = {
  revision: Counter;
  journalHealth: "ready" | "unwritable" | "corrupt" | "full";
  faults: SafetyFaultEntry[];
  blockers: Handle[];
};
import type { DeviceFailureDetail } from "@kobrixa/plugin-protocol";
export type { DeviceFailureDetail } from "@kobrixa/plugin-protocol";
export interface DeviceRecoveryPort {
  snapshot(): DeviceRecoverySnapshot;
  subscribe(listener: (snapshot: DeviceRecoverySnapshot) => void): () => void;
  stopCurrent(input: {
    faultId: Handle;
    sessionId: Handle;
    action: CoreActionReference;
  }): Promise<BusinessResult<DeviceRecoverySnapshot, DeviceFailureDetail>>;
  reconcile(input: {
    faultId: Handle;
    sessionId: Handle;
    action: CoreActionReference;
    identityEvidence: "serial-match" | "user-confirmed-device";
  }): Promise<BusinessResult<DeviceRecoverySnapshot, DeviceFailureDetail>>;
  clearResolved(input: {
    entryIds: Handle[];
    action: CoreActionReference;
  }): Promise<BusinessResult<DeviceRecoverySnapshot, DeviceFailureDetail>>;
}

import type { EventEnvelope, Stage3EventData } from "@kobrixa/plugin-protocol";
import type { Stage3PluginErrorCode, PluginErrorCodeV150 } from "@kobrixa/plugin-protocol";
export type Stage3Event =
  | { [K in keyof Stage3EventData]: { kind: K; data: Stage3EventData[K] } }[keyof Stage3EventData];
// Stage3EventData is A-T1 events.ts's type-only map of the exact A/B1/B2 event data schemas.
export type Stage3EventEnvelope = Omit<EventEnvelope<unknown>, "kind" | "data"> & Stage3Event;
export interface CommonEventLedgerPort {
  diagnostics(): Readonly<{ subscriptions: number; queuedEvents: number; queuedBytes: number }>;
  create(owner: ResourceOwner): BusinessResult<{ subscriptionId: Handle; sequence: 0 }, ResourceErrorDetail>;
  owns(owner: ResourceOwner, subscriptionId: Handle): boolean;
  publish(owner: ResourceOwner, subscriptionId: Handle, event: Stage3Event,
    delivery: "control" | "telemetry"): BusinessResult<{ accepted: true }, ResourceErrorDetail>;
  activate(owner: ResourceOwner, subscriptionId: Handle): void;
  resync(owner: ResourceOwner, subscriptionId: Handle): BusinessResult<{ accepted: true }, ResourceErrorDetail>;
  snapshot<T,D,C extends Stage3PluginErrorCode>(owner: ResourceOwner, subscriptionId: Handle,
    read: () => BusinessResult<T,D,C>): BusinessResult<{ sequence: Counter; snapshot: T }, D | ResourceErrorDetail, C | PluginErrorCodeV150>;
  ack(owner: ResourceOwner, subscriptionId: Handle, sequence: Counter): BusinessResult<{ acknowledged: Counter }, ResourceErrorDetail>;
  unsubscribe(owner: ResourceOwner, subscriptionId: Handle): BusinessResult<{ removed: boolean }, ResourceErrorDetail>;
  closeAfterControl(owner: ResourceOwner, subscriptionId: Handle): void;
  onRemoved(listener: (subscriptionId: Handle) => void): () => void;
}
export interface DeviceChannelAttachment {
  readonly owner: ResourceOwner;
  negotiated(domain: "devices" | "ui" | "settings", version: 1): void;
  activate(subscriptionId: Handle): void;
  abandon(subscriptionId: Handle): void;
  dispose(): void;
}

export type DeviceRequirement = Readonly<{ capability: string; required: boolean }>;
