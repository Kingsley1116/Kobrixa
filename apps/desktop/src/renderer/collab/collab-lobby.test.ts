import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabConnection, CollabPreferences, CollabResult } from "../../shared/collab.js";
import {
  CollabLobby,
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
    expect(lobby.getSnapshot().joinError).toBe("network");
    lobby.clearJoinError();
    expect(lobby.getSnapshot().joinError).toBeNull();
    expect(start).not.toHaveBeenCalled();
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
