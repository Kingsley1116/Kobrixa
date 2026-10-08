import { expect, it, vi } from "vitest";
import { preserveRoom } from "./preserve-room.js";
import type { CollabFileSyncBinding } from "./file-sync.js";

function setup(online: boolean, pending: boolean) {
  const sync = { flush: vi.fn(async () => {}), getSnapshot: () => ({}) };
  const session = {
    connection: { roomId: "room" },
    getSnapshot: () => ({ status: online ? "connected" : "reconnecting" }),
    flush: vi.fn(async () => {
      pending = false;
    }),
    hasPendingUpdates: () => pending,
  };
  const drafts = vi.fn(async () => {});
  const api = { saveCopy: vi.fn(async () => "/backup"), checkpoint: vi.fn(async () => {}) };
  return {
    binding: { sync, session, workspaceId: "project" } as unknown as CollabFileSyncBinding,
    sync,
    session,
    drafts,
    api,
  };
}
it("allows offline exit only after saving unconfirmed changes independently", async () => {
  const { binding, session, drafts, api } = setup(false, true);
  expect(await preserveRoom(binding, drafts, api)).toBe("/backup");
  expect(drafts).toHaveBeenCalledWith("project");
  expect(session.flush).not.toHaveBeenCalled();
  expect(api.saveCopy).toHaveBeenCalledWith("room", false);
  expect(api.checkpoint).not.toHaveBeenCalled();
});
it("never advances the baseline when acknowledgement or backup fails", async () => {
  const { binding, session, drafts, api } = setup(true, true);
  session.flush.mockRejectedValue(new Error("No acknowledgement"));
  api.saveCopy.mockRejectedValue(new Error("Disk full"));
  await expect(preserveRoom(binding, drafts, api)).rejects.toThrow("Disk full");
  expect(api.checkpoint).not.toHaveBeenCalled();
});
it("checkpoints acknowledged edits and stops exit if local writes fail", async () => {
  const { binding, sync, drafts, api } = setup(true, true);
  await preserveRoom(binding, drafts, api);
  expect(api.checkpoint).toHaveBeenCalledWith("room");
  expect(api.saveCopy).not.toHaveBeenCalled();
  sync.flush.mockRejectedValue(new Error("Cannot write"));
  await expect(preserveRoom(binding, drafts, api)).rejects.toThrow("Cannot write");
  expect(api.checkpoint).toHaveBeenCalledTimes(1);
});
