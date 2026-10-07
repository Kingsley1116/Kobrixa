/** Protocol version; bump on incompatible wire or document-layout changes. */
export const COLLAB_PROTOCOL_VERSION = 1;

export const DEFAULT_COLLAB_URL = "https://collab.kobrixa.com";

/**
 * Top-level shared types of a room's Y.Doc.
 *
 * - `files`:   Y.Map<path, Y.Text> — contents of every shared text file.
 * - `tree`:    Y.Map<path, TreeEntry> — every file and directory in the project.
 * - `chat`:    Y.Array<ChatMessage> — append-only chat log.
 * - `control`: Y.Map with keys of ControlState (`holder`, `requests`).
 * - `meta`:    Y.Map with `projectName` and `entry` (manifest entry file, if any).
 */
export const DOC_KEYS = {
  files: "files",
  tree: "tree",
  chat: "chat",
  control: "control",
  meta: "meta",
} as const;

/** First varint of every WebSocket frame. 0/1 follow y-protocols. */
export const MESSAGE_TYPE = {
  sync: 0,
  awareness: 1,
  /** Server → client: varint type, then a JSON string matching `noticeSchema`. */
  notice: 2,
} as const;

/** WebSocket close codes used by the room. */
export const CLOSE_CODE = {
  kicked: 4001,
  unauthorized: 4003,
  roomClosed: 4004,
  roomFull: 4009,
  protocolMismatch: 4010,
  sessionReplaced: 4011,
} as const;

export const COLLAB_LIMITS = {
  participants: 16,
  files: 200,
  fileBytes: 1024 * 1024,
  /** Combined UTF-8 text size; stays below the room runtime's memory budget. */
  roomFileBytes: 8 * 1024 * 1024,
  /** Encoded document and individual WebSocket frame resource guard. */
  documentBytes: 16 * 1024 * 1024,
  chatMessages: 500,
  chatMessageLength: 2000,
  displayNameLength: 40,
  roomPasswordLength: 128,
  /** Rooms without connections are deleted after this many milliseconds. */
  idleRoomMs: 7 * 24 * 60 * 60 * 1000,
  tokenTtlMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export const COLLAB_ROUTES = {
  createRoom: "/rooms",
  /** Join by invite code; the invite code identifies the room. */
  join: "/rooms/join",
  resume: (roomId = ":roomId") => `/rooms/${roomId}/resume`,
  close: (roomId = ":roomId") => `/rooms/${roomId}/close`,
  chat: (roomId = ":roomId") => `/rooms/${roomId}/chat`,
  kick: (roomId = ":roomId") => `/rooms/${roomId}/kick`,
  setRole: (roomId = ":roomId") => `/rooms/${roomId}/role`,
  /** WebSocket upgrade; the token is passed as `?token=` (browsers cannot set headers). */
  socket: (roomId = ":roomId") => `/rooms/${roomId}/ws`,
} as const;

export const COLLAB_CAPABILITY_HEADER = "X-Collab-Capabilities";
export const COLLAB_RESUME_CAPABILITY = "resume-v1";

/** Participant colors assigned round-robin by join order. */
export const PARTICIPANT_COLORS = [
  "#e5484d",
  "#3e63dd",
  "#30a46c",
  "#f76b15",
  "#8e4ec6",
  "#12a594",
  "#d6409f",
  "#ffc53d",
] as const;

export function participantColor(index: number): string {
  return PARTICIPANT_COLORS[Math.abs(index) % PARTICIPANT_COLORS.length] ?? "#3e63dd";
}
