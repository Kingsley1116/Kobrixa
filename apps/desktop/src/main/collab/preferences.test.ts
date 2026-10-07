import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLAB_RECENT_ROOMS_LIMIT,
  addRecentRoom,
  defaultDisplayName,
  loadCollabPreferences,
} from "./preferences.js";

const room = (index: number) => ({
  roomId: `room-${String(index).padStart(12, "0")}`,
  projectName: `Project ${index}`,
  role: "editor" as const,
  joinedAt: index,
});

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("collab preferences", () => {
  it("derives a safe default display name from the OS account", () => {
    expect(defaultDisplayName(() => "  alice  ")).toBe("alice");
    expect(defaultDisplayName(() => "a\u0001b\u007f")).toBe("ab");
    expect(defaultDisplayName(() => "x".repeat(60))).toBe("x".repeat(40));
    expect(defaultDisplayName(() => "   ")).toBe("Kobrixa");
    expect(
      defaultDisplayName(() => {
        throw new Error("no passwd entry");
      }),
    ).toBe("Kobrixa");
  });

  it("keeps recent rooms unique, newest first and capped", () => {
    let rooms = [] as ReturnType<typeof addRecentRoom>;
    for (let index = 0; index < 15; index += 1) rooms = addRecentRoom(rooms, room(index));
    rooms = addRecentRoom(rooms, { ...room(10), joinedAt: 99 });
    expect(rooms).toHaveLength(COLLAB_RECENT_ROOMS_LIMIT);
    expect(rooms[0]).toEqual({ ...room(10), joinedAt: 99 });
    expect(rooms.filter((item) => item.roomId === room(10).roomId)).toHaveLength(1);
  });

  it("persists validated patches and recovers valid fields from a damaged file", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-prefs-"));
    const file = path.join(directory, "collab-preferences.json");
    await writeFile(
      file,
      JSON.stringify({
        displayName: "\u0000",
        recentRooms: [room(1), { ...room(2), roomId: "bad id" }, room(1), { ...room(3), x: 1 }],
        extra: true,
      }),
    );
    const store = await loadCollabPreferences(directory, () => "bob");
    expect(store.get()).toEqual({ displayName: "bob", recentRooms: [room(1)] });

    await expect(store.set({ displayName: "" })).rejects.toThrow();
    await expect(store.set({ unknown: true })).rejects.toThrow();
    await expect(store.set({ recentRooms: [{ ...room(1), token: "secret" }] })).rejects.toThrow();
    await expect(
      store.set({ recentRooms: Array.from({ length: 11 }, (_, index) => room(index)) }),
    ).rejects.toThrow();

    const saved = await store.set({ displayName: "  Carol  " });
    expect(saved.displayName).toBe("Carol");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(saved);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = await loadCollabPreferences(directory, () => "bob");
    expect(reloaded.get()).toEqual({ displayName: "Carol", recentRooms: [room(1)] });
  });

  it("serialises concurrent updates", async () => {
    const writes: unknown[] = [];
    directory = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-prefs-"));
    const store = await loadCollabPreferences(directory, () => "dan");
    await Promise.all([
      store.update((value) => ({
        ...value,
        recentRooms: addRecentRoom(value.recentRooms, room(1)),
      })),
      store.update((value) => ({
        ...value,
        recentRooms: addRecentRoom(value.recentRooms, room(2)),
      })),
      store.set({ displayName: "Erin" }).then((value) => writes.push(value)),
    ]);
    expect(store.get()).toEqual({ displayName: "Erin", recentRooms: [room(2), room(1)] });
    expect(writes).toHaveLength(1);
  });
});
