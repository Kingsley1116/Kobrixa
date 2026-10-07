import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {
  CLOSE_CODE,
  MESSAGE_TYPE,
  participantColor,
  type Notice,
  type PresenceState,
  type Role,
} from "@kobrixa/collab-protocol";
import type { CollabConnection } from "../../shared/collab.js";
import {
  collabSocketUrl,
  createCollabSession,
  hashString,
  type CollabNetworkMonitor,
  type CollabSocket,
  type CollabSocketConstructor,
} from "./collab-session.js";
import { sharedTypes, type CollabSession } from "./types.js";

const RELAY = Symbol("relay");

/** Minimal in-process stand-in for the room Durable Object. */
class FakeRelay {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly sockets: FakeSocket[] = [];
  /** When false, new sockets fail to connect (closed with 1006). */
  accepting = true;
  roles = new Map<string, Role>();

  constructor() {
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      syncProtocol.writeUpdate(encoder, update);
      const frame = encoding.toUint8Array(encoder);
      for (const socket of this.live()) if (socket !== origin) socket.deliver(frame);
    });
  }

  readonly WebSocket: CollabSocketConstructor = socketClassFor(this);

  live(): FakeSocket[] {
    return this.sockets.filter((socket) => socket.readyState === 1);
  }

  accept(socket: FakeSocket): void {
    if (socket.readyState !== 0) return;
    if (!this.accepting) {
      socket.serverClose(1006);
      return;
    }
    socket.readyState = 1;
    socket.onopen?.({});
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    socket.deliver(encoding.toUint8Array(encoder));
    const clients = [...this.awareness.getStates().keys()];
    if (clients.length > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_TYPE.awareness);
      encoding.writeVarUint8Array(awarenessEncoder, encodeAwarenessUpdate(this.awareness, clients));
      socket.deliver(encoding.toUint8Array(awarenessEncoder));
    }
  }

  receive(socket: FakeSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_TYPE.sync) {
      const syncType = decoding.peekVarUint(decoder);
      const viewer = this.roles.get(socket.token) === "viewer";
      if (viewer && syncType !== syncProtocol.messageYjsSyncStep1) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, socket);
      if (encoding.length(encoder) > 1) socket.deliver(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_TYPE.awareness) {
      const update = decoding.readVarUint8Array(decoder);
      applyAwarenessUpdate(this.awareness, update, RELAY);
      for (const peer of this.live()) if (peer !== socket) peer.deliver(data);
    }
  }

  notice(socket: FakeSocket, notice: Notice): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.notice);
    encoding.writeVarString(encoder, JSON.stringify(notice));
    socket.deliver(encoding.toUint8Array(encoder));
  }
}

class FakeSocket implements CollabSocket {
  binaryType = "blob";
  readyState = 0;
  onopen: CollabSocket["onopen"] = null;
  onmessage: CollabSocket["onmessage"] = null;
  onclose: CollabSocket["onclose"] = null;
  onerror: CollabSocket["onerror"] = null;
  readonly token: string;
  closedWith: number | null = null;

  constructor(
    readonly url: string,
    private readonly relay: FakeRelay,
  ) {
    this.token = new URL(url).searchParams.get("token") ?? "";
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("not open");
    const copy = data.slice();
    // Frames sent before `close()` are still flushed, as with a real socket.
    queueMicrotask(() => this.relay.receive(this, copy));
  }

  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.closedWith = code;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }

  /** Server → client frame. */
  deliver(frame: Uint8Array): void {
    const buffer = frame.slice().buffer;
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: buffer });
    });
  }

  /** Server-initiated close (or network drop with 1006). */
  serverClose(code: number): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
}

function socketClassFor(relay: FakeRelay): CollabSocketConstructor {
  return class extends FakeSocket {
    constructor(url: string) {
      super(url, relay);
      relay.sockets.push(this);
      queueMicrotask(() => relay.accept(this));
    }
  };
}

class ManualTimers {
  #next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.pending.set(id, { callback, ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  runAll(): void {
    const entries = [...this.pending];
    this.pending.clear();
    for (const [, { callback }] of entries) callback();
  }
}

