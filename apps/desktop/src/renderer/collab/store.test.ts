import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Role } from "@kobrixa/collab-protocol";
import type { CollabConnection } from "../../shared/collab.js";
import type { CollabSession, CollabSessionSnapshot } from "./types.js";
import { CollabStore } from "./store.js";

const connection: CollabConnection = {
  serverUrl: "https://collab.test",
  roomId: "test-room-0000000",
  participantId: "guest-0001",
  name: "Guest",
  role: "editor",
  token: "same-verified-token",
  expiresAt: Date.now() + 60_000,
  projectName: "Robot",
};

/** A server that drops viewer edits, like the real room. */
class Session implements CollabSession {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly listeners = new Set<() => void>();
  snapshot: CollabSessionSnapshot;
  destroyed = false;
  constructor(
    readonly connection: CollabConnection,
    private readonly server: Y.Doc,
  ) {
    this.snapshot = {
      status: "connecting",
      synced: false,
      participants: [],
      role: connection.role,
    };
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this && this.snapshot.role !== "viewer") Y.applyUpdate(server, update);
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  connect() {
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.server), this);
    this.snapshot = { ...this.snapshot, status: "connected", synced: true };
    this.emit();
  }
  setRole(role: Role) {
    this.snapshot = { ...this.snapshot, role };
    this.emit();
  }
  emit() {
    for (const listener of [...this.listeners]) listener();
  }
  disconnect() {
    this.snapshot = { ...this.snapshot, status: "closed", closeReason: "left" };
    this.emit();
  }
  destroy() {
    this.destroyed = true;
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

describe("CollabStore role resynchronization", () => {
  it("replaces CRDT history across downgrade and promotion without resurrecting viewer edits", () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "trusted");
    const created: Session[] = [];
    const store = new CollabStore((value) => {
      const session = new Session(value, server);
      created.push(session);
      return session;
    });
    try {
      const editor = store.start(connection) as Session;
      editor.setRole("viewer");
      const viewer = store.getSnapshot() as Session;
      expect(viewer).not.toBe(editor);
      expect(editor.destroyed).toBe(true);
      expect(viewer.connection).toEqual({ ...connection, role: "viewer" });
      viewer.doc.getText("source").insert(0, "UNAUTHORIZED");
      expect(server.getText("source").toString()).toBe("trusted");
      viewer.setRole("editor");
      const promoted = store.getSnapshot() as Session;
      expect(promoted).not.toBe(viewer);
      expect(viewer.destroyed).toBe(true);
      expect(promoted.doc.getText("source").toString()).toBe("trusted");
      promoted.doc.getText("source").insert(0, "valid ");
      expect(server.getText("source").toString()).toBe("valid trusted");
      expect(server.store.pendingStructs).toBeNull();
      expect(created).toHaveLength(3);
      // No listener on a destroyed session can replace the current one.
      editor.setRole("viewer");
      expect(store.getSnapshot()).toBe(promoted);
    } finally {
      store.stop();
      server.destroy();
    }
  });

  it("retains the current session when a replacement factory fails", () => {
    const server = new Y.Doc();
    let fail = false;
    const store = new CollabStore((value) => {
      if (fail) throw new Error("factory failed");
      return new Session(value, server);
    });
    try {
      const session = store.start(connection) as Session;
      fail = true;
      expect(() => store.start(connection)).toThrow("factory failed");
      expect(store.getSnapshot()).toBe(session);
      expect(session.destroyed).toBe(false);
    } finally {
      store.stop();
      server.destroy();
    }
  });
});
