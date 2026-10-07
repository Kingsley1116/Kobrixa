import { base64urlDecode, base64urlEncode, hmac, randomId } from "./tokens.js";

export interface PasswordVerifier {
  version: 1;
  salt: string;
  hash: string;
}

/** Version 1: server-keyed prehash, then salted PBKDF2-SHA256 (100,000 iterations). */
async function derive(
  secret: string,
  roomId: string,
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const input = new Uint8Array(
    await hmac(secret, `room-password:${JSON.stringify([roomId, password])}`),
  );
  const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
}

export async function createPasswordVerifier(
  secret: string,
  roomId: string,
  password: string,
): Promise<PasswordVerifier> {
  const salt = randomId(16);
  const hash = await derive(secret, roomId, password, base64urlDecode(salt)!);
  return { version: 1, salt, hash: base64urlEncode(new Uint8Array(hash)) };
}

export async function verifyPassword(
  secret: string,
  roomId: string,
  password: string,
  verifier: PasswordVerifier,
): Promise<boolean> {
  const salt = base64urlDecode(verifier.salt);
  const hash = base64urlDecode(verifier.hash);
  if (verifier.version !== 1 || salt?.byteLength !== 16 || hash?.byteLength !== 32) return false;
  return crypto.subtle.timingSafeEqual(await derive(secret, roomId, password, salt), hash);
}
