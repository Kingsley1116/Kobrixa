import { COLLAB_LIMITS, tokenPayloadSchema } from "@kobrixa/collab-protocol";
import type { Role, TokenPayload } from "@kobrixa/collab-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decoding (no padding, URL-safe alphabet only); null on malformed input. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Reject non-canonical encodings (stray low bits in the last character).
    return base64urlEncode(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

/** Random URL-safe identifier with `bytes` bytes of entropy. */
export function randomId(bytes = 16): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

// CryptoKey import is comparatively expensive; secrets rarely change per isolate.
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    if (keyCache.size > 4) keyCache.clear();
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, key);
  }
  return key;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)),
  );
}

/**
 * Room ids are derived from the invite code so that joining needs no lookup
 * table: base64url(HMAC-SHA256(secret, "room:" + inviteCode)) truncated to 32 chars.
 */
export async function deriveRoomId(secret: string, inviteCode: string): Promise<string> {
  return base64urlEncode(await hmac(secret, `room:${inviteCode}`)).slice(0, 32);
}

export interface TokenClaims {
  roomId: string;
  participantId: string;
  role: Role;
  name: string;
}

/** Token format: `base64url(JSON payload).base64url(HMAC-SHA256(secret, payloadPart))`. */
export async function signToken(
  secret: string,
  claims: TokenClaims,
  now = Date.now(),
): Promise<{ token: string; payload: TokenPayload }> {
  const payload = tokenPayloadSchema.parse({
    v: 1,
    ...claims,
    exp: now + COLLAB_LIMITS.tokenTtlMs,
  });
  const payloadPart = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64urlEncode(await hmac(secret, payloadPart));
  return { token: `${payloadPart}.${signature}`, payload };
}

export type VerifyResult =
  { ok: true; payload: TokenPayload } | { ok: false; reason: "invalid" | "expired" };

export async function verifyToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadPart = "", signaturePart = ""] = parts;
  const signature = base64urlDecode(signaturePart);
  if (!payloadPart || !signature || signature.length !== 32)
    return { ok: false, reason: "invalid" };
  // crypto.subtle.verify compares the MAC in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(payloadPart),
  );
  if (!valid) return { ok: false, reason: "invalid" };
  const payloadBytes = base64urlDecode(payloadPart);
  if (!payloadBytes) return { ok: false, reason: "invalid" };
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = tokenPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload: parsed.data };
}
