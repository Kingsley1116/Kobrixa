import type { z } from "zod";
type Wire<T> = z.ZodType<T, T>;
import type { Handle } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { Sha256, Durability } from "./settings.js";
import type { RecordMeta } from "./storage.js";
import type { PersistenceFailureDetail, PersistenceResult } from "./persistence-validation.js";

export declare const persistenceActionRequestSchemas: {
  "storage/exportBegin": { params: Wire<{actionRef: Handle; suggestedName: string; mediaType: RecordMeta["mediaType"]; byteLength: number; sha256: Sha256}>; result: Wire<PersistenceResult<{export: Handle; state: "waiting"; expiresAt: number}>> };
  "storage/exportChunk": { params: Wire<{export: Handle; offset: number; data: string}>; result: Wire<PersistenceResult<{receivedBytes: number; expiresAt: number}>> };
  "storage/exportCommit": { params: Wire<{export: Handle}>; result: Wire<PersistenceResult<{exported: true; commitId: Handle; durability: Durability}>> };
  "storage/exportStatus": { params: Wire<{export: Handle}>; result: Wire<PersistenceResult<{state: "waiting" | "receiving" | "publishing" | "completed" | "cancelled" | "expired" | "failed"; receivedBytes: number; expiresAt: number; commitId?: Handle; durability?: Durability; error?: {code: string; message: string; detail?: PersistenceFailureDetail}}>> };
  "storage/exportCancel": { params: Wire<{export: Handle}>; result: Wire<PersistenceResult<{disposition: "aborted" | "committed" | "unknown"; commitId?: Handle}>> };
  "ui/copyText": { params: Wire<{actionRef: Handle; text: string}>; result: Wire<PersistenceResult<{copied: true}>> };
};
export type PersistenceActionRequestMap = DefinitionMap<typeof persistenceActionRequestSchemas>;
