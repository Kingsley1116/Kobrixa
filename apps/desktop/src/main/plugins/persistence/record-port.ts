import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type {
  PersistenceFailureDetail,
  PersistenceReason,
  RecordMeta,
  RecordWrite,
  ResourceOwner,
  StorageRequestMap,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type {
  PersistenceEnginePort,
  PersistenceReadPort,
  PersistenceEvidencePort,
} from "./engine-port.js";
export interface RecordServicePort {
  request<M extends keyof StorageRequestMap>(
    principal: Principal,
    method: M,
    params: StorageRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<StorageRequestMap[M]["result"]>;
}
export const ownerKey = (owner: ResourceOwner) =>
  JSON.stringify([
    owner.sourceKey,
    owner.pluginId,
    owner.generation,
    owner.hostEpoch,
    owner.processEpoch,
  ]);
type Progress = Extract<StorageRequestMap["storage/writeStatus"]["result"], { ok: true }>["value"];
type Failure = { ok: false; error: NonNullable<Progress["error"]> };
type Resource = Extract<PersistenceFailureDetail, { kind: "resource" }>["resource"];
export class PersistenceFault extends Error {
  readonly result: Failure;
  constructor(
    code: Failure["error"]["code"],
    reason?: PersistenceReason,
    resource: Resource = "storage-write",
  ) {
    super("Persistence request could not be completed.");
    const detail: PersistenceFailureDetail | undefined =
      code === "PLUGIN_E_STALE_RESOURCE"
        ? { kind: "resource", reason: "stale", resource }
        : code === "PLUGIN_E_RESOURCE_LIMIT"
          ? { kind: "resource", reason: "quota", resource }
          : code === "PLUGIN_E_PERMISSION_DENIED"
            ? { kind: "permission", reason: "permission" }
            : reason
              ? { kind: "persistence", reason }
              : undefined;
    this.result = {
      ok: false,
      error: { code, message: this.message, ...(detail ? { detail } : {}) },
    };
  }
}
export function stale(resource: Resource = "storage-write"): never {
  throw new PersistenceFault("PLUGIN_E_STALE_RESOURCE", undefined, resource);
}
export function conflict(reason: PersistenceReason): never {
  throw new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", reason);
}
export function limit(resource: Resource = "storage-write"): never {
  throw new PersistenceFault("PLUGIN_E_RESOURCE_LIMIT", undefined, resource);
}
export function decodeChunk(text: string): Uint8Array {
  if (
    !text.length ||
    text.length > 349528 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new RpcError(RPC_ERRORS.invalidParams, "Invalid chunk encoding.");
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.length > 262144 || bytes.toString("base64") !== text)
    throw new RpcError(RPC_ERRORS.invalidParams, "Invalid chunk encoding.");
  return bytes;
}
export type RecordDependencies = {
  now(): number;
  wall(): number;
  live(owner: ResourceOwner): boolean;
  permission(principal: Principal, permission: "storage.read" | "storage.write"): boolean;
  engine: PersistenceEnginePort;
  read: PersistenceReadPort;
  evidence: PersistenceEvidencePort;
  checkpoint: {
    authorize(owner: ResourceOwner, input: RecordWrite, token?: string): RecordMeta["checkpoint"];
    committed(owner: ResourceOwner, input: RecordWrite, record: RecordMeta): void;
    open(owner: ResourceOwner): boolean;
    register(
      owner: ResourceOwner,
      params: StorageRequestMap["storage/registerCheckpoint"]["params"],
    ): Promise<StorageRequestMap["storage/registerCheckpoint"]["result"]>;
    abandon(
      owner: ResourceOwner,
      params: StorageRequestMap["storage/abandonCheckpoint"]["params"],
    ): Promise<StorageRequestMap["storage/abandonCheckpoint"]["result"]>;
  };
};
