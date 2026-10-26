import { z } from "zod";
import type { DefinitionMap } from "./business-result.js";
import { mediaTypeSchema } from "./storage.js";
import { boundedText, safeIntegerSchema as n, handleSchema as h, sha256Schema, durabilitySchema, chunkSchema,
  persistenceResultSchema, persistenceErrorSchema } from "./persistence-validation.js";
const request = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({ params, result: persistenceResultSchema(value) });
export const persistenceActionRequestSchemas = {
  "storage/exportBegin": request(z.strictObject({ actionRef: h, suggestedName: boundedText(1, 80, 320, true).refine(s => !/[\\/:]/.test(s) && s !== "." && s !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)), mediaType: mediaTypeSchema, byteLength: n.max(8388608), sha256: sha256Schema }), z.strictObject({ export: h, state: z.literal("waiting"), expiresAt: n })),
  "storage/exportChunk": request(z.strictObject({ export: h, offset: n, data: chunkSchema() }), z.strictObject({ receivedBytes: n.max(8388608), expiresAt: n })),
  "storage/exportCommit": request(z.strictObject({ export: h }), z.strictObject({ exported: z.literal(true), commitId: h, durability: durabilitySchema })),
  "storage/exportStatus": request(z.strictObject({ export: h }), z.strictObject({ state: z.enum(["waiting", "receiving", "publishing", "completed", "cancelled", "expired", "failed"]), receivedBytes: n.max(8388608), expiresAt: n, commitId: h.optional(), durability: durabilitySchema.optional(), error: persistenceErrorSchema.optional() })),
  "storage/exportCancel": request(z.strictObject({ export: h }), z.strictObject({ disposition: z.enum(["aborted", "committed", "unknown"]), commitId: h.optional() })),
  "ui/copyText": request(z.strictObject({ actionRef: h, text: boundedText(0, 16384, 65536) }), z.strictObject({ copied: z.literal(true) })),
};
export type PersistenceActionRequestMap = DefinitionMap<typeof persistenceActionRequestSchemas>;
