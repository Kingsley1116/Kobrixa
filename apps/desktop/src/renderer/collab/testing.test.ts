import { describe, expect, it } from "vitest";
import { createLinkedSessions } from "./testing.js";
import { sharedTypes } from "./types.js";
import { CollabStore } from "./store.js";
import * as Y from "yjs";

describe("linked test sessions", () => {
  it("relays document and awareness updates and drops viewer edits", () => {
    const room = createLinkedSessions(["host", "editor", "viewer"]);
    const [host, editor, viewer] = room.sessions as [
      (typeof room.sessions)[0],
      (typeof room.sessions)[0],
      (typeof room.sessions)[0],
    ];
    const text = new Y.Text("print 1");
    sharedTypes(host.doc).files.set("main.bp", text);
    expect(sharedTypes(editor.doc).files.get("main.bp")?.toString()).toBe("print 1");
    sharedTypes(viewer.doc).files.get("main.bp")?.insert(0, "x");
    expect(sharedTypes(host.doc).files.get("main.bp")?.toString()).toBe("print 1");
    expect(host.awareness.getStates().size).toBe(3);
    expect(host.getSnapshot().participants).toHaveLength(3);

    const late = room.join("editor");
    expect(sharedTypes(late.doc).files.get("main.bp")?.toString()).toBe("print 1");

    editor.disconnect();
    expect(host.awareness.getStates().size).toBe(3);
    expect(editor.getSnapshot()).toMatchObject({ status: "closed", closeReason: "left" });
  });

  it("store swaps sessions", () => {
    const room = createLinkedSessions(["host"]);
    const store = new CollabStore(() => room.join("editor"));
    let changes = 0;
    store.subscribe(() => changes++);
    const first = store.start(room.sessions[0]!.connection);
    store.start(first.connection);
    expect(first.getSnapshot().status).toBe("closed");
    store.stop();
    expect(store.getSnapshot()).toBeNull();
    const failing = new CollabStore(() => {
      throw new Error("offline");
    });
    expect(() => failing.start(first.connection)).toThrow("offline");
    expect(failing.getSnapshot()).toBeNull();
    expect(changes).toBe(3);
  });
});
