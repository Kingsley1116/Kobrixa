import { z } from "zod";
import { namespacedIdSchema, SINGLE_LINE } from "./common.js";
import { counterSchema, handleSchema } from "./device-types.js";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max * 2)
    .regex(SINGLE_LINE)
    .meta({ maxLength: max });
export const connectionRecoveryRefSchema = z.strictObject({
  recoveryId: handleSchema,
  providerId: namespacedIdSchema,
  providerGeneration: counterSchema,
  previousSessionId: handleSchema,
});
const base = {
  ...connectionRecoveryRefSchema.shape,
  name: text(200),
  attemptsStarted: counterSchema,
  retryLimit: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal("unlimited")]),
};
export const connectionRecoveryErrorSchema = z.strictObject({
  reason: z.enum(["cleanup-pending", "cleanup-failed"]),
  message: text(256),
});
export const connectionRecoverySchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...base,
    phase: z.literal("waiting"),
    retryAfterMs: z.number().int().min(0).max(10000),
  }),
  z.strictObject({ ...base, phase: z.literal("connecting") }),
  z.strictObject({ ...base, phase: z.literal("cancelling") }),
  z.strictObject({
    ...base,
    phase: z.literal("cancel-failed"),
    error: connectionRecoveryErrorSchema,
  }),
  z.strictObject({
    ...base,
    phase: z.literal("cancelled"),
    reason: z.enum([
      "user",
      "policy",
      "authority-lost",
      "provider-retired",
      "superseded",
      "shutdown",
    ]),
  }),
  z.strictObject({ ...base, phase: z.literal("retry-exhausted") }),
  z.strictObject({
    ...base,
    phase: z.literal("manual-required"),
    reason: z.enum([
      "auto-disabled",
      "identity-unavailable",
      "identity-ambiguous",
      "authority-unavailable",
      "provider-unavailable",
      "cleanup-required",
    ]),
  }),
  z.strictObject({ ...base, phase: z.literal("restored"), sessionId: handleSchema }),
]);
export const connectionRecoverySnapshotSchema = z.strictObject({
  hostEpoch: handleSchema,
  revision: counterSchema,
  recovery: connectionRecoverySchema.nullable(),
});
export type ConnectionRecoveryRef = z.output<typeof connectionRecoveryRefSchema>;
export type ConnectionRecoveryError = z.output<typeof connectionRecoveryErrorSchema>;
export type ConnectionRecovery = z.output<typeof connectionRecoverySchema>;
export type ConnectionRecoverySnapshot = z.output<typeof connectionRecoverySnapshotSchema>;
export const CONNECTION_RECOVERY_SNAPSHOT_BYTES = 4096;
/** Wire schemas stay exportable; call this semantic validator at every boundary. */
export function validateConnectionRecoverySnapshot(input: unknown): ConnectionRecoverySnapshot {
  const value = connectionRecoverySnapshotSchema.parse(input);
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(JSON.stringify(input)) > CONNECTION_RECOVERY_SNAPSHOT_BYTES)
    throw new Error("Recovery snapshot exceeds 4096 bytes");
  const validText = (s: string, max: number) => {
    if (
      [...s].length > max ||
      bytes(s) > max * 4 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)
    )
      throw new Error("Invalid recovery text");
  };
  const r = value.recovery;
  if (r) {
    validText(r.name, 200);
    if (r.phase === "cancel-failed") validText(r.error.message, 256);
    if (r.phase === "restored" && r.sessionId === r.previousSessionId)
      throw new Error("Restored session must be new");
    // A committed policy may lower the limit below attempts already begun.
    if (
      r.phase === "retry-exhausted" &&
      (r.retryLimit === "unlimited" || r.attemptsStarted < r.retryLimit)
    )
      throw new Error("Invalid exhausted recovery");
    if (r.phase === "waiting" && r.retryLimit !== "unlimited" && r.attemptsStarted >= r.retryLimit)
      throw new Error("Exhausted recovery cannot wait");
    if ((r.phase === "connecting" || r.phase === "restored") && r.attemptsStarted === 0)
      throw new Error("Recovery attempt has not started");
  }
  return value;
}
export function supportsConnectionRecovery(version: string): boolean {
  return /^1\.(?:[89]|[1-9][0-9]+)\.[0-9]+$/.test(version);
}
export function isConnectionRecoveryRequest(method: string, params: unknown): boolean {
  return (
    method === "devices/connectionRecovery/read" ||
    (method === "devices/subscribe" &&
      typeof params === "object" &&
      params !== null &&
      "topic" in params &&
      params.topic === "connectionRecovery")
  );
}
