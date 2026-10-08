import { describe, expect, it } from "vitest";
import { mergeRoster, onlineCount, rosterLoading } from "./roster.js";
import { createLinkedSessions } from "./testing.js";

describe("mergeRoster", () => {
  it("merges server roster with awareness colors and orders you, host, online, offline", () => {
    const entries = mergeRoster(
      [
        { participantId: "viewer-01", name: "Vic", role: "viewer", online: false },
        { participantId: "editor-01", name: "Eve", role: "editor", online: true },
        { participantId: "host-0001", name: "Hal", role: "host", online: true },
        { participantId: "self-0001", name: "Me", role: "editor", online: true },
      ],
      [
        { participantId: "host-0001", name: "Hal", color: "#e5484d", role: "host" },
        { participantId: "self-0001", name: "Me", color: "#3e63dd", role: "editor" },
        { participantId: "late-0001", name: "Lou", color: "#30a46c", role: "viewer" },
        { participantId: "late-0002" },
        null,
        "junk",
      ],
      "self-0001",
    );
    expect(entries.map((entry) => entry.participantId)).toEqual([
      "self-0001",
      "host-0001",
      "editor-01",
      "viewer-01",
    ]);
    expect(entries[0]).toEqual({
      participantId: "self-0001",
      name: "Me",
      role: "editor",
      online: true,
      color: "#3e63dd",
      self: true,
    });
    expect(entries[2]?.color).toBeUndefined();
    expect(entries[3]).toMatchObject({ name: "Vic", online: false, self: false });
    expect(onlineCount(entries)).toBe(3);
  });

  it("keeps authoritative offline state and role despite stale awareness", () => {
    const [entry] = mergeRoster(
      [{ participantId: "editor-01", name: "Eve", role: "viewer", online: false }],
      [{ participantId: "editor-01", name: "Eve", color: "#bad", role: "editor" }],
      "someone-else",
    );
    expect(entry).toMatchObject({ role: "viewer", online: false });
    expect(entry?.color).toBeUndefined();
  });

  it("uses awareness before receiving the first server roster", () => {
    expect(
      mergeRoster([], [{ participantId: "guest", name: "Guest", role: "editor" }], "self"),
    ).toEqual([
      {
        participantId: "guest",
        name: "Guest",
        role: "editor",
        online: true,
        provisional: true,
        self: false,
      },
    ]);
  });

  it("reports loading until the first server roster arrives", () => {
    expect(rosterLoading([])).toBe(true);
    const early = mergeRoster([], [{ participantId: "self", name: "Me", role: "host" }], "self");
    expect(rosterLoading(early)).toBe(true);
    const roster = mergeRoster(
      [{ participantId: "self", name: "Me", role: "host", online: true }],
      [],
      "self",
    );
    expect(rosterLoading(roster)).toBe(false);
  });

  it("shows the open file of online participants and marks the device-control holder", () => {
    const entries = mergeRoster(
      [
        { participantId: "editor-01", name: "Eve", role: "editor", online: true },
        { participantId: "editor-02", name: "Ed", role: "editor", online: false },
        { participantId: "editor-03", name: "Al", role: "editor", online: true },
      ],
      [
        { participantId: "editor-01", name: "Eve", role: "editor", file: "src/main.bp" },
        { participantId: "editor-02", name: "Ed", role: "editor", file: "stale.bp" },
        { participantId: "editor-03", name: "Al", role: "editor", file: "../escape.bp" },
      ],
      "someone-else",
      "editor-01",
    );
    expect(entries.map((entry) => [entry.name, entry.file, entry.controlHolder])).toEqual([
      ["Eve", "src/main.bp", true],
      ["Al", undefined, undefined],
      ["Ed", undefined, undefined],
    ]);
  });

  it("works with linked test sessions", () => {
    const room = createLinkedSessions(["host", "editor"]);
    const [host, editor] = room.sessions;
    editor!.disconnect();
    const entries = mergeRoster(
      host!.getSnapshot().participants,
      host!.awareness.getStates().values(),
      host!.connection.participantId,
    );
    expect(entries.map((entry) => [entry.name, entry.self, entry.online])).toEqual([
      ["User 1", true, true],
      ["User 2", false, false],
    ]);
    for (const session of room.sessions) session.destroy();
  });
});
