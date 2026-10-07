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

  constructor(private readonly factory: CollabSessionFactory) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CollabSession | null => this.#session;

  /** Replaces any current session with a new connected one. */
  start(connection: CollabConnection): CollabSession {
    this.#session?.destroy();
    const session = this.factory(connection);
    this.#session = session;
    session.connect();
    this.#emit();
    return session;
  }

  /** Leaves and destroys the current session, if any. */
  stop(): void {
    if (!this.#session) return;
    this.#session.destroy();
    this.#session = null;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
