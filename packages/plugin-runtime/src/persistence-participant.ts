import type { ResourceOwner, Handle, Counter, Timestamp, PersistenceResult, RecordId, RecordRevision, DrainReason, DrainRequest, PersistenceFailureDetail } from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
import type { CoreActionReference } from "./core-actions.js";
export type DrainReport = {
  state: "saved" | "retryable" | "checkpoint-only" | "uncertain";
  blocker: boolean;
  recovery?: Handle;
  retryAction?: Handle; // core recovery action descriptor ID，不是授權 token；不送插件
  pendingSettings: boolean;
  records: Array<{
    id: RecordId;
    committedRevision: RecordRevision | null; // 新建且尚未提交時為 null
    final: boolean;
    payload: "complete-staging" | "checkpoint-only" | "none";
    expiresAt?: number;
  }>;
  errors: Array<{ code: string; message: string; detail?: PersistenceFailureDetail }>;
};
export type PersistenceOwner = ResourceOwner; // type-only alias, not a new owner shape
// DrainReport itself has its sole definition in I-B2-8.1.
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
) => Promise<
  PersistenceResult<
    {
      status: "submitted" | "checkpoint-only";
      writes: Handle[];
    }
  >
>;
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
  // 同步對帳 ended／pending bindings，只封住該 recording target，不 freeze owner。
  endReservation(event: ReservationEnded, deadline: number): DrainOffer | null;
  // 同步關閉普通 admission，擷取已受理工作；可與 broker revocation 同一回合呼叫。
  freeze(
    owner: PersistenceOwner,
    reason: DrainReason,
    deadline: number,
    deviceDrain?: DeviceDrainGrant,
  ): DrainOffer;
  // 以獨立 drain request 喚醒仍健康的原 process；不延長 deadline。
  drain(offer: DrainOffer, dispatch: DrainDispatcher): Promise<DrainReport>;
  // owner 已死亡，不 dispatch；只處理 host 已持有的 ticket，保留 checkpoint。
  ownerLost(owner: PersistenceOwner): Promise<DrainReport>;
  // 接 core recovery snapshot；retry／discard 僅接受可信 UI action，不是 plugin RPC。
  recoverySnapshot(): PersistenceRecoverySnapshot;
  retry(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
  discard(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
}
