import { RELEASES_REPO, parseRelease } from "../src/shared/releases.js";

const TTL = 600;

/** Serves the latest stable GitHub release, cached at the edge so visitors never hit GitHub's rate limit. */
export async function releasesRoute(req: Request, ctx: ExecutionContext): Promise<Response> {
  if (!["GET", "HEAD"].includes(req.method))
    return Response.json({ error: "invalid" }, { status: 405 });
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL("/api/releases/latest", req.url));
  const cached = await cache.match(key);
  if (cached) return new Response(cached.body, cached);
  const upstream = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Kobrixa-Web",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const release = upstream.ok ? parseRelease(await upstream.json()) : null;
  if (!release) {
    console.error(JSON.stringify({ event: "releases_fetch_failed", status: upstream.status }));
    return Response.json({ error: "unavailable" }, { status: 502 });
  }
  const response = Response.json(release, {
    headers: { "Cache-Control": `public, max-age=${TTL}` },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
