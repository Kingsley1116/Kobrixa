import type { SettingsRequestMap, StorageRequestMap, PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
export type PersistenceMaps = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
export type PersistenceClientFor<K extends keyof PersistenceMaps> = {
  [M in K as M extends `${string}/${infer Name}` ? Name : never]:
    (params: PersistenceMaps[M]["params"], signal?: AbortSignal) => Promise<PersistenceMaps[M]["result"]>
};
export type PersistenceRequest = <M extends keyof PersistenceMaps>(method: M, params: PersistenceMaps[M]["params"], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<PersistenceMaps[M]["result"]>;
export function persistenceCall<M extends keyof PersistenceMaps>(request: PersistenceRequest, method: M) {
  return (params: PersistenceMaps[M]["params"], signal?: AbortSignal): Promise<PersistenceMaps[M]["result"]> =>
    request(method, params, { timeoutMs: 10000, ...(signal === undefined ? {} : { signal }) });
}
export function createSettingsClient(request: PersistenceRequest): PersistenceClientFor<keyof SettingsRequestMap> {
  return Object.freeze({
    read: persistenceCall(request, "settings/read"), update: persistenceCall(request, "settings/update"),
    reset: persistenceCall(request, "settings/reset"), watch: persistenceCall(request, "settings/watch"),
    readMigration: persistenceCall(request, "settings/readMigration"), migrate: persistenceCall(request, "settings/migrate"),
  });
}
