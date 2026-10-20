import type { FaultJournalDocument, DeviceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export type { DeviceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export interface JournalPort {
  load(): Promise<FaultJournalDocument>;
  commit(document: FaultJournalDocument): Promise<void>;
  snapshot(): DeviceRecoverySnapshot;
  subscribe(listener: (snapshot: DeviceRecoverySnapshot) => void): () => void;
}
