import { expectTypeOf, it } from "vitest";
import type { DeviceBrokerPort, LegacyOperationPort, createDeviceBroker } from "./broker-port.js";
import type { BuiltinDeviceProvider, ProviderCleanupContext } from "./provider.js";
import type { attachDeviceRpc } from "./rpc-router.js";
import type { createEv3Provider } from "../device-providers/ev3/provider.js";
import type { Principal, ProfileWriterLock, CoreActionReference, CoreActionValidationPort,
  FaultJournalDocument, DeviceRecoverySnapshot, DeviceRecoveryPort, DeviceFailureDetail,
  DeviceResourceParticipant, DeviceRequirement, CommonEventLedgerPort, UiEventLedgerPort,
  Stage3RuntimePorts, Stage3HostAttachment, Stage3ChannelContext, Stage3ChannelBinding,
  UiRuntimeAttachment, OwnerRetirement, ReservationBindingPort, DeviceSessionControlPort } from "@kobrixa/plugin-runtime";
import type { CoreActionTarget } from "@kobrixa/plugin-runtime";
import type { DeviceFailureDetail as ProtocolFailure } from "@kobrixa/plugin-protocol";
import type { DeviceRecoverySnapshot as JournalSnapshot } from "./journal-port.js";
import type { DeviceRecoveryPort as RecoveryPort } from "./recovery-port.js";
import type { DeviceRecoverySnapshot as BrokerSnapshot } from "./broker-port.js";
it("F/P150 package-root host contracts preserve single definitions", () => {
  expectTypeOf<Extract<CoreActionTarget, { kind: "device-current-stop" }>>().toEqualTypeOf<{ kind: "device-current-stop"; sessionId: string }>();
  expectTypeOf<DeviceFailureDetail>().toEqualTypeOf<ProtocolFailure>();
  expectTypeOf<DeviceRecoverySnapshot>().toEqualTypeOf<JournalSnapshot>();
  expectTypeOf<DeviceRecoverySnapshot>().toEqualTypeOf<BrokerSnapshot>();
  expectTypeOf<DeviceRecoveryPort>().toEqualTypeOf<RecoveryPort>();
  expectTypeOf<CommonEventLedgerPort["diagnostics"]>().toEqualTypeOf<
    () => Readonly<{ subscriptions: number; queuedEvents: number; queuedBytes: number }>>();
  expectTypeOf<Parameters<UiEventLedgerPort["create"]>>().toEqualTypeOf<Parameters<CommonEventLedgerPort["create"]>>();
});
export type FrozenPackageRootConsumers = [Principal, ProfileWriterLock, CoreActionReference,
  CoreActionValidationPort, FaultJournalDocument, DeviceResourceParticipant, DeviceRequirement,
  Stage3RuntimePorts, Stage3HostAttachment, Stage3ChannelContext, Stage3ChannelBinding,
  UiRuntimeAttachment, OwnerRetirement, ReservationBindingPort, DeviceSessionControlPort];
it("F21 freezes provider cleanup and retained legacy operations", () => {
  expectTypeOf<ReturnType<typeof createDeviceBroker>>().toEqualTypeOf<DeviceBrokerPort & LegacyOperationPort>();
  expectTypeOf<ReturnType<typeof createEv3Provider>>().toEqualTypeOf<BuiltinDeviceProvider>();
  expectTypeOf<ReturnType<typeof attachDeviceRpc>>().toEqualTypeOf<() => void>();
  expectTypeOf<Parameters<ProviderCleanupContext["assertCleanup"]>[0]>()
    .toEqualTypeOf<"stop" | "readback" | "file-close" | "disconnect">();
});
