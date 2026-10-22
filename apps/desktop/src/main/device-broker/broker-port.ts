import type { Handle, Counter, ResourceOwner, ReadSnapshot, SourceCatalog, BusinessResult, DeviceRequestMap, Permission } from "@kobrixa/plugin-protocol";
import type { Principal, DeviceIntentPort, ReservationBindingPort, DeviceSessionControlPort, DeviceResourceParticipant, DeviceRecoveryPort, DeviceRecoverySnapshot, DeviceFailureDetail, DeviceRequirement, CommonEventLedgerPort, Stage3EventEnvelope, DeviceChannelAttachment, OperationClass, CoreActionReference, ProfileWriterLock, CoreActionValidationPort } from "@kobrixa/plugin-runtime";
export type { DeviceRecoveryPort, DeviceRecoverySnapshot, DeviceFailureDetail } from "@kobrixa/plugin-runtime";
import type { BuiltinDeviceProvider, LegacyProviderRequest, LegacyProviderValue, ProviderOutcome, ProviderCatalogPort, DeviceConnectionPolicy } from "./provider.js";
import type { AuthorityPort } from "./authority-port.js";
import type { JournalPort } from "./journal-port.js";
export type {DeviceRequirement,CommonEventLedgerPort,Stage3Event,Stage3EventEnvelope,DeviceChannelAttachment} from "@kobrixa/plugin-runtime";
export type CorePrincipal=Extract<Principal,{kind:"core"}>;
export type DeviceOperationGate=(input:{principal:Principal;operationClass:OperationClass;sessionId:Handle|null;phase:"admission"|"continuation"})=>BusinessResult<null,DeviceFailureDetail>;
export interface CoreTelemetrySubscription {
  readonly initial:{snapshot:ReadSnapshot;sources:SourceCatalog};
  activate():void;ack(sequence:Counter):void;dispose():Promise<void>;
}
export type DeviceMethod = keyof DeviceRequestMap;
export type DeviceParams<M extends DeviceMethod> = DeviceRequestMap[M]["params"];
export type DeviceResult<M extends DeviceMethod> = DeviceRequestMap[M]["result"];
export interface DeviceBrokerPort {
  readonly intent: DeviceIntentPort;
  readonly reservations: ReservationBindingPort;
  readonly sessions: DeviceSessionControlPort;
  readonly resources: DeviceResourceParticipant;
  readonly recovery: DeviceRecoveryPort;
  request<M extends DeviceMethod>(
    principal: Principal,
    method: M,
    params: DeviceParams<M>,
    signal: AbortSignal,
  ): Promise<DeviceResult<M>>;
  legacy(
    principal: Principal,
    sessionId: Handle,
    request: LegacyProviderRequest,
    signal: AbortSignal,
  ): Promise<ProviderOutcome<LegacyProviderValue>>;
  registerProvider(provider: BuiltinDeviceProvider): () => void;
  readonly events: CommonEventLedgerPort;
  providerCatalog(providerId: string): ProviderCatalogPort;
  attachChannel(input: {owner: ResourceOwner; principal: () => Principal; send: (event: Stage3EventEnvelope) => void}): DeviceChannelAttachment;
  subscribeCoreTelemetry(input: {principal: CorePrincipal; sessionId: Handle; channelIds: readonly Handle[]; intervalMs: 500 | 30000; receive: (value: {sequence: Counter; snapshot: ReadSnapshot; sources: SourceCatalog}) => void}): Promise<CoreTelemetrySubscription>;
  reconnectForRecovery(input: {previousSessionId: Handle; signal: AbortSignal}): Promise<BusinessResult<{sessionId: Handle}, DeviceFailureDetail>>;
  stopCurrentDevice(input: {sessionId: Handle; action: CoreActionReference}): Promise<BusinessResult<DeviceRecoverySnapshot, DeviceFailureDetail>>;
}
// A-T2 broker-port.ts; A-T5 consumes; never exported to a plugin.
export interface LegacyOperation {
  readonly operationId: Handle;
  execute(request: LegacyProviderRequest): Promise<ProviderOutcome<LegacyProviderValue>>;
  renewConfirmation(): void;
  finish(): Promise<void>;
  cancel(): Promise<void>;
}
export interface LegacyOperationPort {
  begin(input: {
    principal: Principal;
    sessionId: Handle;
    operationClass: "file-read" | "file-write" | "deployment" | "program-launch";
    signal: AbortSignal;
  }): Promise<LegacyOperation>;
}
// A-T2, main/device-broker/broker-port.ts. The callback checks current grants, not cached booleans.
export declare function createDeviceBroker(input: {
  authority: AuthorityPort;
  journal: JournalPort;
  profile: ProfileWriterLock;
  coreActions: CoreActionValidationPort;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
  requirements: (owner: ResourceOwner) => readonly DeviceRequirement[] | null;
  operationGate: DeviceOperationGate;
  connectionPolicy: () => DeviceConnectionPolicy;
}): DeviceBrokerPort & LegacyOperationPort;

import type { UiEventLedgerPort } from "@kobrixa/plugin-runtime";
export declare function uiEventLedgerPort(events: CommonEventLedgerPort): UiEventLedgerPort;
