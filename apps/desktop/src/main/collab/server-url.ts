import { DEFAULT_COLLAB_URL } from "@kobrixa/collab-protocol";

/** Hosts where an unencrypted `http:` origin is accepted (local `wrangler dev`). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Validates a collaboration service origin. Accepts `https:` origins and
 * `http:` loopback origins (tokens must never travel unencrypted over a network).
 * Returns the normalised origin, or `undefined` when the value is not acceptable.
 */
export function parseCollabOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !local) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url.origin;
}

/** `KOBRIXA_COLLAB_URL` when it is a valid origin, otherwise `DEFAULT_COLLAB_URL`. */
export function resolveCollabServerUrl(
  value: string | undefined = process.env.KOBRIXA_COLLAB_URL,
  warn: (message: string) => void = (message) => console.warn(message),
): string {
  if (value === undefined || value.trim() === "") return DEFAULT_COLLAB_URL;
  const origin = parseCollabOrigin(value);
  if (origin) return origin;
  warn(
    `Ignoring KOBRIXA_COLLAB_URL=${JSON.stringify(value)}: expected an https origin ` +
      `or an http://localhost / http://127.0.0.1 origin. Using ${DEFAULT_COLLAB_URL}.`,
  );
  return DEFAULT_COLLAB_URL;
}

/** CSP `connect-src` sources for the service: its HTTP(S) origin and matching WS(S) origin. */
export function collabConnectSources(serverUrl: string): string {
  const url = new URL(serverUrl);
  const socket = url.protocol === "https:" ? "wss:" : "ws:";
  return `${url.origin} ${socket}//${url.host}`;
}
