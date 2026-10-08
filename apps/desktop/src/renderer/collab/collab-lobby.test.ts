import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabConnection, CollabPreferences, CollabResult } from "../../shared/collab.js";
import {
  CollabLobby,
  CollabStartError,
  localCollabError,
  MAX_RECENT_ROOMS,
  displayNameProblem,
  formatInviteCode,
  isValidInviteCode,
  rememberRoom,
} from "./collab-lobby.js";
import { collabCopy, collabErrorMessage } from "./collab-copy.js";

const connection = (patch: Partial<CollabConnection> = {}): CollabConnection => ({
  serverUrl: "http://collab.test",
  roomId: "room-aaaaaaaaaaaaaaaa",
  participantId: "participant-1",
  token: "token",
  role: "editor",
  name: "Ada",
  projectName: "Robot",
  expiresAt: 1,
  ...patch,
});

function fakeApi(preferences: Partial<CollabPreferences> = {}) {
  let stored: CollabPreferences = { displayName: "", recentRooms: [], ...preferences };
  const api = {
    getPreferences: vi.fn(async () => stored),
    setPreferences: vi.fn(async (patch: Partial<CollabPreferences>) => {
      stored = { ...stored, ...patch };
      return stored;
    }),
    createRoom: vi.fn(async (): Promise<CollabResult<CollabConnection>> => ({
      ok: true,
      value: connection({ role: "host", inviteCode: "ABCD-EFGH-JK23" }),
    })),
    joinRoom: vi.fn(async (): Promise<CollabResult<CollabConnection>> => ({
      ok: true,
      value: connection(),
    })),
    stored: () => stored,
  };
  return api;
}

describe("invite codes", () => {
  it("uppercases, strips separators and groups by four", () => {
    expect(formatInviteCode("abcd")).toBe("ABCD");
    expect(formatInviteCode("abcde")).toBe("ABCD-E");
    expect(formatInviteCode(" ab cd-ef gh_jk23 extra")).toBe("ABCD-EFGH-JK23");
    expect(formatInviteCode("ABCD-")).toBe("ABCD");
    expect(formatInviteCode("")).toBe("");
  });

  it("validates against the invite alphabet", () => {
    expect(isValidInviteCode("ABCD-EFGH-JK23")).toBe(true);
    expect(isValidInviteCode("ABCD-EFGH-JK2")).toBe(false);
    expect(isValidInviteCode(formatInviteCode("abcd-efgh-jk10"))).toBe(false);
    expect(isValidInviteCode(formatInviteCode("ioab-cdef-ghjk"))).toBe(false);
  });
});

describe("display names", () => {
  it("reports why a name is unusable", () => {
    expect(displayNameProblem("Ada")).toBeNull();
    expect(displayNameProblem("  ")).toBe("empty");
    expect(displayNameProblem("x".repeat(41))).toBe("too-long");
    expect(displayNameProblem("a\u0007b")).toBe("invalid");
  });
});

describe("recent rooms", () => {
  it("moves a room to the front, keeps a known invite code and caps the list", () => {
    const rooms = Array.from({ length: MAX_RECENT_ROOMS }, (_, index) => ({
      roomId: `room-${index}`,
      projectName: `P${index}`,
      role: "editor" as const,
      joinedAt: index,
      ...(index === 3 ? { inviteCode: "ABCD-EFGH-JK23" } : {}),
    }));
    const next = rememberRoom(rooms, connection({ roomId: "room-3", projectName: "New" }), 99);
    expect(next).toHaveLength(MAX_RECENT_ROOMS);
    expect(next[0]).toEqual({
      roomId: "room-3",
      projectName: "New",
      role: "editor",
      joinedAt: 99,
      inviteCode: "ABCD-EFGH-JK23",
    });
    const added = rememberRoom(rooms, connection({ roomId: "room-new" }), 100);
    expect(added).toHaveLength(MAX_RECENT_ROOMS);
    expect(added[0]?.roomId).toBe("room-new");
    expect(added.some((room) => room.roomId === `room-${MAX_RECENT_ROOMS - 1}`)).toBe(false);
  });
});

