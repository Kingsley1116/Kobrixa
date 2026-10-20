import type { Permission, SettingsRequestMap, StorageRequestMap, PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
import type { Principal, PersistenceParticipant, ProfileWriterLock, ReservationBindingPort, UserPersistenceActionPort, CoreActionValidationPort } from "@kobrixa/plugin-runtime";
import type { PersistenceBackend } from "./engine-port.js";
import type { BoundSettingsService } from "@kobrixa/plugin-runtime";
import type { PersistenceRecoveryHostPort } from "./recovery-port.js";
import type { PersistenceActionAdapter } from "./actions.js";
export type PersistenceRequestMap = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
export interface PersistenceHost {
  readonly participant: PersistenceParticipant;
  readonly settings: BoundSettingsService;
  readonly recovery: PersistenceRecoveryHostPort;
  request<M extends keyof PersistenceRequestMap>(
    principal: Principal,
    method: M,
    params: PersistenceRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<PersistenceRequestMap[M]["result"]>;
  dispose(): Promise<void>;
}

export declare function createPersistenceHost(input: {
  profile: ProfileWriterLock;
  composition: PersistenceCompositionInput;
  reservations: ReservationBindingPort;
  actions: UserPersistenceActionPort;
  actionAdapter: PersistenceActionAdapter;
  coreActions: CoreActionValidationPort;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
}): Promise<PersistenceHost>;

import type { ResourceOwner, Sha256, UiOwner, SettingsResourceV1 } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope, CommonEventLedgerPort, DrainDispatcher } from "@kobrixa/plugin-runtime";
import type { LegacyImportHostPort } from "./import-sources.js";
export interface PersistenceSourcePort {
  current(owner:ResourceOwner): boolean;
  settings(input:{sourceKey:string; resourceDigest:Sha256}): Promise<{
    owner:UiOwner; resource:SettingsResourceV1; validationDigest:Sha256;
  }|null>;
  coreOwner(input:{sourceKey:string; scope:CoreWindowScope}): ResourceOwner|null;
}

export interface PersistenceCompositionInput {
  backend:PersistenceBackend;
  sources:PersistenceSourcePort;
  events:CommonEventLedgerPort;
  dispatchDrain:DrainDispatcher;
  imports:LegacyImportHostPort;
}
