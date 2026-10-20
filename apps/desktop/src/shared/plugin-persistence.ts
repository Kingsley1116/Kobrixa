import type { Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export interface PersistenceRecoveryBridge {
  snapshot(input: { itemId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  act(input: { itemId: Handle; optionId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  onOpen(listener: (input: { itemId: Handle }) => void): () => void;
  onChanged(listener: () => void): () => void;
}
