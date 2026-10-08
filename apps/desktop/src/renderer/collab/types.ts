import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  DOC_KEYS,
  type ChatMessage,
  type Notice,
  type PresenceState,
  type Role,
  type TreeEntry,
} from "@kobrixa/collab-protocol";
import type { CollabConnection } from "../../shared/collab.js";

export type CollabStatus =
  /** Socket opening. */
  | "connecting"
  /** Socket open, initial sync step not finished. */
  | "syncing"
  /** Initial sync complete; edits flow live. */
  | "connected"
  /** Connection lost; retrying with backoff. Local edits are kept and resent. */
  | "reconnecting"
  /** Terminal state; see `closeReason`. */
  | "closed";

export type CollabCloseReason =
  "left" | "kicked" | "session-replaced" | "room-closed" | "unauthorized" | "error";

export type CollabParticipant = Extract<Notice, { type: "participants" }>["participants"][number];

export interface CollabSessionSnapshot {
  status: CollabStatus;
  /** Current role; may change while connected (host `setRole`). */
  role: Role;
  /** True once the first full sync with the server has completed. */
  synced: boolean;
  /** Roster from the latest `participants` notice (online and offline). */
  participants: readonly CollabParticipant[];
  closeReason?: CollabCloseReason;
}

/**
 * A live connection to one room. Implemented by `collab-session.ts`; tests use
 * `createLinkedSessions` from `testing.ts`.
 *
 * Follows the renderer's store convention: `subscribe` + `getSnapshot` for
 * `useSyncExternalStore` (the snapshot object is replaced, never mutated).
 */
export interface CollabSession {
  readonly connection: CollabConnection;
  readonly doc: Y.Doc;
  /** Local state must satisfy `PresenceState`. */
  readonly awareness: Awareness;
  subscribe(listener: () => void): () => void;
  getSnapshot(): CollabSessionSnapshot;
  connect(): void;
  /** Waits for local document updates to be accepted by the server. */
  flush?(): Promise<void>;
  hasPendingUpdates?(): boolean;
  /**
   * Host only: asks the server to decline `participantId`'s device-control
   * request. Returns false when the command could not be sent (not connected).
   */
  declineControlRequest?(participantId: string): boolean;
  /** Notified when the host declines this participant's device-control request. */
  onControlDeclined?(listener: () => void): () => void;
  /** Leaves the room; status becomes `closed` with reason `left`. */
  disconnect(): void;
  /** Disconnects and releases the doc and awareness. */
  destroy(): void;
}

export type CollabSessionFactory = (connection: CollabConnection) => CollabSession;

export interface SharedTypes {
  files: Y.Map<Y.Text>;
  tree: Y.Map<TreeEntry>;
  chat: Y.Array<ChatMessage>;
  control: Y.Map<unknown>;
  meta: Y.Map<unknown>;
}

/** Typed accessors for the room document layout (see `DOC_KEYS`). */
export function sharedTypes(doc: Y.Doc): SharedTypes {
  return {
    files: doc.getMap<Y.Text>(DOC_KEYS.files),
    tree: doc.getMap<TreeEntry>(DOC_KEYS.tree),
    chat: doc.getArray<ChatMessage>(DOC_KEYS.chat),
    control: doc.getMap<unknown>(DOC_KEYS.control),
    meta: doc.getMap<unknown>(DOC_KEYS.meta),
  };
}

export function localPresence(session: CollabSession): PresenceState | null {
  return (session.awareness.getLocalState() as PresenceState | null) ?? null;
}

export function canEdit(role: Role): boolean {
  return role !== "viewer";
}
