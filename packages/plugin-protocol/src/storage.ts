import { z } from "zod";
import type { Handle, Counter, ReservationSnapshot } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { RecordId, RecordRevision, Version, Sha256, Receipt } from "./settings.js";
import type { PersistenceFailureDetail } from "./persistence-validation.js";
import { boundedText, safeIntegerSchema as n, versionSchema as v, handleSchema as h, revisionSchema as r,
  sha256Schema, receiptSchema, durabilitySchema, chunkSchema, jsonBytes, persistenceResultSchema, persistenceErrorSchema } from "./persistence-validation.js";
export type RecordMeta = {
  id: RecordId;
  revision: RecordRevision;
  kind: string; // /^[a-z][a-z0-9.-]{0,63}$/，source-local filter
  schemaVersion: Version;
  label: string;
  mediaType: "application/json" | "text/plain" | "text/csv" | "application/octet-stream";
  byteLength: number;
  sha256: Sha256;
  createdAt: number; // host UTC epoch milliseconds
  updatedAt: number;
  checkpoint: "none" | "open" | "final";
  interrupted: boolean; // host recovery evidence，不改寫 opaque payload
};
export type RecordTarget =
  { mode: "create" } | { mode: "replace"; id: RecordId; expectedRevision: RecordRevision };
export type RecordWrite = {
  target: RecordTarget;
  kind: string;
  schemaVersion: Version;
  label: string;
  mediaType: RecordMeta["mediaType"];
  byteLength: number; // 0..8 MiB
  sha256: Sha256;
  checkpoint?: { handle: Handle; phase: "checkpoint" | "final" };
  drainToken?: Handle;
};
export type WriteProgress = {
  write: Handle;
  id: RecordId;
  state: "receiving" | "sealed" | "publishing" | "committed" | "aborted" | "expired" | "failed";
  receivedBytes: number;
  expiresAt: number;
  receipt?: Receipt<RecordRevision>;
  error?: { code: string; message: string; detail?: PersistenceFailureDetail };
};
export type DrainReason =
  | "disable"
  | "reload"
  | "remove"
  | "renderer-crash"
  | "window-destroyed"
  | "shutdown"
  | "update"
  | "safe-mode"
  | "reservation-ended";
export type DrainRequest = {
  token: Handle;
  reason: DrainReason;
  remainingMs: number; // 0..10_000；host monotonic deadline 才是權威
  checkpoints: Array<{
    checkpoint: Handle;
    record: RecordMeta;
    reservationEnd?: {
      reservationId: Handle;
      reason: Exclude<ReservationSnapshot["reason"], "active">;
      lastSequence: Counter;
    };
  }>;
  writes: Array<{ write: Handle; id: RecordId; state: "receiving" | "sealed" }>;
};

export const mediaTypeSchema = z.enum(["application/json", "text/plain", "text/csv", "application/octet-stream"]);
export const kindSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const label = boundedText(0, 160, 640, true);
const metadata = { kind: kindSchema, schemaVersion: v, label, mediaType: mediaTypeSchema, byteLength: n.max(8388608), sha256: sha256Schema };
export const recordMetaSchema = z.strictObject({ id: h, revision: r, ...metadata, createdAt: n, updatedAt: n,
  checkpoint: z.enum(["none", "open", "final"]), interrupted: z.boolean() }).refine(m => jsonBytes(m) <= 2048);
export const recordWriteSchema = z.strictObject({ target: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("create") }), z.strictObject({ mode: z.literal("replace"), id: h, expectedRevision: r })]),
  ...metadata, checkpoint: z.strictObject({ handle: h, phase: z.enum(["checkpoint", "final"]) }).optional(), drainToken: h.optional() });
