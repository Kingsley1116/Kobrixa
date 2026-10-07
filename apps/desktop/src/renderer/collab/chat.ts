import type * as Y from "yjs";
import { COLLAB_LIMITS, chatMessageSchema, type ChatMessage } from "@kobrixa/collab-protocol";
import { canEdit, sharedTypes, type CollabSession } from "./types.js";

export interface ChatSnapshot {
  /** Valid messages in document order; invalid or duplicate items are skipped. */
  readonly messages: readonly ChatMessage[];
  /** Messages from other participants that arrived while the chat was not visible. */
  readonly unread: number;
  /** False for viewers: the server drops their document updates. */
  readonly canSend: boolean;
}

export type ChatSendResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; reason: "empty" | "too-long" | "read-only" | "invalid" };

export interface ChatControllerOptions {
  now?: () => number;
  randomId?: () => string;
}

/** Extra messages tolerated before the host trims, so trims are rare and batched. */
export const CHAT_TRIM_SLACK = 50;

const parsed = new WeakMap<object, ChatMessage | null>();

function parseItem(item: unknown): ChatMessage | null {
  if (typeof item !== "object" || item === null) return null;
  const cached = parsed.get(item);
  if (cached !== undefined) return cached;
  const result = chatMessageSchema.safeParse(item);
  const message =
    result.success && Number.isFinite(new Date(result.data.at).getTime())
      ? Object.freeze(result.data)
      : null;
  parsed.set(item, message);
  return message;
}

const controllers = new WeakMap<CollabSession, ChatController>();

/**
 * The chat controller for a session, created on first use and kept for the
 * session's lifetime, so unread state survives the chat UI unmounting. It
 * disposes itself when the session closes.
 */
export function chatControllerFor(session: CollabSession): ChatController {
  let controller = controllers.get(session);
  if (!controller) {
    controller = new ChatController(session);
    controllers.set(session, controller);
  }
  return controller;
}

/** Length of chat text as the protocol schema counts it (after trimming). */
export function chatTextLength(text: string): number {
  return text.trim().length;
}

/**
 * Room chat backed by `sharedTypes(doc).chat`. Follows the renderer's store
 * convention (`subscribe` + immutable `getSnapshot`) for `useSyncExternalStore`.
 */
export class ChatController {
  readonly #session: CollabSession;
  readonly #chat: Y.Array<ChatMessage>;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  readonly #randomId: () => string;
  /** Ids of messages the local user has had a chance to see. */
  #seen = new Set<string>();
  #visible = false;
  #disposed = false;
  #snapshot: ChatSnapshot;
  readonly #unsubscribeSession: () => void;

  constructor(session: CollabSession, options: ChatControllerOptions = {}) {
    this.#session = session;
    this.#chat = sharedTypes(session.doc).chat;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => crypto.randomUUID());
    this.#snapshot = { messages: [], unread: 0, canSend: false };
    this.#chat.observe(this.#onChange);
    this.#unsubscribeSession = session.subscribe(this.#onChange);
    this.#refresh(false);
    // Messages already in the document when the chat opens are history, not news.
    for (const message of this.#snapshot.messages) this.#seen.add(message.id);
    this.#snapshot = Object.freeze({ ...this.#snapshot, unread: 0 });
    if (session.getSnapshot().status === "closed") this.dispose();
    else this.#trim();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ChatSnapshot => this.#snapshot;

  /** While visible, every incoming message counts as read. */
  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (visible) this.markRead();
  }

  markRead(): void {
    for (const message of this.#snapshot.messages) this.#seen.add(message.id);
    this.#refresh(true);
  }

  send(text: string): ChatSendResult {
    if (this.#disposed || !this.#snapshot.canSend) return { ok: false, reason: "read-only" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty" };
    if (trimmed.length > COLLAB_LIMITS.chatMessageLength) return { ok: false, reason: "too-long" };
    const { participantId, name } = this.#session.connection;
    const result = chatMessageSchema.safeParse({
      id: this.#randomId(),
      participantId,
      name,
      text: trimmed,
      at: Math.round(this.#now()),
    });
    if (!result.success) return { ok: false, reason: "invalid" };
    const message = result.data;
    this.#seen.add(message.id);
    this.#chat.push([message]);
    return { ok: true, message };
  }

  /** Stops observing the session. The last snapshot stays readable. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#chat.unobserve(this.#onChange);
    this.#unsubscribeSession();
  }

  #onChange = (): void => {
    if (this.#disposed) return;
    this.#refresh(true);
    if (this.#session.getSnapshot().status === "closed") this.dispose();
    else this.#trim();
  };

  /**
   * Only the host trims, so two participants never delete the same overflow
   * concurrently (which would remove twice as many messages as intended).
   */
  #trim(): void {
    const session = this.#session.getSnapshot();
    if (session.role !== "host" || session.status === "closed") return;
    const excess = this.#chat.length - COLLAB_LIMITS.chatMessages;
    if (this.#chat.length <= COLLAB_LIMITS.chatMessages + CHAT_TRIM_SLACK) return;
    this.#chat.delete(0, excess);
  }

  #refresh(emit: boolean): void {
    const session = this.#session.getSnapshot();
    const ids = new Set<string>();
    const messages: ChatMessage[] = [];
    for (const item of this.#chat.toArray()) {
      const message = parseItem(item);
      if (!message || ids.has(message.id)) continue;
      ids.add(message.id);
      messages.push(message);
    }
    // History present before the first sync (or while the chat is visible) is
    // not "new"; forget ids that were trimmed away.
    const seen = new Set<string>();
    let unread = 0;
    for (const message of messages) {
      if (this.#seen.has(message.id) || this.#visible || !session.synced) seen.add(message.id);
      else if (message.participantId !== this.#session.connection.participantId) unread++;
    }
    this.#seen = seen;
    const canSend = canEdit(session.role) && session.status !== "closed";
    const previous = this.#snapshot;
    const sameMessages =
      previous.messages.length === messages.length &&
      previous.messages.every((message, index) => message === messages[index]);
    if (sameMessages && previous.unread === unread && previous.canSend === canSend) return;
    this.#snapshot = Object.freeze({
      messages: sameMessages ? previous.messages : Object.freeze(messages),
      unread,
      canSend,
    });
    if (emit) for (const listener of [...this.#listeners]) listener();
  }
}
