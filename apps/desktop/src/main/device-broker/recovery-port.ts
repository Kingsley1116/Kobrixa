import type { Counter, Handle } from "@kobrixa/plugin-protocol";
import type { CoreActionValidationPort, DeviceRecoveryPort, PhysicalIdentity } from "@kobrixa/plugin-runtime";
import type { JournalPort } from "./journal-port.js";
import type { IdleObservation, ProviderOutcome } from "./provider.js";
export type { DeviceFailureDetail, DeviceRecoveryPort, DeviceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export interface RecoveryDriver {
  wallNow(): number; // Unix epoch milliseconds, independent of monotonic deadlines.
  describe(sessionId: Handle): { sessionId: Handle; providerGeneration: Counter; physical: PhysicalIdentity } | null;
  occupy<T>(sessionId: Handle, work: (lane: {
    observe(): Promise<ProviderOutcome<IdleObservation>>;
    stop(): Promise<ProviderOutcome<IdleObservation>>;
  }) => Promise<T>): Promise<T>;
}
export declare function createDeviceRecovery(input: {
  journal: JournalPort; actions: CoreActionValidationPort; driver: RecoveryDriver;
}): DeviceRecoveryPort;
