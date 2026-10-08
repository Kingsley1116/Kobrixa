import type {
  CreateRoomRequest,
  ErrorResponse,
  JoinRequest,
  Role,
  SetRoleRequest,
  ChatMessage,
  SendChatRequest,
} from "@kobrixa/collab-protocol";
import type { WorkspaceSummary } from "./api.js";

/** Everything the renderer needs to open a room WebSocket. */
export interface CollabConnection {
  /** HTTP(S) origin of the collaboration service, e.g. `https://collab.kobrixa.com`. */
  serverUrl: string;
  roomId: string;
  participantId: string;
  token: string;
  role: Role;
  name: string;
  projectName: string;
  /** Only known to the host (and to guests who joined with it). */
  inviteCode?: string;
  expiresAt: number;
  workspaceId?: string;
}

export interface CollabRecentRoom {
  roomId: string;
  projectName: string;
  inviteCode?: string;
  role: Role;
  joinedAt: number;
  canResume?: boolean;
}

export interface CollabPreferences {
  displayName: string;
  recentRooms: CollabRecentRoom[];
}

export type CollabErrorCode =
  ErrorResponse["error"] | "network" | "unavailable" | "identity-missing";

export type CollabResult<T> =
  { ok: true; value: T } | { ok: false; error: CollabErrorCode; message?: string };

export interface CollabSharePreview {
  shared: string[];
  skipped: { path: string; reason: "format" | "size" | "total" | "count" }[];
}

export interface CollabApi {
  previewProject(workspaceId: string): Promise<CollabSharePreview>;
  /** Resolved service origin (`KOBRIXA_COLLAB_URL` or the default). */
  serverUrl(): Promise<string>;
  getPreferences(): Promise<CollabPreferences>;
  setPreferences(patch: Partial<CollabPreferences>): Promise<CollabPreferences>;
  /** Host flow: creates a room on the service. */
  createRoom(
    request: CreateRoomRequest,
    workspaceId?: string,
  ): Promise<CollabResult<CollabConnection>>;
  /** Guest flow: exchanges an invite code for a room token. */
  joinRoom(request: JoinRequest): Promise<CollabResult<CollabConnection>>;
  resumeRoom(roomId: string): Promise<CollabResult<CollabConnection>>;
  closeRoom(roomId: string): Promise<CollabResult<null>>;
  sendChat(roomId: string, message: SendChatRequest): Promise<CollabResult<ChatMessage>>;
  prepareProject(roomId: string, workspaceId?: string): Promise<WorkspaceSummary | null>;
  checkpoint(roomId: string): Promise<void>;
  saveCopy(roomId: string, reveal?: boolean): Promise<string>;
  /** Host-only room administration. */
  kick(roomId: string, participantId: string): Promise<CollabResult<null>>;
  setRole(roomId: string, request: SetRoleRequest): Promise<CollabResult<null>>;
  /** Forgets the stored token for a room. */
  leave(roomId: string): Promise<void>;
  /**
   * Tells the main process whether this window currently holds EV3 control in an
   * active room. `null` means no collaboration session (no restriction).
   * While `false`, device write operations are rejected by the main process.
   */
  setDeviceControl(holder: boolean | null): Promise<void>;
  /**
   * Guest flow: creates (or reuses) `userData/collab/<roomId>/` and opens it as a
   * workspace so builds, the simulator and uploads work on mirrored files.
   */
  openMirror(roomId: string, projectName: string): Promise<WorkspaceSummary>;
  /** Deletes a mirror folder created by `openMirror`. */
  removeMirror(roomId: string): Promise<void>;
}
