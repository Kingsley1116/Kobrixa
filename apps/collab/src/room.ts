import {
  CLOSE_CODE,
  COLLAB_LIMITS,
  DOC_KEYS,
  MESSAGE_TYPE,
  displayNameSchema,
  inviteCodeSchema,
  kickRequestSchema,
  participantIdSchema,
  presenceStateSchema,
  roomIdSchema,
  roomPasswordSchema,
  setRoleRequestSchema,
  sendChatRequestSchema,
  type ChatMessage,
  type ErrorResponse,
  type Notice,
} from "@kobrixa/collab-protocol";
import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { z } from "zod";
import type { CollabEnv } from "./env.js";
import {
  decodeAwarenessUpdate,
  encodeAwarenessFrame,
  encodeAwarenessUpdate,
  encodeNotice,
  type AwarenessEntry,
} from "./room/frames.js";
import { RoomStore, type ParticipantRow } from "./room/store.js";
import { roomDoc, validateUpdate } from "./room/validate.js";
import { createPasswordVerifier, verifyPassword } from "./password.js";

/** Stored updates after which the document is compacted into one snapshot. */
export const COMPACT_AFTER_UPDATES = 200;
/** Awareness client ids tracked per socket (keeps the attachment well below 2 KB). */
const MAX_AWARENESS_CLIENTS_PER_SOCKET = 8;

const initRequestSchema = z
  .object({
    roomId: roomIdSchema,
    projectName: z.string().trim().min(1).max(120),
    inviteCode: inviteCodeSchema,
    host: z.object({ participantId: participantIdSchema, name: displayNameSchema }).strict(),
    password: roomPasswordSchema.optional(),
    credentialHash: z.string().length(43).optional(),
  })
  .strict();

const joinRequestSchema = z
  .object({
    participantId: participantIdSchema,
    name: displayNameSchema,
    password: roomPasswordSchema.optional(),
    clientKey: z.string().min(1).max(64).default("internal"),
    credentialHash: z.string().length(43).optional(),
  })
  .strict();

/** Survives hibernation via `serializeAttachment`. */
type SocketAttachment = {
  participantId: string;
  socketId: string;
  /** Awareness client id → last seen clock, for cleanup when the socket closes. */
  clients: Record<string, number>;
};

type AwarenessRecord = AwarenessEntry & { socketId: string };

function error(status: number, code: ErrorResponse["error"]): Response {
  return Response.json({ error: code } satisfies ErrorResponse, { status });
}

