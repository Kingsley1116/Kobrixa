import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CLOSE_CODE,
  COLLAB_LIMITS,
  DOC_KEYS,
  MESSAGE_TYPE,
  noticeSchema,
  type Notice,
  type Role,
} from "@kobrixa/collab-protocol";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/** Test entry: routes `https://test/<path>?room=<id>` straight to the room DO. */
const entry = `
import { CollabRoom as Room } from "./room.ts";
// Test-only reconstruction preserves the runtime's attached sockets and storage,
// exercising the same state restoration as a hibernation wake-up.
export class CollabRoom extends Room {
  restored;
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/reconstruct") {
      this.restored = new Room(this.ctx, this.env);
      return Response.json({});
    }
    if (path === "/inspect") {
      return Response.json({
        alarm: await this.ctx.storage.getAlarm(),
        updates: this.ctx.storage.sql.exec("SELECT COUNT(DISTINCT seq) AS count FROM doc_updates").one().count,
      });
    }
    if (path === "/expire") {
      await (this.restored ?? this).alarm();
      return Response.json({});
    }
    return this.restored ? this.restored.fetch(request) : super.fetch(request);
  }
  webSocketMessage(ws, message) {
    return this.restored ? this.restored.webSocketMessage(ws, message) : super.webSocketMessage(ws, message);
  }
  webSocketClose(ws, code, reason, clean) {
    return this.restored ? this.restored.webSocketClose(ws, code, reason, clean) : super.webSocketClose(ws, code, reason, clean);
  }
  webSocketError(ws, error) {
    return this.restored ? this.restored.webSocketError(ws, error) : super.webSocketError(ws, error);
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "room";
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(new Request("https://room" + url.pathname, request));
  },
};
`;

let script = "";
let persistDir = "";
let mf: Miniflare;

function createMiniflare(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-09-06",
      durableObjects: { ROOMS: { className: "CollabRoom", useSQLite: true } },
      resourcePersistencePath: persistDir,
    }),
  );
}

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: srcDir, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    alias: {
      "@kobrixa/collab-protocol": fileURLToPath(
        new URL("../../../packages/collab-protocol/src/index.ts", import.meta.url),
      ),
    },
  });
  script = bundle.outputFiles[0]?.text ?? "";
  persistDir = await mkdtemp(join(tmpdir(), "kobrixa-collab-"));
  mf = createMiniflare();
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  if (persistDir) await rm(persistDir, { recursive: true, force: true });
});

const HOST = "host-0001";
const GUEST = "guest-0001";

async function post(room: string, path: string, body: unknown, actor = HOST) {
  const response = await mf.dispatchFetch(`https://test${path}?room=${room}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Collab-Participant": actor },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function initRoom(room: string) {
  return post(room, "/init", {
    roomId: `${room}-room-id-0000`,
    projectName: "Line follower",
    inviteCode: "ABCD-EFGH-JKLM",
    host: { participantId: HOST, name: "Host" },
  });
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Opens a socket that the room is expected to reject; resolves with the close code. */
async function rejectedCloseCode(room: string, participantId: string): Promise<number> {
  const response = await mf.dispatchFetch(`https://test/ws?room=${room}`, {
    headers: { Upgrade: "websocket", "X-Collab-Participant": participantId },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no socket");
  let code: number | null = null;
  ws.addEventListener("close", (event) => {
    code = event.code;
  });
  ws.accept();
  await waitFor(() => code !== null, "rejected socket closed");
  return code ?? 0;
}

type MiniflareSocket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;

class Client {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly notices: Notice[] = [];
  closeCode: number | null = null;
  synced = false;

  private constructor(
    private readonly ws: MiniflareSocket,
    offlineEdits?: (client: Client) => void,
  ) {
    // Edits made before the listeners exist are never sent as updates; they only reach the
    // server through the server's own sync step 1.
    offlineEdits?.(this);
    ws.addEventListener("message", (event) => this.onMessage(event.data));
    ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on(
      "update",
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === this) return;
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_TYPE.awareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.send(encoding.toUint8Array(encoder));
      },
    );
  }

  static async connect(
    room: string,
    participantId: string,
    role: Role = "editor",
    offlineEdits?: (client: Client) => void,
  ) {
    const response = await mf.dispatchFetch(`https://test/ws?room=${room}`, {
      headers: {
        Upgrade: "websocket",
        "X-Collab-Participant": participantId,
        "X-Collab-Role": role,
        "X-Collab-Name": participantId,
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`upgrade failed: ${response.status}`);
    }
    response.webSocket.accept();
    const client = new Client(response.webSocket, offlineEdits);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
    syncProtocol.writeSyncStep1(encoder, client.doc);
    client.send(encoding.toUint8Array(encoder));
    await waitFor(() => client.synced, `${participantId} synced`);
    return client;
  }

  get text(): Y.Text {
    const text = this.doc.getMap<Y.Text>(DOC_KEYS.files).get("main.bas");
    if (!text) throw new Error("main.bas missing");
    return text;
  }

  get content(): string {
    return this.doc.getMap<Y.Text>(DOC_KEYS.files).get("main.bas")?.toString() ?? "";
  }

  lastNotice<T extends Notice["type"]>(type: T): Extract<Notice, { type: T }> | undefined {
    return this.notices.findLast((n): n is Extract<Notice, { type: T }> => n.type === type);
  }

  send(frame: Uint8Array) {
    if (this.closeCode === null) this.ws.send(frame);
  }

  close() {
    this.awareness.destroy();
    if (this.closeCode === null) this.ws.close(1000, "bye");
  }

  private onMessage(data: unknown) {
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBufferLike);
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_TYPE.sync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (syncType === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_TYPE.awareness) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    } else if (type === MESSAGE_TYPE.notice) {
      this.notices.push(noticeSchema.parse(JSON.parse(decoding.readVarString(decoder))));
    }
  }
}

