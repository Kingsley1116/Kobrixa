import type { ErrorResponse } from "@kobrixa/collab-protocol";
import type { z } from "zod";

export const MAX_JSON_BODY_BYTES = 16 * 1024;

export type ErrorCode = ErrorResponse["error"];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message ?? code);
  }
}

export function errorResponse(error: HttpError): Response {
  const body: ErrorResponse =
    error.message && error.message !== error.code
      ? { error: error.code, message: error.message }
      : { error: error.code };
  return Response.json(body, { status: error.status, headers: error.headers });
}

/** Reads at most `MAX_JSON_BODY_BYTES` of a JSON body and validates it with `schema`. */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_JSON_BODY_BYTES)
    throw new HttpError(413, "bad-request", "Body too large");
  if (!request.body) throw new HttpError(400, "bad-request", "Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "bad-request", "Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, "bad-request", "Invalid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, "bad-request", "Invalid request");
  return parsed.data;
}

export function allowedOrigins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

/**
 * Requests without an `Origin` header (the desktop main process uses
 * `net.fetch`, which sends none) are allowed. Browser requests must come
 * from one of `ALLOWED_ORIGINS`. Returns the origin to echo in CORS headers.
 */
export function checkOrigin(request: Request, allowed: Set<string>): string | null {
  const origin = request.headers.get("Origin");
  if (origin === null) return null;
  if (!allowed.has(origin)) throw new HttpError(403, "forbidden", "Origin not allowed");
  return origin;
}

export function preflightResponse(origin: string | null): Response {
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(null, { status: 204, headers });
}

/** Adds CORS and security headers. Upgrade (101) responses are returned untouched. */
export function finalizeResponse(response: Response, origin: string | null): Response {
  if (response.status === 101) return response;
  // Responses from fetch() / DO stubs may have immutable headers.
  const result = new Response(response.body, response);
  if (origin) {
    result.headers.set("Access-Control-Allow-Origin", origin);
    result.headers.append("Vary", "Origin");
  }
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}

/**
 * Sliding-window rate limiter keyed by client IP.
 *
 * Limitation: state lives in the memory of a single Worker isolate. Cloudflare
 * runs many isolates across many locations and recycles them at will, so this
 * only blunts bursts from one client hitting one isolate; it is not a global
 * limit. Use a Cloudflare rate-limiting binding or WAF rule for hard limits.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit; returns false when `key` exceeded `limit` within the window. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return true;
  }

  /** Seconds until `key` may try again. */
  retryAfter(key: string, now = Date.now()): number {
    const oldest = this.hits.get(key)?.[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  private prune(now: number): void {
    const since = now - this.windowMs;
    for (const [key, times] of this.hits)
      if ((times[times.length - 1] ?? 0) <= since) this.hits.delete(key);
    // Still too many active keys: drop the least recently used (Map keeps insertion order).
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}
