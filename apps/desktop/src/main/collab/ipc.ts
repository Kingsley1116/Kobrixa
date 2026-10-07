import {
  createRoomRequestSchema,
  joinRequestSchema,
  participantIdSchema,
  roomIdSchema,
  setRoleRequestSchema,
} from "@kobrixa/collab-protocol";
import type { IpcHandle } from "../ipc.js";
import type { CollabService } from "./service.js";

/**
 * Registers the collaboration HTTP/preferences channels. Other collaboration
 * modules (device control, mirrors) register their own channels alongside.
 *
 * These channels are deliberately not behind the update `operationGate`: they
 * only talk to the collaboration service and write small preference files, so
 * an update being prepared or installed cannot corrupt them, and blocking them
 * would only make a room unreachable while the update dialog is open.
 */
export function registerCollabIpc(handle: IpcHandle, collab: CollabService): void {
  handle("collab:server-url", () => collab.serverUrl());
  handle("collab:preferences", () => collab.getPreferences());
  handle("collab:set-preferences", (_event, patch: unknown) => collab.setPreferences(patch));
  handle("collab:create-room", (_event, request: unknown) =>
    collab.createRoom(createRoomRequestSchema.parse(request)),
  );
  handle("collab:join-room", (_event, request: unknown) =>
    collab.joinRoom(joinRequestSchema.parse(request)),
  );
  handle("collab:kick", (_event, roomId: unknown, participantId: unknown) =>
    collab.kick(roomIdSchema.parse(roomId), participantIdSchema.parse(participantId)),
  );
  handle("collab:set-role", (_event, roomId: unknown, request: unknown) =>
    collab.setRole(roomIdSchema.parse(roomId), setRoleRequestSchema.parse(request)),
  );
  handle("collab:leave", (_event, roomId: unknown) => collab.leave(roomIdSchema.parse(roomId)));
}
