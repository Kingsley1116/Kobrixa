import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {
  CLOSE_CODE,
  COLLAB_ROUTES,
  MESSAGE_TYPE,
  noticeSchema,
  participantColor,
  type Notice,
  type PresenceState,
} from "@kobrixa/collab-protocol";
import type { CollabConnection, CollabResult } from "../../shared/collab.js";
import {
  CollabPendingUpdatesError,
  type CollabCloseReason,
  type CollabSession,
  type CollabSessionSnapshot,
  type CollabStatus,
} from "./types.js";

/** The subset of the browser `WebSocket` the session uses. */
export interface CollabSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type CollabSocketConstructor = new (url: string) => CollabSocket;

/** Online/offline signal (defaults to `navigator.onLine` + window events). */
export interface CollabNetworkMonitor {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface CollabSessionOptions {
  WebSocket?: CollabSocketConstructor;
  refreshConnection?(roomId: string): Promise<CollabResult<CollabConnection>>;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Returns a number in [0, 1); used for backoff jitter. */
  random?: () => number;
  /** `null` disables online/offline tracking. */
  network?: CollabNetworkMonitor | null;
  /** Backoff bounds in milliseconds. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

const SOCKET_OPEN = 1;
const NORMAL_CLOSURE = 1000;
const DEFAULT_MIN_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Builds the room WebSocket URL: `ws(s)://…/rooms/<id>/ws?token=…`. */
export function collabSocketUrl(connection: CollabConnection): string {
  const url = new URL(connection.serverUrl);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.pathname =
    url.pathname.replace(/\/+$/, "") + COLLAB_ROUTES.socket(encodeURIComponent(connection.roomId));
  url.search = `?token=${encodeURIComponent(connection.token)}`;
  url.hash = "";
  return url.toString();
}

/** Stable 32-bit FNV-1a hash, used to pick a participant's color. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Maps a server close code to a terminal reason, or `null` when the client should retry. */
export function closeReasonForCode(code: number): CollabCloseReason | null {
  switch (code) {
    case CLOSE_CODE.sessionReplaced:
      return "session-replaced";
    case CLOSE_CODE.kicked:
      return "kicked";
    case CLOSE_CODE.unauthorized:
      return "unauthorized";
    case CLOSE_CODE.roomClosed:
      return "room-closed";
    case CLOSE_CODE.roomFull:
      return "room-full";
    case CLOSE_CODE.protocolMismatch:
      return "protocol-mismatch";
    default:
      return null;
  }
}

/**
 * Opens a WebSocket session to a room (y-protocols sync + awareness over
 * `COLLAB_ROUTES.socket`). The optional `options` let tests inject a WebSocket
 * implementation, timers and a network monitor.
 */
export function createCollabSession(
  connection: CollabConnection,
  options: CollabSessionOptions = {},
): CollabSession {
  return new WebSocketCollabSession(connection, options);
}

class WebSocketCollabSession implements CollabSession {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly #listeners = new Set<() => void>();
  readonly #WebSocket: CollabSocketConstructor;
  readonly #setTimeout: (callback: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #random: () => number;
  readonly #network: CollabNetworkMonitor | null;
  readonly #minDelay: number;
  readonly #maxDelay: number;
  #unsubscribeNetwork: (() => void) | null = null;
  #snapshot: CollabSessionSnapshot;
  #socket: CollabSocket | null = null;
  #retryTimer: unknown = null;
  #attempt = 0;
  #started = false;
  #destroyed = false;
  #refreshing = false;
  #pendingUpdates = new Set<ReturnType<typeof Y.decodeUpdate>>();
  #ackListeners = new Set<() => void>();
  readonly #refreshConnection: CollabSessionOptions["refreshConnection"];

