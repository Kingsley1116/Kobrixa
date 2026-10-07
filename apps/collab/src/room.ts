import { DurableObject } from "cloudflare:workers";
import type { CollabEnv } from "./env.js";

/**
 * One Durable Object per room. Relays y-protocols sync/awareness frames between
 * participants and persists the room's Y.Doc in DO SQLite storage.
 *
 * The Worker (src/index.ts) verifies the room token before forwarding the
 * WebSocket upgrade and passes the verified identity in these headers:
 * `X-Collab-Participant`, `X-Collab-Role`, `X-Collab-Name`.
 */
export class CollabRoom extends DurableObject<CollabEnv> {
  override async fetch(_request: Request): Promise<Response> {
    return new Response("Not implemented", { status: 501 });
  }
}
