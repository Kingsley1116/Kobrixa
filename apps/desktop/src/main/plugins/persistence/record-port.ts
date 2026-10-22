import type { StorageRequestMap } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
export interface RecordServicePort {
  request<M extends keyof StorageRequestMap>(
    principal: Principal,
    method: M,
    params: StorageRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<StorageRequestMap[M]["result"]>;
}
