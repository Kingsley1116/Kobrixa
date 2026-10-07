import {
  COLLAB_LIMITS,
  inviteCodeSchema,
  participantIdSchema,
  roomIdSchema,
} from "@kobrixa/collab-protocol";
import { describe, expect, it } from "vitest";
import { generateInviteCode } from "./invite.js";
import {
  base64urlDecode,
  base64urlEncode,
  deriveRoomId,
  randomId,
  signToken,
  verifyToken,
} from "./tokens.js";

const secret = "test-secret-0123456789";
const claims = {
  roomId: "r".repeat(32),
  participantId: "p".repeat(22),
  role: "editor",
  name: "Ada",
} as const;

describe("tokens", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const text = base64urlEncode(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64urlDecode(text)).toEqual(bytes);
    expect(base64urlDecode("ab+c")).toBeNull();
    expect(base64urlDecode("abc=")).toBeNull();
    expect(base64urlDecode("A")).toBeNull();
    // Non-canonical trailing bits.
    expect(base64urlDecode("AB")).toBeNull();
  });

  it("signs and verifies tokens", async () => {
    const now = 1_000_000;
    const { token, payload } = await signToken(secret, claims, now);
    expect(payload).toEqual({ v: 1, ...claims, exp: now + COLLAB_LIMITS.tokenTtlMs });
    expect(await verifyToken(secret, token, now)).toEqual({ ok: true, payload });
  });

  it("rejects tampered, foreign and malformed tokens", async () => {
    const { token } = await signToken(secret, claims);
    const [payloadPart, signature] = token.split(".") as [string, string];
    const forged = base64urlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          ...JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"))),
          role: "host",
        }),
      ),
    );
    for (const bad of [
      `${forged}.${signature}`,
      `${payloadPart}.${signature.slice(0, -2)}AA`,
      `${payloadPart}.`,
      `.${signature}`,
      `${payloadPart}.${signature}.x`,
      "garbage",
      "",
    ])
      expect(await verifyToken(secret, bad)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyToken("other-secret", token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects expired tokens", async () => {
    const { token, payload } = await signToken(secret, claims, 0);
    expect(await verifyToken(secret, token, payload.exp)).toEqual({ ok: false, reason: "expired" });
    expect((await verifyToken(secret, token, payload.exp - 1)).ok).toBe(true);
  });

  it("derives a stable, valid room id from the invite code", async () => {
    const code = generateInviteCode();
    const roomId = await deriveRoomId(secret, code);
    expect(roomId).toHaveLength(32);
    expect(roomIdSchema.safeParse(roomId).success).toBe(true);
    expect(await deriveRoomId(secret, code)).toBe(roomId);
    expect(await deriveRoomId("other-secret", code)).not.toBe(roomId);
  });

  it("generates valid ids and invite codes", () => {
    const codes = new Set(Array.from({ length: 200 }, generateInviteCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(inviteCodeSchema.safeParse(code).success).toBe(true);
    expect(participantIdSchema.safeParse(randomId()).success).toBe(true);
    expect(randomId()).toHaveLength(22);
  });
});
