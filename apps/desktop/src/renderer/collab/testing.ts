/**
 * In-memory room for tests: sessions share updates synchronously, as if relayed
 * by the server (including the server's rule that viewer document updates are
 * dropped). Not used in production code.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { participantColor, type Role } from "@kobrixa/collab-protocol";
import type { CollabConnection } from "../../shared/collab.js";
import type {
  CollabCloseReason,
  CollabParticipant,
  CollabSession,
  CollabSessionSnapshot,
} from "./types.js";

const RELAY = Symbol("relay");

export interface LinkedSession extends CollabSession {
  /** Simulates a server role change notice. */
  setRole(role: Role): void;
  /** Simulates the server closing this session. */
  close(reason: CollabCloseReason): void;
  /** Simulates a lost connection; the session waits in `reconnecting`. */
  drop(): void;
  /** Restores a dropped session and exchanges the state missed meanwhile. */
  reconnectNow(): void;
}

export interface LinkedRoom {
  sessions: LinkedSession[];
  /** Adds another participant that receives the current room state. */
  join(role?: Role, name?: string): LinkedSession;
}

export function createLinkedSessions(
  roles: readonly Role[] = ["host", "editor"],
  roomId = "test-room-0000000",
): LinkedRoom {
  const members: FakeSession[] = [];
  const roster = (): CollabParticipant[] =>
    members.map((member) => ({
      participantId: member.connection.participantId,
      name: member.connection.name,
      role: member.getSnapshot().role,
      online: member.getSnapshot().status === "connected",
    }));
  const broadcastRoster = (): void => {
    for (const member of members) member.update({ participants: roster() });
  };
  const join = (role: Role = "editor", name?: string): FakeSession => {
    const index = members.length;
    const session = new FakeSession(
      {
        serverUrl: "http://collab.test",
        roomId,
        participantId: `participant-${index}`,
        token: `token-${index}`,
        role,
        name: name ?? `User ${index + 1}`,
        projectName: "Test project",
        expiresAt: Date.now() + 60_000,
      },
      members,
      broadcastRoster,
    );
    const existing = members.find((member) => member.getSnapshot().status === "connected");
    if (existing) {
      Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(existing.doc), RELAY);
      const clients = [...existing.awareness.getStates().keys()];
      applyAwarenessUpdate(
        session.awareness,
        encodeAwarenessUpdate(existing.awareness, clients),
        RELAY,
      );
    }
    members.push(session);
    session.awareness.setLocalState({
      participantId: session.connection.participantId,
      name: session.connection.name,
      color: participantColor(index),
      role,
    });
    broadcastRoster();
    return session;
  };
  for (const role of roles) join(role);
  return { sessions: members, join };
}

class FakeSession implements LinkedSession {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly #listeners = new Set<() => void>();
  #snapshot: CollabSessionSnapshot;

  constructor(
    readonly connection: CollabConnection,
    private readonly members: FakeSession[],
    private readonly onRoster: () => void,
  ) {
    this.#snapshot = { status: "connected", role: connection.role, synced: true, participants: [] };
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY || !this.#live() || this.#snapshot.role === "viewer") return;
      for (const peer of this.#peers()) Y.applyUpdate(peer.doc, update, RELAY);
    });
    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === RELAY || !this.#live()) return;
        const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
        for (const peer of this.#peers()) applyAwarenessUpdate(peer.awareness, update, RELAY);
      },
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CollabSessionSnapshot => this.#snapshot;

  connect(): void {}

  disconnect(): void {
    this.close("left");
  }

  destroy(): void {
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  setRole(role: Role): void {
    this.update({ role });
    const state = this.awareness.getLocalState();
    if (state) this.awareness.setLocalState({ ...state, role });
    this.onRoster();
  }

  close(reason: CollabCloseReason): void {
    if (this.#snapshot.status === "closed") return;
    for (const peer of this.#peers())
      removeAwarenessStates(peer.awareness, [this.doc.clientID], RELAY);
    this.update({ status: "closed", closeReason: reason });
    this.onRoster();
  }

  drop(): void {
    if (!this.#live()) return;
    for (const peer of this.#peers())
      removeAwarenessStates(peer.awareness, [this.doc.clientID], RELAY);
    this.update({ status: "reconnecting" });
    this.onRoster();
  }

  reconnectNow(): void {
    if (this.#snapshot.status !== "reconnecting") return;
    this.update({ status: "connected" });
    for (const peer of this.#peers()) {
      if (this.#snapshot.role !== "viewer")
        Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(this.doc), RELAY);
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(peer.doc), RELAY);
    }
    const state = this.awareness.getLocalState();
    if (state) this.awareness.setLocalState({ ...state });
    this.onRoster();
  }

  update(patch: Partial<CollabSessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #live(): boolean {
    return this.#snapshot.status === "connected";
  }

  #peers(): FakeSession[] {
    return this.members.filter((member) => member !== this && member.#live());
  }
}