function setText(client: Client, value: string) {
  client.doc.transact(() => {
    const files = client.doc.getMap<Y.Text>(DOC_KEYS.files);
    let text = files.get("main.bas");
    if (!text) {
      text = new Y.Text();
      files.set("main.bas", text);
    }
    text.delete(0, text.length);
    text.insert(0, value);
  });
}

describe("CollabRoom HTTP routes", () => {
  test("init, join and errors", async () => {
    expect((await post("routes", "/join", { participantId: GUEST, name: "Guest" })).status).toBe(
      404,
    );
    expect((await initRoom("routes")).status).toBe(200);
    expect(await initRoom("routes")).toEqual({ status: 409, body: { error: "bad-request" } });
    expect((await post("routes", "/init", { roomId: "x" })).status).toBe(400);

    expect(await post("routes", "/join", { participantId: GUEST, name: "Guest" })).toEqual({
      status: 200,
      body: { role: "editor", projectName: "Line follower" },
    });
    expect((await post("routes", "/kick", { participantId: "missing-0001" })).status).toBe(404);
    expect((await post("routes", "/kick", { participantId: HOST })).status).toBe(400);
    expect(
      (await post("routes", "/role", { participantId: "missing-0001", role: "viewer" })).status,
    ).toBe(404);

    expect((await post("routes", "/kick", { participantId: GUEST }, GUEST)).status).toBe(403);
    expect(
      (await post("routes", "/role", { participantId: GUEST, role: "viewer" }, GUEST)).status,
    ).toBe(403);

    // 2 registered; fill up to the limit.
    for (let i = 2; i < COLLAB_LIMITS.participants; i++) {
      const res = await post("routes", "/join", { participantId: `extra-${i}-0000`, name: "X" });
      expect(res.status).toBe(200);
    }
    expect(await post("routes", "/join", { participantId: "late-00000", name: "Late" })).toEqual({
      status: 409,
      body: { error: "room-full" },
    });
  });

  test("websocket upgrade is rejected for unknown participants and rooms", async () => {
    expect(await rejectedCloseCode("nowhere", HOST)).toBe(CLOSE_CODE.roomClosed);
    await initRoom("unknown");
    expect(await rejectedCloseCode("unknown", "nobody-0001")).toBe(CLOSE_CODE.unauthorized);
    const plain = await mf.dispatchFetch("https://test/ws?room=unknown");
    expect(plain.status).toBe(426);
  });
});

