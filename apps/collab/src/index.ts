import type { CollabEnv } from "./env.js";

export { CollabRoom } from "./room.js";

export default {
  async fetch(_request: Request, _env: CollabEnv): Promise<Response> {
    return Response.json({ error: "internal", message: "Not implemented" }, { status: 501 });
  },
} satisfies ExportedHandler<CollabEnv>;
