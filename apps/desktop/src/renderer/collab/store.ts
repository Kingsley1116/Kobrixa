import type { CollabConnection } from "../../shared/collab.js";
import type { CollabSession, CollabSessionFactory } from "./types.js";

/**
 * Holds the app's single active collaboration session (or none). Created once in
 * `App`; features read `getSnapshot()` with `useSyncExternalStore` and react to
 * session changes.
 */
export class CollabStore {
  #session: CollabSession | null = null;
  readonly #listeners = new Set<() => void>();
  #unsubscribeSession: () => void = () => {};

  constructor(private readonly factory: CollabSessionFactory) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CollabSession | null => this.#session;

  /** Replaces any current session with a new connected one. */
  start(connection: CollabConnection): CollabSession {
    // Create first so a failing factory leaves the previous session intact.
    const session = this.factory(connection);
    const previous = this.#session;
    const initialRole = session.getSnapshot().role;
    this.#unsubscribeSession();
    this.#session = session;
    this.#unsubscribeSession = session.subscribe(() => {
      if (this.#session !== session) return;
      const snapshot = session.getSnapshot();
      if (snapshot.status === "closed" || snapshot.role === initialRole) return;
      // A viewer's Y.Doc can contain dropped edits (including edits already in
      // flight when downgraded). Yjs cannot undo those by applying a snapshot.
      // Replace the session so every binding uses fresh authoritative history;
      // promotion must never resend changes made while the client was a viewer.
      this.start({ ...connection, role: snapshot.role });
    });
    previous?.destroy();
    this.#emit();
    session.connect();
    return session;
  }

  /** Leaves and destroys the current session, if any. */
  stop(): void {
    if (!this.#session) return;
    this.#unsubscribeSession();
    this.#unsubscribeSession = () => {};
    this.#session.destroy();
    this.#session = null;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
