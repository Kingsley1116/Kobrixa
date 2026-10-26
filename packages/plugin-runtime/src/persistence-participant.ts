import type {
  PersistenceResult,
  Counter,
  DrainReason,
  DrainRequest,
  Handle,
  PersistenceFailureDetail,
  RecordId,
  RecordRevision,
  ResourceOwner,
  Timestamp,
} from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
import type { CoreActionReference } from "./core-actions.js";
export type PersistenceOwner = ResourceOwner;
export type DrainOffer = Readonly<{
  owner: PersistenceOwner;
  reason: DrainReason;
  deadlineMonotonicMs: number;
  token: Handle;
  checkpoints: readonly DrainRequest["checkpoints"][number][];
  writes: readonly DrainRequest["writes"][number][];
  acceptedTickets: readonly Handle[];
}>;
export type DrainDispatcher = (
  owner: PersistenceOwner,
  request: DrainRequest,
  signal: AbortSignal,
) => Promise<PersistenceResult<{ status: "submitted" | "checkpoint-only"; writes: Handle[] }>>;
export type DrainReport = {
  state: "saved" | "retryable" | "checkpoint-only" | "uncertain";
  blocker: boolean;
  recovery?: Handle;
  retryAction?: Handle;
  pendingSettings: boolean;
  records: Array<{
    id: RecordId;
    committedRevision: RecordRevision | null;
    final: boolean;
    payload: "complete-staging" | "checkpoint-only" | "none";
    expiresAt?: number;
  }>;
  errors: Array<{ code: string; message: string; detail?: PersistenceFailureDetail }>;
};
export type PersistenceRecoverySnapshot = {
  revision: Counter;
  items: Array<{
    id: Handle;
    sourceKey: string;
    pluginId: string;
    recordId: RecordId | null;
    committedRevision: RecordRevision | null;
    state: DrainReport["state"];
    payload: "complete-staging" | "checkpoint-only" | "none";
    expiresAt?: Timestamp;
    actions: Array<{ id: Handle; kind: "retry" | "export" | "discard" }>;
  }>;
};
export interface PersistenceParticipant {
  endReservation(event: ReservationEnded, deadline: number): DrainOffer | null;
  freeze(
    owner: PersistenceOwner,
    reason: DrainReason,
    deadline: number,
    deviceDrain?: DeviceDrainGrant,
  ): DrainOffer;
  drain(offer: DrainOffer, dispatch: DrainDispatcher): Promise<DrainReport>;
  ownerLost(owner: PersistenceOwner): Promise<DrainReport>;
  recoverySnapshot(): PersistenceRecoverySnapshot;
  retry(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
  discard(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
}
