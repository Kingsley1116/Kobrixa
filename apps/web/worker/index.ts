import { GalleryError } from "../src/shared/gallery.js";
import { authRoute, checkOrigin, userFor } from "./auth.js";
import type { GalleryEnv } from "./auth.js";
import { cleanup, galleryRoute } from "./gallery.js";
export default {
  async fetch(req: Request, env: GalleryEnv): Promise<Response> {
    if (!new URL(req.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    let response: Response;
    try {
      if (!["GET", "HEAD"].includes(req.method)) checkOrigin(req, env);
      response = new URL(req.url).pathname.startsWith("/api/auth/")
        ? await authRoute(req, env)
        : await galleryRoute(req, env, await userFor(req, env));
    } catch (error) {
      if (error instanceof GalleryError)
        response = Response.json({ error: error.code }, { status: error.status });
      else if (error instanceof Error && error.message.includes("gallery_quota"))
        response = Response.json({ error: "quota" }, { status: 429 });
      else {
        console.error(
          JSON.stringify({ event: "gallery_request_failed", path: new URL(req.url).pathname }),
        );
        response = Response.json({ error: "internal" }, { status: 500 });
      }
    }
    // No public cache may outlive a moderation or withdrawal decision.
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "same-origin");
    return response;
  },
  async scheduled(_event: ScheduledController, env: GalleryEnv) {
    await cleanup(env);
  },
} satisfies ExportedHandler<GalleryEnv>;
