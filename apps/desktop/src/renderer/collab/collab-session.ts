import type { CollabConnection } from "../../shared/collab.js";
import type { CollabSession } from "./types.js";

/**
 * Opens a WebSocket session to a room (y-protocols sync + awareness over
 * `COLLAB_ROUTES.socket`). Placeholder until the session provider lands.
 */
export function createCollabSession(_connection: CollabConnection): CollabSession {
  throw new Error("Collaboration sessions are not available yet.");
}
