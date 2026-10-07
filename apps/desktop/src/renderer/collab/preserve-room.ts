import type { CollabFileSyncBinding } from "./file-sync.js";
import type { CollabApi } from "../../shared/collab.js";

/** A failed network acknowledgement must never turn unconfirmed edits into a saved baseline. */
export async function preserveRoom(
  binding: CollabFileSyncBinding,
  flushDrafts: (workspaceId: string) => Promise<void>,
  api: Pick<CollabApi, "saveCopy" | "checkpoint">,
): Promise<string | undefined> {
  await binding.sync.flush();
  const error = binding.sync.getSnapshot().error;
  if (error) throw new Error(error);
  await flushDrafts(binding.workspaceId);
  if (binding.session.getSnapshot().status === "connected") {
    try {
      await binding.session.flush?.();
    } catch {
      // A timed-out acknowledgement is preserved independently before leaving.
    }
  }
  const roomId = binding.session.connection.roomId;
  if (binding.session.hasPendingUpdates?.()) return api.saveCopy(roomId, false);
  await api.checkpoint(roomId);
  return undefined;
}