describe("CollabRoom realtime", () => {
  test("syncs edits, awareness, roles, kicks and persists across restarts", async () => {
    await initRoom("live");
    await post("live", "/join", { participantId: GUEST, name: "Guest" });

    const host = await Client.connect("live", HOST, "host");
    expect(host.doc.getMap(DOC_KEYS.meta).get("projectName")).toBe("Line follower");
    expect(host.doc.getMap(DOC_KEYS.control).get("holder")).toBe(HOST);
    expect(host.doc.getMap(DOC_KEYS.control).get("requests")).toEqual([]);
    expect(host.lastNotice("role")).toEqual({ type: "role", role: "host" });

    // The header role is not authoritative.
    const guest = await Client.connect("live", GUEST, "host");
    expect(guest.lastNotice("role")).toEqual({ type: "role", role: "editor" });

    await waitFor(
      () => host.lastNotice("participants")?.participants.every((p) => p.online) === true,
      "both online",
    );
    expect(host.lastNotice("participants")?.participants).toEqual([
      { participantId: HOST, name: "Host", role: "host", online: true },
      { participantId: GUEST, name: "Guest", role: "editor", online: true },
    ]);

    // Edits flow both ways.
    setText(host, "PRINT 1");
    await waitFor(() => guest.content === "PRINT 1", "host edit reaches guest");
    guest.text.insert(guest.text.length, "\nPRINT 2");
    await waitFor(() => host.content === "PRINT 1\nPRINT 2", "guest edit reaches host");

    // Awareness relays and is removed when the socket closes.
    host.awareness.setLocalState({
      participantId: HOST,
      name: "Host",
      color: "#e5484d",
      role: "host",
      file: "main.bas",
    });
    await waitFor(
      () => guest.awareness.getStates().get(host.doc.clientID)?.file === "main.bas",
      "awareness reaches guest",
    );
    guest.awareness.setLocalState({
      participantId: GUEST,
      name: "Guest",
      color: "#3e63dd",
      role: "editor",
    });
    await waitFor(() => host.awareness.getStates().has(guest.doc.clientID), "guest awareness");

    // Viewer edits are dropped, but viewers keep receiving updates.
    expect((await post("live", "/role", { participantId: GUEST, role: "viewer" })).status).toBe(
      200,
    );
    await waitFor(() => guest.lastNotice("role")?.role === "viewer", "role notice");
    await waitFor(
      () =>
        host.lastNotice("participants")?.participants.find((p) => p.participantId === GUEST)
          ?.role === "viewer",
      "participants rebroadcast",
    );
    guest.text.insert(0, "REM viewer\n");
    setText(host, "PRINT 3");
    await waitFor(() => guest.content.includes("PRINT 3"), "viewer receives updates");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.content).toBe("PRINT 3");

    // A viewer reconnecting with a stale "editor" token still cannot edit.
    const late = await Client.connect("live", GUEST, "editor");
    expect(late.lastNotice("role")).toEqual({ type: "role", role: "viewer" });
    expect(late.content).toBe("PRINT 3");
    late.close();

    // Kick closes with 4001 and revokes the participant.
    expect((await post("live", "/kick", { participantId: GUEST })).status).toBe(200);
    await waitFor(() => guest.closeCode !== null, "guest closed");
    expect(guest.closeCode).toBe(CLOSE_CODE.kicked);
    expect(guest.lastNotice("kicked")).toEqual({ type: "kicked" });
    await waitFor(
      () => !host.awareness.getStates().has(guest.doc.clientID),
      "kicked awareness removed",
    );
    await waitFor(
      () =>
        host
          .lastNotice("participants")
          ?.participants.map((p) => p.participantId)
          .join() === HOST,
      "kicked participant removed from roster",
    );
    expect(await rejectedCloseCode("live", GUEST)).toBe(CLOSE_CODE.unauthorized);
    expect((await post("live", "/join", { participantId: GUEST, name: "Guest" })).status).toBe(403);

    // Many updates trigger compaction; content must survive it and a restart.
    for (let i = 0; i < 250; i++) host.text.insert(host.text.length, ".");
    const expected = host.content;
    const synced = await Client.connect("live", HOST, "host");
    await waitFor(() => synced.content === expected, "all edits persisted before restart");
    const stats = await post("live", "/inspect", {});
    expect(stats.body.updates).toBeLessThan(200);
    synced.close();
    host.close();
    guest.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    await mf.dispose();
    mf = createMiniflare();
    const again = await Client.connect("live", HOST, "host");
    expect(again.content).toBe(expected);
    expect(again.doc.getMap(DOC_KEYS.meta).get("projectName")).toBe("Line follower");
    expect(again.lastNotice("participants")?.participants).toEqual([
      { participantId: HOST, name: "Host", role: "host", online: true },
    ]);
    again.close();
  }, 30_000);

  test("offline edits reach the server through its sync step 1", async () => {
    await initRoom("offline");
    const host = await Client.connect("offline", HOST, "host", (client) =>
      setText(client, "PRINT offline"),
    );
    const other = await Client.connect("offline", HOST, "host");
    await waitFor(() => other.content === "PRINT offline", "offline edit synced");
    host.close();
    other.close();
  });

  test("concurrent sockets beyond the limit are closed with roomFull", async () => {
    await initRoom("full");
    const clients: Client[] = [];
    for (let i = 0; i < COLLAB_LIMITS.participants; i++) {
      clients.push(await Client.connect("full", HOST, "host"));
    }
    expect(await rejectedCloseCode("full", HOST)).toBe(CLOSE_CODE.roomFull);
    for (const client of clients) client.close();
  }, 30_000);
});