class FakeNetwork implements CollabNetworkMonitor {
  online = true;
  readonly #listeners = new Set<(online: boolean) => void>();
  isOnline = (): boolean => this.online;
  subscribe = (listener: (online: boolean) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  set(online: boolean): void {
    this.online = online;
    for (const listener of this.#listeners) listener(online);
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function connection(index: number, role: Role = "editor"): CollabConnection {
  return {
    serverUrl: "https://collab.example.com/",
    roomId: "room-abcdefgh",
    participantId: `participant-${index}`,
    token: `token ${index}/+=`,
    role,
    name: `User ${index}`,
    projectName: "Project",
    expiresAt: Date.now() + 60_000,
  };
}

const sessions: CollabSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
});

function setup(network: FakeNetwork | null = null) {
  const relay = new FakeRelay();
  const timers = new ManualTimers();
  const open = (index: number, role: Role = "editor"): CollabSession => {
    relay.roles.set(`token ${index}/+=`, role);
    const session = createCollabSession(connection(index, role), {
      WebSocket: relay.WebSocket,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0.5,
      network,
    });
    sessions.push(session);
    session.connect();
    return session;
  };
  return { relay, timers, open };
}

function text(session: CollabSession, path = "main.bp"): Y.Text {
  const files = sharedTypes(session.doc).files;
  let value = files.get(path);
  if (!value) {
    value = new Y.Text();
    files.set(path, value);
  }
  return value;
}

describe("collabSocketUrl", () => {
  it("switches to ws(s) and encodes the token", () => {
    expect(collabSocketUrl(connection(1))).toBe(
      "wss://collab.example.com/rooms/room-abcdefgh/ws?token=token%201%2F%2B%3D",
    );
    expect(collabSocketUrl({ ...connection(1), serverUrl: "http://localhost:8787" })).toMatch(
      /^ws:\/\/localhost:8787\/rooms\/room-abcdefgh\/ws\?token=/,
    );
  });
});

describe("createCollabSession", () => {
  it("syncs, sets local presence and reports status transitions", async () => {
    const { relay, open } = setup();
    const session = open(1);
    const statuses: string[] = [];
    session.subscribe(() => statuses.push(session.getSnapshot().status));
    const before = session.getSnapshot();
    expect(before.status).toBe("connecting");
    expect(session.awareness.getLocalState()).toEqual({
      participantId: "participant-1",
      name: "User 1",
      color: participantColor(hashString("participant-1")),
      role: "editor",
    } satisfies PresenceState);
    await flush();
    expect(relay.sockets[0]?.binaryType).toBe("arraybuffer");
    expect(statuses).toEqual(["syncing", "connected"]);
    expect(session.getSnapshot()).toMatchObject({ status: "connected", synced: true });
    expect(session.getSnapshot()).not.toBe(before);
  });

  it("converges two clients on concurrent edits and shares awareness", async () => {
    const { open } = setup();
    const a = open(1);
    const b = open(2);
    await flush();
    text(a).insert(0, "hello");
    await flush();
    expect(text(b).toString()).toBe("hello");

    text(a).insert(5, " A");
    text(b).insert(0, "B ");
    await flush();
    expect(text(a).toString()).toBe(text(b).toString());
    expect(text(a).toString()).toContain("A");
    expect(text(a).toString()).toContain("B ");

    const remote = [...b.awareness.getStates().values()] as PresenceState[];
    expect(remote.map((state) => state.participantId).sort()).toEqual([
      "participant-1",
      "participant-2",
    ]);
    a.awareness.setLocalStateField("file", "main.bp");
    await flush();
    expect(b.awareness.getStates().get(a.doc.clientID)).toMatchObject({ file: "main.bp" });
  });

  it("applies participants and role notices", async () => {
    const { relay, open } = setup();
    const a = open(1);
    const b = open(2);
    await flush();
    const participants = [
      { participantId: "participant-1", name: "User 1", role: "editor" as const, online: true },
    ];
    relay.notice(relay.sockets[0]!, { type: "participants", participants });
    relay.notice(relay.sockets[0]!, { type: "role", role: "viewer" });
    await flush();
    expect(a.getSnapshot().participants).toEqual(participants);
    expect(a.getSnapshot().role).toBe("viewer");
    expect(a.awareness.getLocalState()).toMatchObject({ role: "viewer" });
    expect(b.awareness.getStates().get(a.doc.clientID)).toMatchObject({ role: "viewer" });
  });

  it("ignores invalid notices", async () => {
    const { relay, open } = setup();
    const a = open(1);
    await flush();
    const before = a.getSnapshot();
    relay.notice(relay.sockets[0]!, { type: "role", role: "owner" } as unknown as Notice);
    await flush();
    expect(a.getSnapshot()).toBe(before);
  });

  it("closes terminally on kick without reconnecting", async () => {
    const { relay, timers, open } = setup();
    const a = open(1);
    await flush();
    relay.sockets[0]!.serverClose(CLOSE_CODE.kicked);
    await flush();
    expect(a.getSnapshot()).toMatchObject({ status: "closed", closeReason: "kicked" });
    expect(timers.pending.size).toBe(0);
    expect(relay.sockets).toHaveLength(1);
  });

  it.each([
    [CLOSE_CODE.unauthorized, "unauthorized"],
    [CLOSE_CODE.roomClosed, "room-closed"],
    [CLOSE_CODE.roomFull, "error"],
    [CLOSE_CODE.protocolMismatch, "error"],
  ])("maps close code %i to %s", async (code, reason) => {
    const { relay, timers, open } = setup();
    const a = open(1);
    await flush();
    relay.sockets[0]!.serverClose(code);
    await flush();
    expect(a.getSnapshot()).toMatchObject({ status: "closed", closeReason: reason });
    expect(timers.pending.size).toBe(0);
  });

  it("closes on kicked and room-closed notices", async () => {
    const { relay, open } = setup();
    const a = open(1);
    const b = open(2);
    await flush();
    relay.notice(relay.sockets[0]!, { type: "kicked" });
    relay.notice(relay.sockets[1]!, { type: "room-closed" });
    await flush();
    expect(a.getSnapshot()).toMatchObject({ status: "closed", closeReason: "kicked" });
    expect(b.getSnapshot()).toMatchObject({ status: "closed", closeReason: "room-closed" });
    expect(relay.sockets[0]!.closedWith).toBe(1000);
  });

  it("reconnects with backoff and resyncs edits made while offline", async () => {
    const { relay, timers, open } = setup();
    const a = open(1);
    const b = open(2);
    await flush();
    text(a).insert(0, "base");
    await flush();

    relay.accepting = false;
    relay.sockets[0]!.serverClose(1006);
    await flush();
    expect(a.getSnapshot()).toMatchObject({ status: "reconnecting", synced: true });
    expect(a.awareness.getStates().size).toBe(1);
    const delays = [...timers.pending.values()].map((timer) => timer.ms);
    expect(delays).toEqual([375]); // 500ms base with 0.5 jitter factor → 375

    text(a).insert(4, " offline");
    text(b).insert(0, "online ");
    await flush();
    timers.runAll(); // first retry is refused
    await flush();
    expect(a.getSnapshot().status).toBe("reconnecting");
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([750]);

    relay.accepting = true;
    timers.runAll();
    await flush();
    expect(a.getSnapshot().status).toBe("connected");
    expect(text(a).toString()).toBe("online base offline");
    expect(text(b).toString()).toBe("online base offline");
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(true);
  });

  it("does not open a second socket when connect() is called during a retry", async () => {
    const { relay, timers, open } = setup();
    const a = open(1);
    await flush();
    relay.sockets[0]!.serverClose(1006);
    await flush();
    a.connect(); // "retry now" while waiting: opens immediately
    expect(timers.pending.size).toBe(0);
    a.connect(); // attempt already in flight
    await flush();
    expect(relay.sockets).toHaveLength(2);
    expect(a.getSnapshot().status).toBe("connected");
  });

  it("stops retrying once the token has expired", async () => {
    const relay = new FakeRelay();
    const timers = new ManualTimers();
    const session = createCollabSession(
      { ...connection(1), expiresAt: Date.now() - 1 },
      { WebSocket: relay.WebSocket, ...timers, network: null },
    );
    sessions.push(session);
    session.connect();
    expect(session.getSnapshot()).toMatchObject({ status: "closed", closeReason: "unauthorized" });
    expect(relay.sockets).toHaveLength(0);
  });

  it("pauses while offline and resumes when back online", async () => {
    const network = new FakeNetwork();
    const { relay, timers, open } = setup(network);
    const a = open(1);
    await flush();
    network.set(false);
    expect(a.getSnapshot().status).toBe("reconnecting");
    await flush();
    expect(timers.pending.size).toBe(0);
    expect(relay.sockets[0]!.readyState).toBe(3);
    network.set(true);
    await flush();
    expect(a.getSnapshot().status).toBe("connected");
    expect(relay.sockets).toHaveLength(2);
  });

  it("disconnect and destroy close the socket and clear presence", async () => {
    const { relay, timers, open } = setup();
    const a = open(1);
    const b = open(2);
    await flush();
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(true);
    a.disconnect();
    await flush();
    expect(a.getSnapshot()).toMatchObject({ status: "closed", closeReason: "left" });
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(false);
    expect(timers.pending.size).toBe(0);

    b.destroy();
    expect(b.getSnapshot().status).toBe("closed");
    expect(b.awareness.getLocalState()).toBeNull();
    expect(relay.sockets[1]!.readyState).toBe(3);
  });

  it("drops a viewer's edits at the relay but still receives others", async () => {
    const { relay, open } = setup();
    const host = open(1, "host");
    const viewer = open(2, "viewer");
    await flush();
    text(host).insert(0, "shared");
    await flush();
    expect(text(viewer).toString()).toBe("shared");
    expect(relay.doc.getMap("files").size).toBe(1);
  });
});
