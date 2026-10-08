import { COLLAB_LIMITS, displayNameSchema, inviteCodeSchema } from "@kobrixa/collab-protocol";
import type {
  CollabApi,
  CollabConnection,
  CollabErrorCode,
  CollabRecentRoom,
  CollabResult,
} from "../../shared/collab.js";
import type { DisplayNameProblem } from "./collab-copy.js";

export const MAX_RECENT_ROOMS = 8;
const INVITE_CODE_CHARS = 12;

/** Why a display name can't be used, or `null` when it is valid. */
export function displayNameProblem(name: string): DisplayNameProblem | null {
  if (displayNameSchema.safeParse(name).success) return null;
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed.length > COLLAB_LIMITS.displayNameLength) return "too-long";
  return "invalid";
}

/**
 * Normalizes typed or pasted input toward `ABCD-EFGH-JK23`: uppercases, drops
 * separators and other punctuation, and inserts a dash after every 4 characters.
 * Characters outside the invite alphabet (I, O, 0, 1) are kept so validation can
 * point them out instead of silently changing the code.
 */
export function formatInviteCode(raw: string): string {
  const chars = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, INVITE_CODE_CHARS);
  return chars.match(/.{1,4}/g)?.join("-") ?? "";
}

export function isValidInviteCode(code: string): boolean {
  return inviteCodeSchema.safeParse(code).success;
}

/** Puts `connection`'s room first in the recent list, without duplicates. */
export function rememberRoom(
  rooms: readonly CollabRecentRoom[],
  connection: CollabConnection,
  joinedAt: number,
): CollabRecentRoom[] {
  const entry: CollabRecentRoom = {
    roomId: connection.roomId,
    projectName: connection.projectName,
    role: connection.role,
    joinedAt,
    ...(connection.inviteCode ? { inviteCode: connection.inviteCode } : {}),
  };
  const previous = rooms.find((room) => room.roomId === connection.roomId);
  if (!entry.inviteCode && previous?.inviteCode) entry.inviteCode = previous.inviteCode;
  return [entry, ...rooms.filter((room) => room.roomId !== connection.roomId)].slice(
    0,
    MAX_RECENT_ROOMS,
  );
}

export type LobbyError = CollabErrorCode | "unknown";

export interface LobbySnapshot {
  loaded: boolean;
  /** Preferences are being (re)loaded. */
  loading: boolean;
  /** Why the recent-room list may be stale: loading it or forgetting a room failed. */
  recentRoomsError: "load" | "forget" | null;
  displayName: string;
  recentRooms: readonly CollabRecentRoom[];
  pending: "start" | "join" | null;
  /** The recent room a pending resume request is for. */
  resumingRoomId: string | null;
  startError: LobbyError | null;
  joinError: LobbyError | null;
}

type LobbyApi = Pick<CollabApi, "getPreferences" | "setPreferences" | "createRoom" | "joinRoom"> &
  Partial<Pick<CollabApi, "resumeRoom">>;

export interface LobbyOptions {
  saveDelayMs?: number;
  now?(): number;
}

/**
 * State and actions behind the collaboration lobby: display name persistence,
 * starting and joining rooms, and the recent-room list. On success the new
 * connection is handed to `start` (normally `CollabStore.start`).
 */