describe("CollabRoom authorization and lifecycle", () => {
  test("restores presence and ownership when reconstructed with live sockets", async () => {
    await initRoom("sleeping");
    await post("sleeping", "/join", { participantId: GUEST, name: "Guest" });
    const host = await Client.connect("sleeping", HOST, "host");
    const guest = await Client.connect("sleeping", GUEST);
    setText(host, "PRINT awake");
    host.awareness.setLocalState({
      participantId: HOST,
      name: "Host",
      color: "#e5484d",
      role: "host",
    });
    await waitFor(
      () => guest.awareness.getStates().has(host.doc.clientID),
      "host presence before sleep",
    );
    expect((await post("sleeping", "/reconstruct", {})).status).toBe(200);
    const late = await Client.connect("sleeping", HOST, "host");
    expect(late.content).toBe("PRINT awake");
    await waitFor(
      () => late.awareness.getStates().has(host.doc.clientID),
      "restored presence immediately sent",
    );
    const forged = encoding.createEncoder();
    encoding.writeVarUint(forged, 1);
    encoding.writeVarUint(forged, host.doc.clientID);
    encoding.writeVarUint(forged, 999);
    encoding.writeVarString(
      forged,
      JSON.stringify({ participantId: GUEST, name: "Fake", color: "#000000", role: "host" }),
    );
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, MESSAGE_TYPE.awareness);
    encoding.writeVarUint8Array(frame, encoding.toUint8Array(forged));
    guest.send(encoding.toUint8Array(frame));
    guest.text.insert(0, "REM checkpoint\n");
    await waitFor(() => late.content.startsWith("REM checkpoint"), "forged awareness processed");
    expect(late.awareness.getStates().get(host.doc.clientID)?.name).toBe("Host");
    host.close();
    await waitFor(
      () => !late.awareness.getStates().has(host.doc.clientID),
      "restored ownership removed on close",
    );
    guest.close();
    late.close();
  });

  test("rejects forged control grants and revokes control when a controller becomes a viewer", async () => {
    await initRoom("control");
    await post("control", "/join", { participantId: GUEST, name: "Guest" });
    const host = await Client.connect("control", HOST, "host");
    const guest = await Client.connect("control", GUEST);
    guest.doc.getMap(DOC_KEYS.control).set("holder", GUEST);
    await waitFor(() => guest.closeCode !== null, "forged grant denied");
    expect(guest.closeCode).toBe(CLOSE_CODE.unauthorized);
    expect(host.doc.getMap(DOC_KEYS.control).get("holder")).toBe(HOST);
    const reconnect = await Client.connect("control", GUEST);
    reconnect.doc.getMap(DOC_KEYS.control).set("requests", [GUEST]);
    await waitFor(
      () => (host.doc.getMap(DOC_KEYS.control).get("requests") as string[]).includes(GUEST),
      "own request accepted",
    );
    host.doc.transact(() => {
      host.doc.getMap(DOC_KEYS.control).set("holder", GUEST);
      host.doc.getMap(DOC_KEYS.control).set("requests", []);
    });
    await waitFor(
      () => reconnect.doc.getMap(DOC_KEYS.control).get("holder") === GUEST,
      "host grant accepted",
    );
    reconnect.doc.getMap(DOC_KEYS.control).set("holder", HOST);
    await waitFor(
      () => host.doc.getMap(DOC_KEYS.control).get("holder") === HOST,
      "holder release accepted",
    );
    host.doc.getMap(DOC_KEYS.control).set("holder", GUEST);
    await waitFor(
      () => reconnect.doc.getMap(DOC_KEYS.control).get("holder") === GUEST,
      "second grant accepted",
    );
    await post("control", "/role", { participantId: GUEST, role: "viewer" });
    await waitFor(
      () => host.doc.getMap(DOC_KEYS.control).get("holder") === HOST,
      "downgrade returns control to host",
    );
    host.close();
    guest.close();
    reconnect.close();
  });

  test("preserves simultaneous control requests from stale whole-array edits", async () => {
    await initRoom("requests");
    const otherId = "other-0001";
    await post("requests", "/join", { participantId: GUEST, name: "Guest" });
    await post("requests", "/join", { participantId: otherId, name: "Other" });
    const host = await Client.connect("requests", HOST, "host");
    const a = await Client.connect("requests", GUEST);
    const b = await Client.connect("requests", otherId);
    a.doc.getMap(DOC_KEYS.control).set("requests", [GUEST]);
    b.doc.getMap(DOC_KEYS.control).set("requests", [otherId]);
    await waitFor(
      () => (host.doc.getMap(DOC_KEYS.control).get("requests") as string[]).length === 2,
      "both requests accepted",
    );
    for (const client of [host, a, b]) {
      await waitFor(
        () => (client.doc.getMap(DOC_KEYS.control).get("requests") as string[]).length === 2,
        "correction echoed to all clients",
      );
      expect(client.closeCode).toBeNull();
      client.close();
    }
  });

  test("enforces chat identity and trims history while accepting the next message", async () => {
    await initRoom("chat");
    await post("chat", "/join", { participantId: GUEST, name: "Guest" });
    const host = await Client.connect("chat", HOST, "host");
    const guest = await Client.connect("chat", GUEST);
    const messages = Array.from({ length: COLLAB_LIMITS.chatMessages }, (_, index) => ({
      id: `message-${index}`,
      participantId: HOST,
      name: "Host",
      text: `Hello ${index}`,
      at: Date.now(),
    }));
    host.doc.getArray(DOC_KEYS.chat).push(messages);
    await waitFor(
      () => guest.doc.getArray(DOC_KEYS.chat).length === COLLAB_LIMITS.chatMessages,
      "initial chat history",
    );
    guest.doc
      .getArray(DOC_KEYS.chat)
      .push([
        { id: "guest-message", participantId: GUEST, name: "Guest", text: "Next", at: Date.now() },
      ]);
    await waitFor(
      () =>
        host.doc.getArray<{ id: string }>(DOC_KEYS.chat).toArray().at(-1)?.id === "guest-message",
      "new message at cap accepted",
    );
    await waitFor(
      () => guest.doc.getArray(DOC_KEYS.chat).length === COLLAB_LIMITS.chatMessages,
      "trim echoed to author",
    );
    expect(host.doc.getArray<{ id: string }>(DOC_KEYS.chat).get(0).id).toBe("message-1");
    guest.doc
      .getArray(DOC_KEYS.chat)
      .push([{ id: "spoof", participantId: HOST, name: "Host", text: "Forged", at: Date.now() }]);
    await waitFor(() => guest.closeCode !== null, "spoofed chat rejected");
    expect(host.doc.getArray<{ id: string }>(DOC_KEYS.chat).toArray().at(-1)?.id).toBe(
      "guest-message",
    );
    host.close();
    guest.close();
  });

  test("reassembles SQLite snapshot chunks larger than a single storage row", async () => {
    await initRoom("chunks");
    const host = await Client.connect("chunks", HOST, "host");
    const expected = "x".repeat(900_000);
    host.doc.transact(() => {
      const files = host.doc.getMap<Y.Text>(DOC_KEYS.files);
      for (const path of ["main.bas", "second.bas", "third.bas"])
        files.set(path, new Y.Text(expected));
    });
    const verifier = await Client.connect("chunks", HOST, "host");
    await waitFor(() => verifier.content === expected, "large update reaches another client");
    host.close();
    verifier.close();
    await waitFor(
      () => host.closeCode !== null && verifier.closeCode !== null,
      "large room disconnected",
    );
    await post("chunks", "/reconstruct", {});
    const restored = await Client.connect("chunks", HOST, "host");
    for (const path of ["main.bas", "second.bas", "third.bas"]) {
      expect(restored.doc.getMap<Y.Text>(DOC_KEYS.files).get(path)?.toString()).toBe(expected);
    }
    restored.close();
  });

  test("deletes an idle room and cancels cleanup when a socket connects", async () => {
    const before = Date.now();
    await initRoom("idle");
    const scheduled = await post("idle", "/inspect", {});
    expect(scheduled.body.alarm).toBeGreaterThanOrEqual(before + COLLAB_LIMITS.idleRoomMs);
    const host = await Client.connect("idle", HOST, "host");
    expect((await post("idle", "/inspect", {})).body.alarm).toBeNull();
    await post("idle", "/expire", {});
    const other = await Client.connect("idle", HOST, "host");
    expect(other.doc.getMap(DOC_KEYS.meta).get("projectName")).toBe("Line follower");
    host.close();
    other.close();
    await waitFor(
      () => host.closeCode !== null && other.closeCode !== null,
      "all idle clients closed",
    );
    const disconnected = await post("idle", "/inspect", {});
    expect(disconnected.body.alarm).toBeGreaterThanOrEqual(before + COLLAB_LIMITS.idleRoomMs);
    await post("idle", "/expire", {});
    expect(await rejectedCloseCode("idle", HOST)).toBe(CLOSE_CODE.roomClosed);
    expect((await post("idle", "/join", { participantId: GUEST, name: "Guest" })).status).toBe(404);
  });
});
