import { collabConnectSources } from "../collab/server-url.js";

/**
 * Response-header CSP for the renderer. The only network destination the
 * renderer may reach is the collaboration service (HTTP(S) + WebSocket).
 * Chromium enforces this header for the production `file://` page as well
 * (verified by booting the built app), and both policies must allow a request.
 * The static `<meta>` CSP in `index.html` is therefore intentionally broader for
 * `connect-src`: it cannot know `KOBRIXA_COLLAB_URL` at build time.
 */
export function rendererContentSecurityPolicy(collabServerUrl: string, dev: boolean): string {
  const collab = collabConnectSources(collabServerUrl);
  return dev
    ? `default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self' data: blob: ws: ${collab}`
    : `default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src ${collab}`;
}
