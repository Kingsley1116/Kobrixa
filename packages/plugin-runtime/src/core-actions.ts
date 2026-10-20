import type {
  Handle, Counter, ResourceOwner, Text, BusinessResult, PermissionErrorDetail,
  ResourceErrorDetail, Result,
} from "@kobrixa/plugin-protocol";
// 新增 host-only 型別；3A DeviceRecoveryPort／DeviceSessionControlPort 與 3B-2 PersistenceParticipant
// 僅 type-only import 本定義，不各自定義 actionToken 或 scope variant。
export type CoreWindowScope = {
  hostEpoch: Handle;
  workbenchInstance: Handle;
};
export type CoreActionReference = {
  actionToken: Handle;
  scope: CoreWindowScope;
};
export type CoreRecoveryItem = {
  id: Handle;
  sourceKey: string;
  kind: "device" | "storage" | "process";
  state:
    | "preparing"
    | "running"
    | "stopping"
    | "completed"
    | "stopped"
    | "timeout"
    | "failed"
    | "unconfirmed"
    | "resolved"
    | "save-failed"
    | "interrupted"
    | "process-failed";
  title: Text;
  detail: Text;
  operation?: Handle;
  actions: {
    kind: "stop" | "reconcile" | "clear-resolved" | "retry-save" | "manage";
    id: Handle;
  }[];
};
export type CoreRecoverySnapshot = {
  hostEpoch: Handle;
  revision: Counter;
  items: CoreRecoveryItem[];
  nextCursor: Handle | null;
};

export interface CoreRecoveryPort {
  snapshot(input: { cursor?: Handle }): Promise<Result<CoreRecoverySnapshot>>;
  act(input: { itemId: Handle; actionId: Handle }): Promise<Result<CoreRecoverySnapshot>>;
  onChanged(listener: () => void): () => void;
}
export type UserPersistenceActionContext = { owner: ResourceOwner; actionRef: Handle };
// Core-only action ledger validation seam; B1-T3 declarations, B1-T5 implementation.
// Minting is deliberately absent from this consumer-facing host port.
export type CoreActionTarget =
  | { kind: "device-stop"; faultId: Handle; sessionId: Handle }
  | {
      kind: "device-reconcile";
      faultId: Handle;
      sessionId: Handle;
      identityEvidence: "serial-match" | "user-confirmed-device";
    }
  | { kind: "device-clear"; entryIds: Handle[] }
  | { kind: "device-disconnect"; sessionId: Handle }
  | { kind: "device-current-stop"; sessionId: Handle }
  | { kind: "persistence-retry" | "persistence-discard" | "persistence-export"; recovery: Handle };
export interface CoreActionValidationPort {
  claim(action: CoreActionReference, target: CoreActionTarget): boolean;
  isClaimed(action: CoreActionReference, target: CoreActionTarget): boolean;
  complete(action: CoreActionReference): void;
}
export interface UserPersistenceActionPort {
  claim(
    context: UserPersistenceActionContext,
    purpose: "storage.export" | "ui.clipboard",
  ): BusinessResult<{ action: Handle }, PermissionErrorDetail | ResourceErrorDetail>;
}
