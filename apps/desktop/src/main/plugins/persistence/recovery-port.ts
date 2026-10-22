import type { Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { PersistenceRecoverySnapshot, CoreActionReference } from "@kobrixa/plugin-runtime";
export interface PersistenceRecoveryHostPort {
  snapshot(): PersistenceRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  export(input: { recovery: Handle; action: CoreActionReference }): Promise<PersistenceResult<{
    disposition: "not-committed" | "committed" | "unknown";
  }>>;
}
