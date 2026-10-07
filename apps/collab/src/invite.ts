/** Unambiguous alphabet (no I, O, 0, 1); matches `inviteCodeSchema`. */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Generates an invite code such as `ABCD-EFGH-JKLM` (12 symbols, 60 bits of
 * entropy). The alphabet has 32 symbols, so `byte & 31` is unbiased.
 */
export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const symbols = Array.from(bytes, (byte) => INVITE_ALPHABET[byte & 31] ?? "A");
  return [0, 4, 8].map((start) => symbols.slice(start, start + 4).join("")).join("-");
}