  constructor(
    readonly connection: CollabConnection,
    options: CollabSessionOptions,
  ) {
    this.#refreshConnection = options.refreshConnection;
    const WebSocketImpl =
      options.WebSocket ??
      (globalThis as { WebSocket?: CollabSocketConstructor }).WebSocket ??
      null;
    if (!WebSocketImpl) throw new Error("WebSocket is not available in this environment.");
    this.#WebSocket = WebSocketImpl;
    this.#setTimeout =
      options.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.#clearTimeout =
      options.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
    this.#random = options.random ?? Math.random;
    this.#network = options.network === undefined ? browserNetworkMonitor() : options.network;
    this.#minDelay = options.minReconnectDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.#maxDelay = options.maxReconnectDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.#snapshot = {
      status: "connecting",
      role: connection.role,
      synced: false,
      participants: [],
    };

    this.awareness = new Awareness(this.doc);
    const presence: PresenceState = {
      participantId: connection.participantId,
      name: connection.name,
      color: participantColor(hashString(connection.participantId)),
      role: connection.role,
    };
    this.awareness.setLocalState(presence);

    this.doc.on("update", this.#onDocUpdate);
    this.awareness.on("update", this.#onAwarenessUpdate);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CollabSessionSnapshot => this.#snapshot;

  connect(): void {
    if (this.#destroyed) return;
    if (!this.#started) {
      this.#started = true;
      this.#unsubscribeNetwork = this.#network?.subscribe(this.#onNetworkChange) ?? null;
    }
    // A socket that is opening or open (including a reconnect attempt) is reused.
    if (this.#socket) return;
    this.#cancelRetry();
    this.#attempt = 0;
    if (this.#network && !this.#network.isOnline()) {
      this.#setStatus("reconnecting");
      return;
    }
    this.#open();
  }

  disconnect(): void {
    this.#terminate("left");
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.disconnect();
    this.#destroyed = true;
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = null;
    this.doc.off("update", this.#onDocUpdate);
    this.awareness.off("update", this.#onAwarenessUpdate);
    removeAwarenessStates(this.awareness, [this.doc.clientID], this);
    this.awareness.destroy();
    this.doc.destroy();
    this.#listeners.clear();
  }

  hasPendingUpdates(): boolean {
    return this.#pendingUpdates.size > 0;
  }

  async flush(): Promise<void> {
    if (!this.#pendingUpdates.size) return;
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.#ackListeners.delete(check);
        reject(new CollabPendingUpdatesError());
      }, 10_000);
      const check = () => {
        if (!this.#pendingUpdates.size) {
          globalThis.clearTimeout(timer);
          this.#ackListeners.delete(check);
          resolve();
        }
      };
      this.#ackListeners.add(check);
      check();
    });
  }

  reconnectNow(): void {
    if (this.#destroyed || this.#snapshot.status !== "reconnecting" || this.#socket) return;
    this.#cancelRetry();
    this.#attempt = 0;
    this.#open();
  }

  // --- socket lifecycle -------------------------------------------------------

  #open(): void {
    // Expired tokens are rejected at the HTTP upgrade, which only surfaces as 1006.
    if (Date.now() >= this.connection.expiresAt - (this.#refreshConnection ? 60_000 : 0)) {
      if (!this.#refreshConnection) {
        this.#terminate("unauthorized");
        return;
      }
      if (this.#refreshing) return;
      this.#refreshing = true;
      void this.#refreshConnection(this.connection.roomId)
        .then((result) => {
          if (this.#destroyed || this.#snapshot.status === "closed") return;
          if (!result.ok) {
            if (
              result.error === "network" ||
              result.error === "unavailable" ||
              result.error === "rate-limited"
            )
              this.#scheduleReconnect();
            else
              this.#terminate(
                result.error === "removed"
                  ? "kicked"
                  : result.error === "room-closed"
                    ? "room-closed"
                    : "unauthorized",
              );
            return;
          }
          Object.assign(this.connection, result.value);
          this.#open();
        })
        .catch(() => this.#scheduleReconnect())
        .finally(() => {
          this.#refreshing = false;
        });
      return;
    }
    if (this.#snapshot.status !== "reconnecting") this.#setStatus("connecting");
    let socket: CollabSocket;
    try {
      socket = new this.#WebSocket(collabSocketUrl(this.connection));
    } catch (error) {
      console.warn("[collab] Cannot open room socket", error);
      this.#terminate("error");
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.onopen = () => {
      if (socket !== this.#socket) return;
      this.#setStatus("syncing");
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
      const syncDoc = this.#pendingUpdates.size ? new Y.Doc() : this.doc;
      syncProtocol.writeSyncStep1(encoder, syncDoc);
      if (syncDoc !== this.doc) syncDoc.destroy();
      this.#send(encoding.toUint8Array(encoder));
      if (this.awareness.getLocalState() !== null) this.#sendAwareness([this.doc.clientID]);
    };
    socket.onmessage = (event) => {
      if (socket !== this.#socket) return;
      const data = toBytes(event.data);
      if (!data) return;
      try {
        this.#handleMessage(data);
      } catch (error) {
        console.warn("[collab] Ignoring malformed frame", error);
      }
    };
    socket.onclose = (event) => {
      if (socket !== this.#socket) return;
      this.#detachSocket();
      const reason = closeReasonForCode(event.code);
      if (reason) this.#terminate(reason);
      else this.#scheduleReconnect();
    };
    socket.onerror = () => {
      // `onclose` follows and decides whether to retry.
    };
  }

  #detachSocket(close?: { code: number; reason: string }): void {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (close) {
      try {
        socket.close(close.code, close.reason);
      } catch {
        // Already closing.
      }
    }
    this.#removeRemoteAwareness();
  }

  #scheduleReconnect(): void {
    if (this.#destroyed || this.#snapshot.status === "closed") return;
    this.#setStatus("reconnecting");
    this.#cancelRetry();
    if (this.#network && !this.#network.isOnline()) return; // resume on `online`
    const base = Math.min(this.#maxDelay, this.#minDelay * 2 ** this.#attempt);
    const delay = Math.round(base / 2 + (this.#random() * base) / 2);
    this.#attempt++;
    this.#retryTimer = this.#setTimeout(() => {
      this.#retryTimer = null;
      if (this.#destroyed || this.#snapshot.status !== "reconnecting") return;
      this.#open();
    }, delay);
  }

  #cancelRetry(): void {
    if (this.#retryTimer === null) return;
    this.#clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #terminate(reason: CollabCloseReason): void {
    this.#cancelRetry();
    if (this.#socket) {
      // Tell peers we left right away instead of waiting for the awareness timeout.
      if (this.#socket.readyState === SOCKET_OPEN) {
        this.#sendAwareness([this.doc.clientID], new Map());
      }
      this.#detachSocket({ code: NORMAL_CLOSURE, reason });
    }
    if (this.#snapshot.status === "closed") return;
    this.#update({ status: "closed", closeReason: reason });
  }

  #onNetworkChange = (online: boolean): void => {
    if (this.#destroyed || this.#snapshot.status === "closed") return;
    if (!online) {
      this.#cancelRetry();
      this.#detachSocket({ code: NORMAL_CLOSURE, reason: "offline" });
      this.#setStatus("reconnecting");
      return;
    }
    this.reconnectNow();
  };

  // --- frames -----------------------------------------------------------------

  #handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_TYPE.sync: {
        const probe = decoding.createDecoder(data);
        decoding.readVarUint(probe);
        const kind = decoding.readVarUint(probe);
        if (kind === syncProtocol.messageYjsUpdate || kind === syncProtocol.messageYjsSyncStep2) {
          const update = decoding.readVarUint8Array(probe);
          const acknowledged = Y.decodeUpdate(update);
          const clock = Y.parseUpdateMeta(update).to;
          for (const pending of this.#pendingUpdates) {
            const structsAccepted = pending.structs.every(
              (struct) => (clock.get(struct.id.client) ?? 0) >= struct.id.clock + struct.length,
            );
            const deletesAccepted = [...pending.ds.clients].every(([id, ranges]) =>
              ranges.every((range) =>
                acknowledged.ds.clients
                  .get(id)
                  ?.some(
                    (known) =>
                      known.clock <= range.clock &&
                      known.clock + known.len >= range.clock + range.len,
                  ),
              ),
            );
            if (structsAccepted && deletesAccepted) this.#pendingUpdates.delete(pending);
          }
          for (const notify of this.#ackListeners) notify();
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
        const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 1) this.#send(encoding.toUint8Array(encoder));
        if (syncType === syncProtocol.messageYjsSyncStep2 && this.#snapshot.status === "syncing") {
          this.#attempt = 0;
          this.#update({ status: "connected", synced: true });
        }
        return;
      }
      case MESSAGE_TYPE.awareness:
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        return;
      case MESSAGE_TYPE.notice: {
        const parsed = noticeSchema.safeParse(JSON.parse(decoding.readVarString(decoder)));
        if (parsed.success) this.#handleNotice(parsed.data);
        return;
      }
      default:
        return;
    }
  }

  #handleNotice(notice: Notice): void {
    switch (notice.type) {
      case "participants":
        this.#update({ participants: notice.participants });
        return;
      case "role":
        if (this.awareness.getLocalState() !== null) {
          this.awareness.setLocalStateField("role", notice.role);
        }
        if (notice.role !== this.#snapshot.role) this.#update({ role: notice.role });
        return;
      case "kicked":
        this.#terminate("kicked");
        return;
      case "room-closed":
        this.#terminate("room-closed");
        return;
    }
  }

  #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || !this.#isOpen()) return;
    this.#pendingUpdates.add(Y.decodeUpdate(update));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.sync);
    syncProtocol.writeUpdate(encoder, update);
    this.#send(encoding.toUint8Array(encoder));
  };

  #onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || !this.#isOpen()) return;
    const clientId = this.doc.clientID;
    if (added.includes(clientId) || updated.includes(clientId) || removed.includes(clientId)) {
      this.#sendAwareness([clientId]);
    }
  };

  #sendAwareness(clients: number[], states?: Map<number, Record<string, unknown>>): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.awareness);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients, states));
    this.#send(encoding.toUint8Array(encoder));
  }

  #send(frame: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(frame);
    } catch {
      // The close handler will reconnect; the next sync exchange resends the state.
    }
  }

  #isOpen(): boolean {
    return this.#socket !== null && this.#socket.readyState === SOCKET_OPEN;
  }

  #removeRemoteAwareness(): void {
    const remote = [...this.awareness.getStates().keys()].filter(
      (client) => client !== this.doc.clientID,
    );
    if (remote.length > 0) removeAwarenessStates(this.awareness, remote, this);
  }

  // --- snapshot ---------------------------------------------------------------

  #setStatus(status: CollabStatus): void {
    if (this.#snapshot.status !== status) this.#update({ status });
  }

  #update(patch: Partial<CollabSessionSnapshot>): void {
    const next: CollabSessionSnapshot = { ...this.#snapshot, ...patch };
    if (next.status !== "closed") delete next.closeReason;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function browserNetworkMonitor(): CollabNetworkMonitor | null {
  const target = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
    navigator?: { onLine?: boolean };
  };
  const { addEventListener, removeEventListener } = target;
  if (typeof addEventListener !== "function" || typeof removeEventListener !== "function")
    return null;
  if (typeof target.navigator?.onLine !== "boolean") return null;
  return {
    isOnline: () => target.navigator?.onLine !== false,
    subscribe(listener) {
      const online = (): void => listener(true);
      const offline = (): void => listener(false);
      addEventListener.call(globalThis, "online", online);
      addEventListener.call(globalThis, "offline", offline);
      return () => {
        removeEventListener.call(globalThis, "online", online);
        removeEventListener.call(globalThis, "offline", offline);
      };
    },
  };
}
