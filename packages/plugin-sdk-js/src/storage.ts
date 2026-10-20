import type { Handle, StorageRequestMap } from "@kobrixa/plugin-protocol";
import { persistenceCall, type PersistenceRequest, type PersistenceClientFor } from "./settings.js";
export function createStorageClient(request: PersistenceRequest): PersistenceClientFor<keyof StorageRequestMap> {
  return Object.freeze({
    beginWrite: persistenceCall(request, "storage/beginWrite"), writeChunk: persistenceCall(request, "storage/writeChunk"),
    sealWrite: persistenceCall(request, "storage/sealWrite"), commitWrite: persistenceCall(request, "storage/commitWrite"),
    writeStatus: persistenceCall(request, "storage/writeStatus"), abortWrite: persistenceCall(request, "storage/abortWrite"),
    stat: persistenceCall(request, "storage/stat"), list: persistenceCall(request, "storage/list"),
    openRead: persistenceCall(request, "storage/openRead"), readChunk: persistenceCall(request, "storage/readChunk"),
    closeRead: persistenceCall(request, "storage/closeRead"), delete: persistenceCall(request, "storage/delete"),
    flush: persistenceCall(request, "storage/flush"), quota: persistenceCall(request, "storage/quota"),
    drain: persistenceCall(request, "storage/drain"),
    registerCheckpoint: persistenceCall(request, "storage/registerCheckpoint"), abandonCheckpoint: persistenceCall(request, "storage/abandonCheckpoint"),
  });
}
export function acceptDrainSubmission(input: unknown): { status: "submitted" | "checkpoint-only"; writes: Handle[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Invalid drain submission");
  const v = input as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || (v.status !== "submitted" && v.status !== "checkpoint-only") || !Array.isArray(v.writes) || v.writes.length > 2 ||
    !v.writes.every(h => typeof h === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(h))) throw new TypeError("Invalid drain submission");
  return { status: v.status, writes: [...v.writes] as Handle[] };
}