export class CollabLobby {
  #snapshot: LobbySnapshot = {
    loaded: false,
    loading: false,
    recentRoomsError: null,
    displayName: "",
    recentRooms: [],
    pending: null,
    resumingRoomId: null,
    startError: null,
    joinError: null,
  };
  readonly #listeners = new Set<() => void>();
  readonly #saveDelay: number;
  readonly #now: () => number;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #savedName: string | undefined;
  #edited = false;
  #disposed = false;
  #loads = 0;

  constructor(
    private readonly api: LobbyApi,
    private readonly start: (connection: CollabConnection) => unknown,
    options: LobbyOptions = {},
  ) {
    this.#saveDelay = options.saveDelayMs ?? 400;
    this.#now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): LobbySnapshot => this.#snapshot;

  async load(): Promise<void> {
    this.#disposed = false;
    // Only the latest of overlapping loads updates the snapshot.
    const load = ++this.#loads;
    this.#update({ loading: true });
    try {
      const preferences = await this.api.getPreferences();
      if (this.#disposed || load !== this.#loads) return;
      this.#savedName = preferences.displayName;
      this.#update({
        loaded: true,
        loading: false,
        recentRoomsError: null,
        recentRooms: preferences.recentRooms ?? [],
        // Typing before preferences arrive wins over the stored name.
        ...(this.#edited ? {} : { displayName: preferences.displayName ?? "" }),
      });
    } catch (error) {
      console.warn("Couldn't load collaboration preferences", error);
      if (!this.#disposed && load === this.#loads)
        this.#update({ loaded: true, loading: false, recentRoomsError: "load" });
    }
  }

  /** Removes a room from the recent list and persists the change. */
  async forgetRoom(roomId: string): Promise<boolean> {
    // A load in flight would bring the forgotten room back.
    if (this.#snapshot.loading) return false;
    const previous = this.#snapshot.recentRooms;
    const recentRooms = previous.filter((room) => room.roomId !== roomId);
    if (recentRooms.length === previous.length) return false;
    this.#update({ recentRooms, recentRoomsError: null });
    try {
      await this.api.setPreferences({ recentRooms });
      return true;
    } catch (error) {
      console.warn("Couldn't forget the recent room", error);
      // Restore the entry unless the list changed meanwhile.
      if (!this.#disposed && this.#snapshot.recentRooms === recentRooms)
        this.#update({ recentRooms: previous, recentRoomsError: "forget" });
      return false;
    }
  }

  setDisplayName(displayName: string): void {
    this.#edited = true;
    this.#update({ displayName, startError: null });
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.flush(), this.#saveDelay);
  }

  /** Saves the display name now if it is valid and changed. */
  async flush(): Promise<void> {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    const name = this.#snapshot.displayName.trim();
    if (displayNameProblem(name) || name === this.#savedName) return;
    this.#savedName = name;
    try {
      await this.api.setPreferences({ displayName: name });
    } catch {
      this.#savedName = undefined;
    }
  }

  /** Host flow. Returns true when a session was started. */
  async startRoom(projectName: string, password = ""): Promise<boolean> {
    const name = this.#snapshot.displayName.trim();
    if (this.#snapshot.pending || displayNameProblem(name) || !projectName.trim()) return false;
    this.#update({ pending: "start", startError: null });
    return this.#connect("start", () =>
      this.api.createRoom({
        name,
        projectName: projectName.trim(),
        ...(password ? { password } : {}),
      }),
    );
  }

  /** Guest flow. Returns true when a session was started. */
  async joinRoom(inviteCode: string, password = ""): Promise<boolean> {
    const name = this.#snapshot.displayName.trim();
    const code = formatInviteCode(inviteCode);
    if (this.#snapshot.pending || displayNameProblem(name)) return false;
    if (!isValidInviteCode(code)) {
      this.#update({ joinError: "bad-request" });
      return false;
    }
    this.#update({ pending: "join", joinError: null });
    return this.#connect(
      "join",
      () => this.api.joinRoom({ inviteCode: code, name, ...(password ? { password } : {}) }),
      code,
    );
  }

  async resumeRoom(roomId: string): Promise<boolean> {
    if (this.#snapshot.pending || !this.api.resumeRoom) return false;
    this.#update({ pending: "join", startError: null, resumingRoomId: roomId });
    try {
      return await this.#connect("start", () => this.api.resumeRoom!(roomId));
    } finally {
      if (!this.#disposed) this.#update({ resumingRoomId: null });
    }
  }

  clearJoinError(): void {
    if (this.#snapshot.joinError) this.#update({ joinError: null });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#saveTimer !== undefined) void this.flush();
    this.#listeners.clear();
  }

  async #connect(
    kind: "start" | "join",
    request: () => Promise<CollabResult<CollabConnection>>,
    inviteCode?: string,
  ): Promise<boolean> {
    const errorKey = kind === "start" ? "startError" : "joinError";
    await this.flush();
    let result: CollabResult<CollabConnection>;
    try {
      result = await request();
    } catch {
      result = { ok: false, error: "network" };
    }
    if (this.#disposed) return false;
    if (!result.ok) {
      this.#update({ pending: null, [errorKey]: result.error ?? "unknown" });
      return false;
    }
    const connection =
      inviteCode && !result.value.inviteCode ? { ...result.value, inviteCode } : result.value;
    const recentRooms = rememberRoom(this.#snapshot.recentRooms, connection, this.#now());
    this.#update({ recentRooms });
    try {
      if ((await this.start(connection)) === false) {
        this.#update({ pending: null });
        return false;
      }
    } catch {
      this.#update({ pending: null, [errorKey]: "unknown" });
      return false;
    }
    this.#update({ pending: null });
    void this.#saveRecentRooms(recentRooms);
    return true;
  }

  /** Persists `recentRooms` without wiping a stored history that never loaded. */
  async #saveRecentRooms(recentRooms: readonly CollabRecentRoom[]): Promise<void> {
    let rooms = recentRooms;
    if (this.#snapshot.recentRoomsError === "load") {
      try {
        const stored = (await this.api.getPreferences()).recentRooms ?? [];
        rooms = [
          ...recentRooms,
          ...stored.filter((room) => !recentRooms.some((entry) => entry.roomId === room.roomId)),
        ].slice(0, MAX_RECENT_ROOMS);
      } catch {
        return;
      }
    }
    await this.api.setPreferences({ recentRooms: [...rooms] }).catch(() => undefined);
  }

  #update(patch: Partial<LobbySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
