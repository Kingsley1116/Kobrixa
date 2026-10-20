import type { Permission, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { PluginManager, Principal, ProfileWriterLock, DeviceRequirement,
  Stage3HostAttachment, Stage3RuntimePorts } from "@kobrixa/plugin-runtime";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { StartPluginsOptions, PluginController } from "../plugins/controller.js";
import type { CoreActionLedger } from "../plugins/core-recovery.js";
import type { AuthorityPort } from "./authority-port.js";
import type { JournalPort } from "./journal-port.js";
import type { DeviceBrokerPort, LegacyOperationPort, DeviceOperationGate } from "./broker-port.js";
import type { ProviderCatalogPort, BuiltinDeviceProvider, DeviceConnectionPolicy } from "./provider.js";
export interface DesktopFoundationOptions {
  profile: ProfileWriterLock;
  authority: AuthorityPort;
  journal: JournalPort;
  coreActions: CoreActionLedger;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
  requirements: (owner: ResourceOwner) => readonly DeviceRequirement[] | null;
  connectionPolicy: () => DeviceConnectionPolicy;
  operationGate: DeviceOperationGate;
  providerFactory?: (catalog: ProviderCatalogPort) => BuiltinDeviceProvider;
}
export type DesktopFoundation = {
  broker: DeviceBrokerPort & LegacyOperationPort;
  attachProvider(manager: Pick<PluginManager, "state" | "onEvent">): void;
  dispose(): Promise<void>;
};
export declare function createDesktopFoundation(input: DesktopFoundationOptions): Promise<DesktopFoundation>;
export interface DesktopMainCompositionInput {
  createFoundation: typeof createDesktopFoundation;
  foundationOptions: DesktopFoundationOptions;
  plugins: Omit<StartPluginsOptions, "stage3" | "stage3Host" | "onStage3Runtime">;
  principal: Stage3HostAttachment["principal"];
  scope(): CoreWindowScope;
  currentScope(scope: CoreWindowScope): boolean;
  legacyFlush(reason: "close" | "update" | "suspend"): Promise<void>;
  report(error: unknown): void;
}
export interface DesktopMainComposition {
  foundation: DesktopFoundation;
  plugins: PluginController;
  stage3: Stage3RuntimePorts;
  stage3Host: Stage3HostAttachment;
  dispose(): Promise<void>;
}

import type { Handle } from "@kobrixa/plugin-protocol";
import type { OwnerRetirement, CoreActionReference, DeviceResourceParticipant,
  DeviceSessionControlPort, ReservationBindingPort, PersistenceParticipant, DrainDispatcher } from "@kobrixa/plugin-runtime";
export interface CoordinatorInput {
  ports: Stage3RuntimePorts;
  resources: DeviceResourceParticipant;
  sessions: DeviceSessionControlPort;
  reservations: ReservationBindingPort;
  persistence: PersistenceParticipant;
  dispatch: DrainDispatcher;
  alive(owner: ResourceOwner): boolean;
  owners(): readonly ResourceOwner[];
  now(): number;
  shutdown(): Promise<void>;
  legacyFlush(reason: "close" | "update" | "suspend"): Promise<void>;
  report(error: unknown): void;
}
export declare class LifecycleCoordinator {
  constructor(input: CoordinatorInput);
  retire(owner: ResourceOwner, reason: OwnerRetirement, deadlineMonotonicMs?: number): Promise<void>;
  disconnect(sessionId: Handle, action: CoreActionReference): Promise<void>;
  suspend(sessionId: Handle): Promise<void>;
  resume(sessionId: Handle): Promise<void>;
  close(reason: "close" | "update"): Promise<void>;
  dispose(): void;
}
