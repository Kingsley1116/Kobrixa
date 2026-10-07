import {
  createRoomRequestSchema,
  joinRequestSchema,
  participantIdSchema,
  roomIdSchema,
  setRoleRequestSchema,
  sendChatRequestSchema,
} from "@kobrixa/collab-protocol";
import { shell } from "electron";
import { z } from "zod";
import type { CollabProjects } from "./projects.js";
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
export function registerCollabIpc(
  handle: IpcHandle,
  collab: CollabService,
  projects?: CollabProjects,
): void {
  if (projects) {
    handle("collab:preview-project", (_event, workspaceId: unknown) =>
      projects.preview(z.string().parse(workspaceId)),
    );
    handle("collab:prepare-project", (_event, roomId: unknown, workspaceId: unknown) =>
      projects.prepare(roomIdSchema.parse(roomId), z.string().optional().parse(workspaceId)),
    );
    handle("collab:checkpoint", (_event, roomId: unknown) =>
      projects.checkpoint(roomIdSchema.parse(roomId)),
    );
    handle("collab:save-copy", async (_event, roomId: unknown, reveal: unknown) => {
      const shouldReveal = z.boolean().default(true).parse(reveal);
      const target = await projects.saveCopy(roomIdSchema.parse(roomId));
      if (shouldReveal) shell.showItemInFolder(target);
      return target;
    });
  }
  handle("collab:server-url", () => collab.serverUrl());
  handle("collab:preferences", () => collab.getPreferences());
  handle("collab:set-preferences", (_event, patch: unknown) => collab.setPreferences(patch));
  handle("collab:create-room", async (_event, request: unknown, workspaceId: unknown) => {
    const id = z.string().optional().parse(workspaceId);
    if (projects && !id) throw new Error("Choose a project before sharing.");
    const result = await collab.createRoom(createRoomRequestSchema.parse(request));
    if (result.ok && projects && id) {
      try {
        await projects.bindCreated(result.value.roomId, id);
      } catch (error) {
        await collab.closeRoom(result.value.roomId);
        await collab.leave(result.value.roomId);
        throw error;
      }
    }
    return result;
  });
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
  handle("collab:resume-room", (_event, roomId: unknown) =>
    collab.resumeRoom(roomIdSchema.parse(roomId)),
  );
  handle("collab:close-room", (_event, roomId: unknown) =>
    collab.closeRoom(roomIdSchema.parse(roomId)),
  );
  handle("collab:send-chat", (_event, roomId: unknown, message: unknown) =>
    collab.sendChat(roomIdSchema.parse(roomId), sendChatRequestSchema.parse(message)),
  );
}