export const writeProgressSchema = z.strictObject({ write: h, id: h, state: z.enum(["receiving", "sealed", "publishing", "committed", "aborted", "expired", "failed"]), receivedBytes: n.max(8388608), expiresAt: n, receipt: receiptSchema.optional(), error: persistenceErrorSchema.optional() });
export const drainRequestSchema = z.strictObject({ token: h,
  reason: z.enum(["disable", "reload", "remove", "renderer-crash", "window-destroyed", "shutdown", "update", "safe-mode", "reservation-ended"]), remainingMs: n.max(10000),
  checkpoints: z.array(z.strictObject({ checkpoint: h, record: recordMetaSchema,
    reservationEnd: z.strictObject({ reservationId: h, reason: z.enum(["released", "source-changed", "disconnected", "suspended", "core-disconnect", "retired", "renderer-lost", "limit", "overflow"]), lastSequence: n }).optional() })).max(2),
  writes: z.array(z.strictObject({ write: h, id: h, state: z.enum(["receiving", "sealed"]) })).max(2),
}) as z.ZodType<DrainRequest, DrainRequest>;
const request = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({ params, result: persistenceResultSchema(value) });
const empty = z.strictObject({}) as z.ZodType<Record<string, never>, Record<string, never>>;
export const storageRequestSchemas = {
  "storage/beginWrite": request(recordWriteSchema, z.strictObject({ write: h, id: h, expiresAt: n })),
  "storage/writeChunk": request(z.strictObject({ write: h, offset: n, data: chunkSchema() }), z.strictObject({ receivedBytes: n.max(8388608), expiresAt: n })),
  "storage/sealWrite": request(z.strictObject({ write: h }), writeProgressSchema),
  "storage/commitWrite": request(z.strictObject({ write: h, drainToken: h.optional() }), z.strictObject({ record: recordMetaSchema, receipt: receiptSchema })),
  "storage/writeStatus": request(z.strictObject({ write: h }), writeProgressSchema),
  "storage/abortWrite": request(z.strictObject({ write: h }), z.strictObject({ disposition: z.enum(["aborted", "committed", "unknown"]), receipt: receiptSchema.optional() })),
  "storage/stat": request(z.strictObject({ id: h }), z.strictObject({ record: recordMetaSchema })),
  "storage/list": request(z.strictObject({ kind: kindSchema.optional(), limit: n.min(1).max(64), cursor: h.optional() }), z.strictObject({ entries: z.array(recordMetaSchema).max(64), nextCursor: h.optional() }).refine(value => jsonBytes({ ok: true, value }) <= 262144)),
  "storage/openRead": request(z.strictObject({ id: h, expectedRevision: r, schemaVersion: v }), z.strictObject({ read: h, record: recordMetaSchema, expiresAt: n })),
  "storage/readChunk": request(z.strictObject({ read: h, offset: n, maxBytes: n.min(1).max(262144) }), z.strictObject({ offset: n, data: chunkSchema(true), nextOffset: n, eof: z.boolean() })),
  "storage/closeRead": request(z.strictObject({ read: h }), empty),
  "storage/delete": request(z.strictObject({ id: h, expectedRevision: r }), z.strictObject({ deleted: z.literal(true), receipt: receiptSchema })),
  "storage/flush": request(empty, z.strictObject({ barrier: h, durability: durabilitySchema })),
  "storage/quota": request(empty, z.strictObject({ recordCount: n, reservedCreates: n, committedBytes: n, reservedBytes: n, pinnedBytes: n, temporaryBytes: n,
    sourceLimitBytes: z.literal(536870912), sourceLimitRecords: z.literal(256), hostAvailableBytes: n, writeSlotsAvailable: n, exportSlotsAvailable: n })),
  "storage/registerCheckpoint": request(z.strictObject({ id: h, expectedRevision: r, reservation: h.optional() }), z.strictObject({ checkpoint: h })),
  "storage/abandonCheckpoint": request(z.strictObject({ checkpoint: h }), z.strictObject({ record: recordMetaSchema })),
  "storage/drain": request(drainRequestSchema, z.strictObject({ status: z.enum(["submitted", "checkpoint-only"]), writes: z.array(h).max(2) })),
};
export type StorageRequestMap = DefinitionMap<typeof storageRequestSchemas>;