/** Completes the upgrade and immediately closes the socket with `code`. */
function rejectSocket(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * One Durable Object per room. Relays y-protocols sync/awareness frames between
 * participants and persists the room's Y.Doc in DO SQLite storage.
 *
 * The Worker (src/index.ts) verifies the room token before forwarding the
 * WebSocket upgrade and passes the verified identity in these headers:
 * `X-Collab-Participant`, `X-Collab-Role`, `X-Collab-Name`. Only the participant id
 * is used: the role and name stored here are authoritative (the header role comes from
 * a token that may be days old; the percent-encoded header name is never decoded).
 *
 * Internal routes (called by the Worker only):
 * - `POST /init`  `{roomId, projectName, inviteCode, host: {participantId, name}, password?}`
 * - `POST /join`  `{participantId, name, password?, clientKey}` → `{role, projectName}`
 * - `POST /kick`  `{participantId}`
 * - `POST /role`  `{participantId, role}`
 * - `GET  /ws`    WebSocket upgrade; rejections are accepted then closed with
 *                 4004 (not initialized), 4003 (unknown/revoked) or 4009 (full)
 */
export class CollabRoom extends DurableObject<CollabEnv> {
  private readonly store: RoomStore;
  /** Loaded lazily, also after waking up from hibernation. */
  private doc: Y.Doc | null = null;
  private updatesSinceSnapshot = 0;
  /**
   * Last known awareness state per client id, restored from SQLite for attached
   * sockets after hibernation. Ownership must survive even before the next heartbeat.
   */
  private readonly awareness = new Map<number, AwarenessRecord>();
  /** Sockets already cleaned up (closed by us or reported closed). */
  private readonly gone = new WeakSet<WebSocket>();
  private expired = false;

  constructor(ctx: DurableObjectState, env: CollabEnv) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage.sql);
    this.store.migrate();
    for (const ws of ctx.getWebSockets()) {
      const attachment = this.attachment(ws);
      if (!attachment) continue;
      for (const entry of this.store.awareness(attachment.socketId)) {
        this.awareness.set(entry.clientId, { ...entry, socketId: attachment.socketId });
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (this.expired) {
      this.store.migrate();
      this.expired = false;
    }
    try {
      if (request.method === "GET" && pathname === "/ws") return await this.acceptSocket(request);
      if (request.method === "POST") {
        if (pathname !== "/init" && this.store.isClosed()) return error(410, "room-closed");
        const body: unknown = await request.json().catch(() => undefined);
        switch (pathname) {
          case "/init":
            return await this.init(body);
          case "/join":
            return await this.join(body);
          case "/resume":
            return this.resume(body);
          case "/close":
            return this.isHost(request) ? await this.closeRoom() : error(403, "forbidden");
          case "/chat":
            return this.chat(request, body);
          case "/kick":
            return this.isHost(request) ? this.kick(body) : error(403, "forbidden");
          case "/role":
            return this.isHost(request) ? this.setRole(body) : error(403, "forbidden");
        }
      }
      return error(404, "not-found");
    } catch (cause) {
      console.error("collab room request failed", cause);
      return error(500, "internal");
    }
  }

  // ---------------------------------------------------------------- routes

  private async init(body: unknown): Promise<Response> {
    const parsed = initRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, "bad-request");
    if (this.store.meta()) return error(409, "bad-request");
    const { roomId, projectName, inviteCode, host, password } = parsed.data;
    const secret = this.env.COLLAB_SECRET;
    if (password && !secret) return error(503, "internal");
    const verifier = password ? await createPasswordVerifier(secret!, roomId, password) : null;
    // Another /init can arrive while Web Crypto is pending.
    if (this.store.meta()) return error(409, "bad-request");
    const now = Date.now();
    const initial = roomDoc();
    initial.transact(() => {
      initial.getMap(DOC_KEYS.meta).set("projectName", projectName);
      initial.getMap(DOC_KEYS.control).set("holder", host.participantId);
      initial.getMap(DOC_KEYS.control).set("requests", []);
    });
    const snapshot = Y.encodeStateAsUpdate(initial);
    initial.destroy();
    this.ctx.storage.transactionSync(() => {
      this.store.setMeta({
        roomId,
        projectName,
        inviteCode,
        hostId: host.participantId,
        createdAt: now,
      });
      this.store.addParticipant({
        participantId: host.participantId,
        name: host.name,
        role: "host",
        joinedAt: now,
      });
      if (verifier) this.store.setPassword(verifier);
      if (parsed.data.credentialHash)
        this.store.setCredential(host.participantId, parsed.data.credentialHash);
      this.store.appendUpdate(snapshot);
    });
    await this.scheduleIdleCleanup();
    return Response.json({});
  }

  private async join(body: unknown): Promise<Response> {
    const parsed = joinRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, "bad-request");
    const meta = this.store.meta();
    if (!meta) return error(404, "not-found");
    const { participantId, name, password, clientKey } = parsed.data;
    const verifier = this.store.password();
    if (verifier) {
      const secret = this.env.COLLAB_SECRET;
      if (!secret) return error(503, "internal");
      if (!password) return error(401, "password-required");
      if (!this.store.takePasswordAttempt(clientKey, Date.now())) {
        return Response.json(
          { error: "rate-limited" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      if (!(await verifyPassword(secret, meta.roomId, password, verifier)))
        return error(401, "invalid-password");
      // An idle-room alarm may run while the password is being derived.
      if (this.store.isClosed()) return error(410, "room-closed");
      const current = this.store.meta();
      if (!current || current.createdAt !== meta.createdAt || current.roomId !== meta.roomId)
        return error(404, "not-found");
      this.store.clearPasswordAttempts(clientKey);
    }
    const existing = this.store.participant(participantId);
    if (existing) {
      if (existing.revoked) return error(403, "forbidden");
      if (existing.name !== name) {
        this.store.setName(participantId, name);
        this.broadcastParticipants();
      }
      return Response.json({ role: existing.role, projectName: meta.projectName });
    }
    if (this.onlineParticipants().size >= COLLAB_LIMITS.participants) {
      return error(409, "room-full");
    }
    this.store.addParticipant({ participantId, name, role: "editor", joinedAt: Date.now() });
    if (parsed.data.credentialHash)
      this.store.setCredential(participantId, parsed.data.credentialHash);
    this.broadcastParticipants();
    if (this.openSockets().length === 0) await this.scheduleIdleCleanup();
    return Response.json({ role: "editor", projectName: meta.projectName });
  }

  private resume(body: unknown): Response {
    const parsed = z
      .object({ participantId: participantIdSchema, credentialHash: z.string().length(43) })
      .safeParse(body);
    if (!parsed.success) return error(400, "bad-request");
    const meta = this.store.meta();
    if (!meta) return error(404, "not-found");
    const participant = this.store.participant(parsed.data.participantId);
    const hash = this.store.credential(parsed.data.participantId);
    if (
      !hash ||
      !crypto.subtle.timingSafeEqual(
        new TextEncoder().encode(hash),
        new TextEncoder().encode(parsed.data.credentialHash),
      )
    )
      return error(401, "unauthorized");
    if (!participant || participant.revoked) return error(403, "removed");
    return Response.json({
      participantId: participant.participantId,
      role: participant.role,
      name: participant.name,
      projectName: meta.projectName,
      inviteCode: meta.inviteCode,
    });
  }

  private async closeRoom(): Promise<Response> {
    this.doc?.destroy();
    this.doc = null;
    this.ctx.storage.transactionSync(() => this.store.close());
    for (const socket of this.openSockets()) {
      this.send(socket, encodeNotice({ type: "room-closed" }));
      this.closeSocket(socket, CLOSE_CODE.roomClosed, "room closed");
    }
    this.awareness.clear();
    await this.scheduleIdleCleanup();
    return Response.json({});
  }

  private chat(request: Request, body: unknown): Response {
    const actor = this.store.participant(request.headers.get("X-Collab-Participant") ?? "");
    if (!actor || actor.revoked) return error(403, "removed");
    if (!this.onlineParticipants().has(actor.participantId)) return error(409, "bad-request");
    const parsed = sendChatRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, "bad-request");
    const doc = this.ensureDoc();
    const chat = doc.getArray<ChatMessage>(DOC_KEYS.chat);
    const existing =
      this.store.chatReceipt(parsed.data.id) ??
      chat.toArray().find((message) => message.id === parsed.data.id);
    if (existing)
      return existing.participantId === actor.participantId && existing.text === parsed.data.text
        ? Response.json(existing)
        : error(400, "bad-request");
    const message: ChatMessage = {
      ...parsed.data,
      participantId: actor.participantId,
      name: actor.name,
      at: Date.now(),
    };
    doc.transact(() => {
      chat.push([message]);
      if (chat.length > COLLAB_LIMITS.chatMessages)
        chat.delete(0, chat.length - COLLAB_LIMITS.chatMessages);
    });
    this.store.rememberChat(message);
    return Response.json(message);
  }

  private onlineParticipants(): Set<string> {
    return new Set(
      this.openSockets()
        .map((socket) => this.attachment(socket)?.participantId)
        .filter((id): id is string => !!id),
    );
  }

  private kick(body: unknown): Response {
    const parsed = kickRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, "bad-request");
    const { participantId } = parsed.data;
    const participant = this.store.participant(participantId);
    if (!this.store.meta() || !participant || participant.revoked) return error(404, "not-found");
    if (participant.role === "host") return error(400, "bad-request");
    this.store.revoke(participantId);
    this.removeControl(participantId);
    const kicked = encodeNotice({ type: "kicked" });
    for (const ws of this.ctx.getWebSockets(participantId)) {
      this.send(ws, kicked);
      this.release(ws);
      try {
        ws.close(CLOSE_CODE.kicked, "kicked");
      } catch {
        // already closed
      }
    }
    this.broadcastParticipants();
    return Response.json({});
  }

  private setRole(body: unknown): Response {
    const parsed = setRoleRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, "bad-request");
    const { participantId, role } = parsed.data;
    const participant = this.store.participant(participantId);
    if (!this.store.meta() || !participant || participant.revoked) return error(404, "not-found");
    if (participant.role === "host") return error(400, "bad-request");
    if (participant.role !== role) {
      this.store.setRole(participantId, role);
      const notice = encodeNotice({ type: "role", role });
      // Notify the changed participant before revoking its request/holder. A
      // still-editor DeviceControl would otherwise reassert a removed request
      // in response to the update, creating a viewer update that must be dropped.
      for (const ws of this.ctx.getWebSockets(participantId)) this.send(ws, notice);
      if (role === "viewer") this.removeControl(participantId);
      this.broadcastParticipants();
    }
    return Response.json({});
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    // Rejections are delivered as close codes: browsers only see 1006 for a failed upgrade.
    if (!this.store.meta() || this.store.isClosed())
      return rejectSocket(CLOSE_CODE.roomClosed, "room closed");
    const participantId = request.headers.get("X-Collab-Participant") ?? "";
    const participant = this.store.participant(participantId);
    if (!participant || participant.revoked) {
      return rejectSocket(CLOSE_CODE.unauthorized, "unauthorized");
    }
    const online = this.onlineParticipants();
    if (!online.has(participantId) && online.size >= COLLAB_LIMITS.participants) {
      return rejectSocket(CLOSE_CODE.roomFull, "room full");
    }

    for (const previous of this.openSockets()) {
      if (this.attachment(previous)?.participantId === participantId)
        this.closeSocket(previous, CLOSE_CODE.sessionReplaced, "session replaced");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [participantId]);
    server.serializeAttachment({
      participantId,
      socketId: crypto.randomUUID(),
      clients: {},
    } satisfies SocketAttachment);
    await this.ctx.storage.deleteAlarm();

    const doc = this.ensureDoc();
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_TYPE.sync);
    syncProtocol.writeSyncStep1(step1, doc);
    this.send(server, encoding.toUint8Array(step1));
    if (this.awareness.size > 0) {
      this.send(server, encodeAwarenessFrame(encodeAwarenessUpdate([...this.awareness.values()])));
    }
    this.send(server, encodeNotice({ type: "role", role: participant.role }));
    this.broadcastParticipants();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------ websockets

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (this.gone.has(ws)) return;
    if (typeof message === "string") {
      this.closeSocket(ws, 1003, "binary frames only");
      return;
    }
    if (message.byteLength > COLLAB_LIMITS.documentBytes) {
      this.closeSocket(ws, CLOSE_CODE.protocolMismatch, "frame too large");
      return;
    }
    const attachment = this.attachment(ws);
    const participant = attachment ? this.store.participant(attachment.participantId) : null;
    if (!attachment || !participant || participant.revoked) {
      this.closeSocket(ws, CLOSE_CODE.unauthorized, "unauthorized");
      return;
    }
    try {
      const decoder = decoding.createDecoder(new Uint8Array(message));
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_TYPE.sync) {
        this.handleSync(ws, decoder, participant);
      } else if (type === MESSAGE_TYPE.awareness) {
        this.handleAwareness(ws, attachment, decoding.readVarUint8Array(decoder));
      }
      // Other message types are server → client only; ignore them.
    } catch (cause) {
      console.warn("collab room: invalid frame", cause);
      this.closeSocket(ws, 1007, "invalid frame");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    this.closeSocket(ws, code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "");
    await this.afterDisconnect();
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.closeSocket(ws, 1011, "socket error");
    await this.afterDisconnect();
  }

  override async alarm(): Promise<void> {
    if (this.openSockets().length > 0) return;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.doc?.destroy();
    this.doc = null;
    this.updatesSinceSnapshot = 0;
    this.awareness.clear();
    this.expired = true;
  }

  private handleSync(ws: WebSocket, decoder: decoding.Decoder, participant: ParticipantRow): void {
    const doc = this.ensureDoc();
    const syncType = decoding.readVarUint(decoder);
    if (syncType === syncProtocol.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      syncProtocol.readSyncStep1(decoder, encoder, doc);
      this.send(ws, encoding.toUint8Array(encoder));
    } else if (
      syncType === syncProtocol.messageYjsSyncStep2 ||
      syncType === syncProtocol.messageYjsUpdate
    ) {
      // Viewers receive state but their edits are dropped.
      if (participant.role === "viewer") return;
      const update = decoding.readVarUint8Array(decoder);
      let corrections: { requests?: string[] };
      try {
        corrections = validateUpdate(doc, update, participant, this.store.activeParticipants());
      } catch {
        this.closeSocket(ws, CLOSE_CODE.unauthorized, "invalid document update");
        return;
      }
      // Emit corrections in the same transaction, so other clients never observe
      // a stale request list or an unbounded chat history.
      doc.transact((transaction) => {
        const ownClock = Y.getState(doc.store, doc.clientID);
        Y.applyUpdate(doc, update, ws);
        // applyUpdate marks the transaction remote. Trusted corrections below
        // are local; avoid Yjs treating them as a collision with its own id.
        // Preserve collision detection when the incoming update used that id.
        if (Y.getState(doc.store, doc.clientID) === ownClock) transaction.local = true;
        if (corrections.requests)
          doc.getMap(DOC_KEYS.control).set("requests", corrections.requests);
        const chat = doc.getArray(DOC_KEYS.chat);
        if (chat.length > COLLAB_LIMITS.chatMessages)
          chat.delete(0, chat.length - COLLAB_LIMITS.chatMessages);
      }, ws);
    } else {
      throw new Error(`unknown sync message ${syncType}`);
    }
  }

  private handleAwareness(ws: WebSocket, attachment: SocketAttachment, update: Uint8Array): void {
    const accepted: AwarenessEntry[] = [];
    const participant = this.store.participant(attachment.participantId);
    if (!participant) return;
    for (const entry of decodeAwarenessUpdate(update)) {
      const key = String(entry.clientId);
      const known = this.awareness.get(entry.clientId);
      if (known && known.socketId !== attachment.socketId) continue;
      if (
        this.openSockets().some((other) => {
          if (other === ws) return false;
          const owner = this.attachment(other);
          return owner && key in owner.clients;
        })
      )
        continue;
      if (
        !(key in attachment.clients) &&
        Object.keys(attachment.clients).length >= MAX_AWARENESS_CLIENTS_PER_SOCKET
      )
        continue;
      const lastClock = known?.clock ?? attachment.clients[key] ?? -1;
      if (entry.clock < lastClock || (entry.clock === lastClock && entry.state !== "null"))
        continue;
      if (entry.state === "null") {
        this.awareness.delete(entry.clientId);
        this.store.removeAwareness(attachment.socketId, entry.clientId);
      } else {
        const parsed: unknown = JSON.parse(entry.state);
        if (!parsed || typeof parsed !== "object") continue;
        const state = presenceStateSchema.safeParse({
          ...parsed,
          participantId: participant.participantId,
          name: participant.name,
          role: participant.role,
        });
        // Awareness starts as {} before the renderer has published its presence.
        if (!state.success) continue;
        entry.state = JSON.stringify(state.data);
        this.store.setAwareness(attachment.socketId, entry.clientId, entry.clock, entry.state);
        this.awareness.set(entry.clientId, { ...entry, socketId: attachment.socketId });
      }
      // Retain clocks for removed states, so stale heartbeats cannot resurrect them.
      attachment.clients[key] = entry.clock;
      accepted.push(entry);
    }
    if (accepted.length > 0) {
      ws.serializeAttachment(attachment);
      this.broadcast(encodeAwarenessFrame(encodeAwarenessUpdate(accepted)), ws);
    }
  }

  /** Closes a socket (if still open) and removes its presence. Idempotent. */
  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    this.release(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  /** Forgets a socket: removes its awareness states and updates the roster. */
  private release(ws: WebSocket): void {
    if (this.gone.has(ws)) return;
    this.gone.add(ws);
    const attachment = this.attachment(ws);
    if (attachment) {
      const removed: AwarenessEntry[] = [];
      for (const [key, clock] of Object.entries(attachment.clients)) {
        const clientId = Number(key);
        const known = this.awareness.get(clientId);
        if (known && known.socketId !== attachment.socketId) continue;
        this.awareness.delete(clientId);
        removed.push({ clientId, clock: Math.max(clock, known?.clock ?? 0) + 1, state: "null" });
      }
      this.store.removeAwareness(attachment.socketId);
      if (removed.length > 0) {
        this.broadcast(encodeAwarenessFrame(encodeAwarenessUpdate(removed)));
      }
    }
    this.broadcastParticipants();
    this.ctx.waitUntil(this.afterDisconnect());
  }

  private async afterDisconnect(): Promise<void> {
    if (this.openSockets().length > 0) return;
    if (this.doc && this.updatesSinceSnapshot > 1) this.compact();
    await this.scheduleIdleCleanup();
  }

  // --------------------------------------------------------------- helpers

  private ensureDoc(): Y.Doc {
    if (this.doc) return this.doc;
    const doc = roomDoc();
    const updates = this.store.loadUpdates();
    doc.transact(() => {
      for (const update of updates) Y.applyUpdate(doc, update);
    });
    this.updatesSinceSnapshot = updates.length;
    doc.on("update", (update: Uint8Array) => {
      try {
        this.ctx.storage.transactionSync(() => this.store.appendUpdate(update));
      } catch {
        // Do not continue serving an in-memory document that failed to persist.
        this.ctx.abort("collaboration persistence failed");
      }
      this.updatesSinceSnapshot++;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      syncProtocol.writeUpdate(encoder, update);
      // Echo to the origin too: server corrections share this update. Applying
      // one's own CRDT structs is idempotent and never re-sends via the provider.
      this.broadcast(encoding.toUint8Array(encoder));
      if (this.updatesSinceSnapshot >= COMPACT_AFTER_UPDATES) this.compact();
    });
    this.doc = doc;
    return doc;
  }

  private compact(): void {
    const doc = this.doc;
    if (!doc) return;
    const snapshot = Y.encodeStateAsUpdate(doc);
    this.ctx.storage.transactionSync(() => this.store.replaceWithSnapshot(snapshot));
    this.updatesSinceSnapshot = 1;
  }

  private isHost(request: Request): boolean {
    const actor = this.store.participant(request.headers.get("X-Collab-Participant") ?? "");
    return !!actor && actor.role === "host" && !actor.revoked;
  }

  private removeControl(participantId: string): void {
    const doc = this.ensureDoc();
    const control = doc.getMap(DOC_KEYS.control);
    doc.transact(() => {
      if (control.get("holder") === participantId)
        control.set("holder", this.store.meta()?.hostId ?? null);
      const requests = control.get("requests") as string[];
      if (requests.includes(participantId))
        control.set(
          "requests",
          requests.filter((id) => id !== participantId),
        );
    });
  }

  private async scheduleIdleCleanup(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + COLLAB_LIMITS.idleRoomMs);
  }

  private attachment(ws: WebSocket): SocketAttachment | null {
    const value: unknown = ws.deserializeAttachment();
    if (!value || typeof value !== "object") return null;
    const { participantId, socketId, clients } = value as Partial<SocketAttachment>;
    if (
      typeof participantId !== "string" ||
      typeof socketId !== "string" ||
      !clients ||
      typeof clients !== "object"
    )
      return null;
    return { participantId, socketId, clients: { ...clients } };
  }

  private openSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter(
        (ws) =>
          !this.gone.has(ws) &&
          ws.readyState !== WebSocket.READY_STATE_CLOSING &&
          ws.readyState !== WebSocket.READY_STATE_CLOSED,
      );
  }

  private send(ws: WebSocket, frame: Uint8Array): void {
    try {
      ws.send(frame);
    } catch {
      // The close handler cleans up.
    }
  }

  private broadcast(frame: Uint8Array, except?: unknown): void {
    for (const ws of this.openSockets()) {
      if (ws !== except) this.send(ws, frame);
    }
  }

  private broadcastParticipants(): void {
    const sockets = this.openSockets();
    if (sockets.length === 0) return;
    const online = new Set(sockets.map((ws) => this.attachment(ws)?.participantId));
    const notice: Notice = {
      type: "participants",
      participants: this.store.activeParticipants().map((participant) => ({
        participantId: participant.participantId,
        name: participant.name,
        role: participant.role,
        online: online.has(participant.participantId),
      })),
    };
    const frame = encodeNotice(notice);
    for (const ws of sockets) this.send(ws, frame);
  }
}
