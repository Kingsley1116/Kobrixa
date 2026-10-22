import type { DeviceResourceParticipant, DeviceRequirement, Principal, AuthorityBinding } from "./device-resources.js";
import type { PersistenceParticipant, DrainDispatcher } from "./persistence-participant.js";
import type { CoreWindowScope } from "./core-actions.js";
import type { RpcPeer, DrainReason, ResourceOwner, Handle, Permission, ContextCommandDeclaration, CommandInvocation, CommandValue, Result } from "@kobrixa/plugin-protocol";
import type { UiCatalogPort } from "./ui-host-ports.js";
export type OwnerRetirement = Exclude<DrainReason, "reservation-ended"> | "crashed";
export interface Stage3ChannelContext {
  peer: RpcPeer;
  owner: ResourceOwner;
  principal(): Principal;
  requirements: readonly DeviceRequirement[];
}
export interface Stage3ChannelBinding {
  initialized(signal: AbortSignal): Promise<void>;
  ready(signal: AbortSignal): Promise<void>;
  dispose(): void;
}
export interface Stage3HostAttachment {
  hostEpoch: Handle;
  principal(owner: ResourceOwner): Principal;
  hasPermission(owner: ResourceOwner, permission: Permission): boolean;
  requirements(owner: ResourceOwner): readonly DeviceRequirement[] | null;
  bindChannel(context: Stage3ChannelContext): Stage3ChannelBinding;
  retireResources(owner: ResourceOwner, reason: OwnerRetirement): Promise<void>;
}
export interface UiRuntimeAttachment {
  activateInitialized(sourceKey: string, signal: AbortSignal): Promise<Stage3ChannelContext>;
  ready(owner: ResourceOwner, signal: AbortSignal): Promise<void>;
  current(owner: ResourceOwner): boolean;
  owners(): readonly ResourceOwner[];
  context(owner: ResourceOwner, scope: CoreWindowScope): AuthorityBinding;
  commands(sourceKey: string): readonly ContextCommandDeclaration[];
  invoke(owner: ResourceOwner, invocation: CommandInvocation, signal: AbortSignal): Promise<Result<CommandValue>>;
  dispatchDrain: DrainDispatcher;
}
export interface Stage3RuntimePorts {
  device: DeviceResourceParticipant;
  persistence: PersistenceParticipant;
  ui: UiCatalogPort;
}
