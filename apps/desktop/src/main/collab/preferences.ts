import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import {
  COLLAB_LIMITS,
  displayNameSchema,
  inviteCodeSchema,
  roleSchema,
  roomIdSchema,
} from "@kobrixa/collab-protocol";
import { z } from "zod";
import type { CollabPreferences, CollabRecentRoom } from "../../shared/collab.js";

export const COLLAB_RECENT_ROOMS_LIMIT = 10;
export const COLLAB_PREFERENCES_FILE = "collab-preferences.json";
const FALLBACK_DISPLAY_NAME = "Kobrixa";

export const collabRecentRoomSchema = z
  .object({
    roomId: roomIdSchema,
    projectName: z.string().max(120),
    inviteCode: inviteCodeSchema.optional(),
    role: roleSchema,
    joinedAt: z.number().int().nonnegative(),
    canResume: z.boolean().optional(),
  })
  .strict();

export const collabPreferencesSchema = z
  .object({
    displayName: displayNameSchema,
    recentRooms: z.array(collabRecentRoomSchema).max(COLLAB_RECENT_ROOMS_LIMIT),
  })
  .strict();

/** Drops `undefined` optionals so values satisfy `exactOptionalPropertyTypes`. */
function recentRoom(value: z.output<typeof collabRecentRoomSchema>): CollabRecentRoom {
  return {
    roomId: value.roomId,
    projectName: value.projectName,
    ...(value.inviteCode === undefined ? {} : { inviteCode: value.inviteCode }),
    role: value.role,
    joinedAt: value.joinedAt,
  };
}

export const collabPreferencesPatchSchema = collabPreferencesSchema
  .partial()
  .transform((value): Partial<CollabPreferences> => {
    const patch: Partial<CollabPreferences> = {};
    if (value.displayName !== undefined) patch.displayName = value.displayName;
    if (value.recentRooms !== undefined) patch.recentRooms = value.recentRooms.map(recentRoom);
    return patch;
  });

/** The OS account name, made safe for `displayNameSchema`. */
export function defaultDisplayName(username?: () => string): string {
  let name = "";
  try {
    name = (username ?? (() => userInfo().username))();
  } catch {
    /* Some sandboxed or domain accounts have no passwd entry. */
  }
  const cleaned = [...name]
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== "\u007f")
    .join("")
    .trim();
  const limited = [...cleaned].slice(0, COLLAB_LIMITS.displayNameLength).join("").trim();
  return displayNameSchema.safeParse(limited).success ? limited : FALLBACK_DISPLAY_NAME;
}

export function defaultCollabPreferences(username?: () => string): CollabPreferences {
  return { displayName: defaultDisplayName(username), recentRooms: [] };
}

/** Moves `room` to the front, replacing an older entry for the same room. */
export function addRecentRoom(
  rooms: readonly CollabRecentRoom[],
  room: CollabRecentRoom,
): CollabRecentRoom[] {
  return [room, ...rooms.filter((item) => item.roomId !== room.roomId)].slice(
    0,
    COLLAB_RECENT_ROOMS_LIMIT,
  );
}

const clone = (value: CollabPreferences): CollabPreferences => ({
  displayName: value.displayName,
  recentRooms: value.recentRooms.map((room) => ({ ...room })),
});

/** Serialised like `DevicePreferencesStore` so concurrent patches cannot lose settings. */
export class CollabPreferencesStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private value: CollabPreferences = defaultCollabPreferences(),
    private persist: (value: CollabPreferences) => Promise<void> = async () => {},
  ) {}

  get = (): CollabPreferences => clone(this.value);

  async set(patch: unknown): Promise<CollabPreferences> {
    const validated = collabPreferencesPatchSchema.parse(patch);
    return this.update((current) => ({ ...current, ...validated }));
  }

  /** Applies `change` to the latest value after earlier writes have settled. */
  update(change: (current: CollabPreferences) => CollabPreferences): Promise<CollabPreferences> {
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const next = clone(collabPreferencesSchema.parse(change(this.get())) as CollabPreferences);
        next.recentRooms = next.recentRooms.map(recentRoom);
        await this.persist(next);
        this.value = next;
        return this.get();
      });
    this.writes = write;
    return write;
  }
}

export async function loadCollabPreferences(
  directory: string,
  username?: () => string,
): Promise<CollabPreferencesStore> {
  const file = path.join(directory, COLLAB_PREFERENCES_FILE);
  const value = defaultCollabPreferences(username);
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const name = displayNameSchema.safeParse(record.displayName);
      if (name.success) value.displayName = name.data;
      // Keep every independently valid room when the file was edited or damaged.
      if (Array.isArray(record.recentRooms)) {
        for (const item of record.recentRooms) {
          const room = collabRecentRoomSchema.safeParse(item);
          if (room.success && !value.recentRooms.some((entry) => entry.roomId === room.data.roomId))
            value.recentRooms.push(recentRoom(room.data));
          if (value.recentRooms.length >= COLLAB_RECENT_ROOMS_LIMIT) break;
        }
      }
    }
  } catch {
    /* First launch or unreadable preferences: use defaults. */
  }
  return new CollabPreferencesStore(value, async (next) => {
    await mkdir(directory, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  });
}