describe("CollabLobby", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads preferences and saves a valid display name after typing pauses", async () => {
    const api = fakeApi({ displayName: "Old" });
    const lobby = new CollabLobby(api, vi.fn(), { saveDelayMs: 300 });
    await lobby.load();
    expect(lobby.getSnapshot()).toMatchObject({ loaded: true, displayName: "Old" });
    lobby.setDisplayName("Ad");
    lobby.setDisplayName(" Ada ");
    await vi.advanceTimersByTimeAsync(299);
    expect(api.setPreferences).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.setPreferences).toHaveBeenCalledTimes(1);
    expect(api.stored().displayName).toBe("Ada");
    lobby.setDisplayName("");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.setPreferences).toHaveBeenCalledTimes(1);
  });

  it("keeps a name typed before preferences finished loading", async () => {
    const api = fakeApi({ displayName: "Stored" });
    const lobby = new CollabLobby(api, vi.fn());
    const loading = lobby.load();
    lobby.setDisplayName("Typed");
    await loading;
    expect(lobby.getSnapshot().displayName).toBe("Typed");
  });

  it("reports loading and a failed load, then recovers on retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = { roomId: "room-a", projectName: "Robot", role: "editor" as const, joinedAt: 1 };
    const api = fakeApi({ displayName: "Ada", recentRooms: [room] });
    api.getPreferences.mockRejectedValueOnce(new Error("ipc"));
    const lobby = new CollabLobby(api, vi.fn());
    const loading = lobby.load();
    expect(lobby.getSnapshot()).toMatchObject({ loading: true, loaded: false });
    await loading;
    expect(lobby.getSnapshot()).toMatchObject({
      loading: false,
      loaded: true,
      recentRoomsError: "load",
      recentRooms: [],
    });
    await lobby.load();
    expect(lobby.getSnapshot()).toMatchObject({
      loading: false,
      recentRoomsError: null,
      recentRooms: [room],
    });
    vi.mocked(console.warn).mockRestore();
  });

  it("lets only the latest of overlapping loads update the snapshot", async () => {
    const api = fakeApi({ displayName: "Ada" });
    let resolveFirst!: (value: CollabPreferences) => void;
    api.getPreferences.mockImplementationOnce(
      () => new Promise<CollabPreferences>((resolve) => (resolveFirst = resolve)),
    );
    const lobby = new CollabLobby(api, vi.fn());
    const first = lobby.load();
    await lobby.load();
    resolveFirst({ displayName: "Stale", recentRooms: [] });
    await first;
    expect(lobby.getSnapshot()).toMatchObject({ loading: false, displayName: "Ada" });
  });

  it("forgets a recent room and restores it when saving fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rooms = ["room-a", "room-b"].map((roomId) => ({
      roomId,
      projectName: roomId,
      role: "editor" as const,
      joinedAt: 1,
    }));
    const api = fakeApi({ displayName: "Ada", recentRooms: rooms });
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    expect(await lobby.forgetRoom("room-a")).toBe(true);
    expect(lobby.getSnapshot().recentRooms.map((room) => room.roomId)).toEqual(["room-b"]);
    expect(api.stored().recentRooms.map((room) => room.roomId)).toEqual(["room-b"]);
    expect(await lobby.forgetRoom("room-missing")).toBe(false);
    api.setPreferences.mockRejectedValueOnce(new Error("disk"));
    expect(await lobby.forgetRoom("room-b")).toBe(false);
    expect(lobby.getSnapshot()).toMatchObject({ recentRoomsError: "forget" });
    expect(lobby.getSnapshot().recentRooms.map((room) => room.roomId)).toEqual(["room-b"]);
    vi.mocked(console.warn).mockRestore();
  });

  it("keeps stored history when joining after a failed load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = { roomId: "room-old", projectName: "Old", role: "editor" as const, joinedAt: 1 };
    const api = fakeApi({ displayName: "Ada", recentRooms: [room] });
    api.getPreferences.mockRejectedValueOnce(new Error("ipc"));
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    expect(await lobby.forgetRoom("room-old")).toBe(false);
    lobby.setDisplayName("Ada");
    expect(await lobby.joinRoom("ABCD-EFGH-JK23")).toBe(true);
    await vi.waitFor(() =>
      expect(api.stored().recentRooms.map((entry) => entry.roomId)).toEqual([
        connection().roomId,
        "room-old",
      ]),
    );
    vi.mocked(console.warn).mockRestore();
  });

  it("does not forget a room while preferences are loading", async () => {
    const room = { roomId: "room-a", projectName: "Robot", role: "editor" as const, joinedAt: 1 };
    const api = fakeApi({ displayName: "Ada", recentRooms: [room] });
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    const loading = lobby.load();
    expect(await lobby.forgetRoom("room-a")).toBe(false);
    await loading;
    expect(await lobby.forgetRoom("room-a")).toBe(true);
    expect(lobby.getSnapshot().recentRooms).toEqual([]);
  });

  it("tracks which recent room is being resumed", async () => {
    let finish!: (value: CollabResult<CollabConnection>) => void;
    const api = {
      ...fakeApi({ displayName: "Ada" }),
      resumeRoom: vi.fn(
        () => new Promise<CollabResult<CollabConnection>>((resolve) => (finish = resolve)),
      ),
    };
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    const resuming = lobby.resumeRoom("room-a");
    await vi.waitFor(() => expect(api.resumeRoom).toHaveBeenCalled());
    expect(lobby.getSnapshot()).toMatchObject({ pending: "join", resumingRoomId: "room-a" });
    finish({ ok: false, error: "room-closed" });
    expect(await resuming).toBe(false);
    expect(lobby.getSnapshot()).toMatchObject({
      pending: null,
      resumingRoomId: null,
      startError: "room-closed",
    });
  });

  it("starts a room, remembers it and hands the connection to the store", async () => {
    const api = fakeApi({ displayName: "Ada" });
    const start = vi.fn();
    const lobby = new CollabLobby(api, start, { now: () => 42 });
    await lobby.load();
    const started = lobby.startRoom("  Robot ");
    expect(lobby.getSnapshot().pending).toBe("start");
    expect(await started).toBe(true);
    expect(api.createRoom).toHaveBeenCalledWith({ name: "Ada", projectName: "Robot" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ role: "host" }));
    expect(lobby.getSnapshot()).toMatchObject({ pending: null, startError: null });
    await vi.runAllTimersAsync();
    expect(api.stored().recentRooms).toEqual([
      expect.objectContaining({ roomId: connection().roomId, joinedAt: 42, role: "host" }),
    ]);
  });

  it("refuses to start without a project or valid name", async () => {
    const api = fakeApi();
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    expect(await lobby.startRoom("Robot")).toBe(false);
    lobby.setDisplayName("Ada");
    expect(await lobby.startRoom("  ")).toBe(false);
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("reports service errors and thrown requests", async () => {
    const api = fakeApi({ displayName: "Ada" });
    const start = vi.fn();
    const lobby = new CollabLobby(api, start);
    await lobby.load();
    api.createRoom.mockResolvedValueOnce({ ok: false, error: "rate-limited" });
    expect(await lobby.startRoom("Robot")).toBe(false);
    expect(lobby.getSnapshot()).toMatchObject({ pending: null, startError: "rate-limited" });
    api.joinRoom.mockRejectedValueOnce(new Error("ipc"));
    expect(await lobby.joinRoom("ABCD-EFGH-JK23")).toBe(false);
    // A rejected IPC call is a local failure, not a network one.
    expect(lobby.getSnapshot().joinError).toBe("unknown");
    api.createRoom.mockRejectedValueOnce(
      new Error("Error invoking remote method 'collab:create-room': Error: project-required"),
    );
    expect(await lobby.startRoom("Robot")).toBe(false);
    expect(lobby.getSnapshot().startError).toBe("project-required");
    lobby.clearJoinError();
    expect(lobby.getSnapshot().joinError).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("returns quietly when starting is cancelled and reports preparation failures", async () => {
    const api = fakeApi({ displayName: "Ada" });
    const start = vi.fn().mockResolvedValueOnce(false);
    const lobby = new CollabLobby(api, start);
    await lobby.load();
    expect(await lobby.startRoom("Robot")).toBe(false);
    expect(lobby.getSnapshot()).toMatchObject({ pending: null, startError: null });
    start.mockRejectedValueOnce(new CollabStartError("backup-failed"));
    expect(await lobby.startRoom("Robot")).toBe(false);
    expect(lobby.getSnapshot().startError).toBe("backup-failed");
    start.mockRejectedValueOnce(new Error("Error invoking remote method 'x': Error: EACCES"));
    expect(await lobby.joinRoom("ABCD-EFGH-JK23")).toBe(false);
    expect(lobby.getSnapshot()).toMatchObject({ pending: null, joinError: "prepare-failed" });
    expect(collabErrorMessage(collabCopy.en, "prepare-failed")).toMatch(/project/);
  });

  it("recovers local error codes from IPC rejections only", () => {
    expect(localCollabError(new Error("backup-failed"))).toBe("backup-failed");
    expect(
      localCollabError(
        new Error("Error invoking remote method 'a': CollabLocalError: project-unavailable"),
      ),
    ).toBe("project-unavailable");
    expect(localCollabError(new Error("not a backup-failed"))).toBeUndefined();
    expect(localCollabError("network")).toBeUndefined();
  });

  it("joins with a normalized code and keeps the code on the connection", async () => {
    const api = fakeApi({ displayName: "Ada" });
    const start = vi.fn();
    const lobby = new CollabLobby(api, start);
    await lobby.load();
    expect(await lobby.joinRoom("abcd efgh jk23")).toBe(true);
    expect(api.joinRoom).toHaveBeenCalledWith({ inviteCode: "ABCD-EFGH-JK23", name: "Ada" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ inviteCode: "ABCD-EFGH-JK23" }));
    expect(lobby.getSnapshot().recentRooms[0]?.inviteCode).toBe("ABCD-EFGH-JK23");
  });

  it("does not request a join for a malformed code", async () => {
    const api = fakeApi({ displayName: "Ada" });
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    expect(await lobby.joinRoom("ABCD-EFGH")).toBe(false);
    expect(api.joinRoom).not.toHaveBeenCalled();
  });

  it("ignores a second request while one is pending", async () => {
    const api = fakeApi({ displayName: "Ada" });
    const lobby = new CollabLobby(api, vi.fn());
    await lobby.load();
    const first = lobby.joinRoom("ABCD-EFGH-JK23");
    expect(await lobby.startRoom("Robot")).toBe(false);
    expect(await first).toBe(true);
    expect(api.createRoom).not.toHaveBeenCalled();
  });
});

describe("error copy", () => {
  it("localizes every error code and falls back for unknown errors", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      const copy = collabCopy[locale];
      for (const code of Object.keys(collabCopy.en.errors) as (keyof typeof copy.errors)[])
        expect(collabErrorMessage(copy, code)).toBeTruthy();
      expect(collabErrorMessage(copy, "unknown")).toBe(copy.unknownError);
    }
    expect(collabErrorMessage(collabCopy.en, "unavailable")).toMatch(/isn't available/);
    expect(collabErrorMessage(collabCopy["zh-TW"], "room-full")).toBe("此房間已滿。");
  });
});
