import type { z } from "zod";
type Wire<T> = z.ZodType<T, T>;
import type { Handle, Counter, ReservationSnapshot } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { RecordId, RecordRevision, Version, Sha256, Receipt, Durability } from "./settings.js";
import type { PersistenceFailureDetail, PersistenceResult } from "./persistence-validation.js";
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

export declare const storageRequestSchemas: {
  "storage/beginWrite": { params: Wire<RecordWrite>; result: Wire<PersistenceResult<{write: Handle; id: RecordId; expiresAt: number}>> };
  "storage/writeChunk": { params: Wire<{write: Handle; offset: number; data: string}>; result: Wire<PersistenceResult<{receivedBytes: number; expiresAt: number}>> };
  "storage/sealWrite": { params: Wire<{write: Handle}>; result: Wire<PersistenceResult<WriteProgress>> };
  "storage/commitWrite": { params: Wire<{write: Handle; drainToken?: Handle}>; result: Wire<PersistenceResult<{record: RecordMeta; receipt: Receipt<RecordRevision>}>> };
  "storage/writeStatus": { params: Wire<{write: Handle}>; result: Wire<PersistenceResult<WriteProgress>> };
  "storage/abortWrite": { params: Wire<{write: Handle}>; result: Wire<PersistenceResult<{disposition: "aborted" | "committed" | "unknown"; receipt?: Receipt<RecordRevision>}>> };
  "storage/stat": { params: Wire<{id: RecordId}>; result: Wire<PersistenceResult<{record: RecordMeta}>> };
  "storage/list": { params: Wire<{kind?: string; limit: number; cursor?: Handle}>; result: Wire<PersistenceResult<{entries: RecordMeta[]; nextCursor?: Handle}>> };
  "storage/openRead": { params: Wire<{id: RecordId; expectedRevision: RecordRevision; schemaVersion: Version}>; result: Wire<PersistenceResult<{read: Handle; record: RecordMeta; expiresAt: number}>> };
  "storage/readChunk": { params: Wire<{read: Handle; offset: number; maxBytes: number}>; result: Wire<PersistenceResult<{offset: number; data: string; nextOffset: number; eof: boolean}>> };
  "storage/closeRead": { params: Wire<{read: Handle}>; result: Wire<PersistenceResult<Record<string, never>>> };
  "storage/delete": { params: Wire<{id: RecordId; expectedRevision: RecordRevision}>; result: Wire<PersistenceResult<{deleted: true; receipt: Receipt<RecordRevision>}>> };
  "storage/flush": { params: Wire<Record<string, never>>; result: Wire<PersistenceResult<{barrier: Handle; durability: Durability}>> };
  "storage/quota": { params: Wire<Record<string, never>>; result: Wire<PersistenceResult<{recordCount: number; reservedCreates: number; committedBytes: number; reservedBytes: number; pinnedBytes: number; temporaryBytes: number; sourceLimitBytes: 536870912; sourceLimitRecords: 256; hostAvailableBytes: number; writeSlotsAvailable: number; exportSlotsAvailable: number}>> };
  "storage/registerCheckpoint": { params: Wire<{id: RecordId; expectedRevision: RecordRevision; reservation?: Handle}>; result: Wire<PersistenceResult<{checkpoint: Handle}>> };
  "storage/abandonCheckpoint": { params: Wire<{checkpoint: Handle}>; result: Wire<PersistenceResult<{record: RecordMeta}>> };
  "storage/drain": { params: Wire<DrainRequest>; result: Wire<PersistenceResult<{status: "submitted" | "checkpoint-only"; writes: Handle[]}>> };
};
export type StorageRequestMap = DefinitionMap<typeof storageRequestSchemas>;
