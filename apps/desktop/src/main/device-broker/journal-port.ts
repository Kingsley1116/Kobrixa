import type { FaultJournalDocument, DeviceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export type { DeviceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export interface JournalPort {
  /** Host-only process history; missing knowledge never authorizes unavailable close. */
  history?(): JournalHistory;
  noteRiskAdmission?(): void;
  load(): Promise<FaultJournalDocument>;
  commit(document: FaultJournalDocument): Promise<void>;
  snapshot(): DeviceRecoverySnapshot;
  subscribe(listener: (snapshot: DeviceRecoverySnapshot) => void): () => void;
}

export interface JournalHistory {
  initialized: boolean;
  inventory: "unknown" | "validated-empty" | "evidence";
  writeAttempted: boolean;
  publicationUncertain: boolean;
  riskWorkAdmitted: boolean;
  io: "unknown" | "pending" | "idle" | "expired";
  resourceLimited: boolean;
}
