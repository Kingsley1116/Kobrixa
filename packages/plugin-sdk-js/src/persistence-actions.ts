import type { PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
import { persistenceCall, type PersistenceRequest, type PersistenceClientFor } from "./settings.js";
export function createPersistenceActionsClient(request: PersistenceRequest): PersistenceClientFor<keyof PersistenceActionRequestMap> {
  return Object.freeze({
    exportBegin: persistenceCall(request, "storage/exportBegin"), exportChunk: persistenceCall(request, "storage/exportChunk"),
    exportCommit: persistenceCall(request, "storage/exportCommit"), exportStatus: persistenceCall(request, "storage/exportStatus"),
    exportCancel: persistenceCall(request, "storage/exportCancel"), copyText: persistenceCall(request, "ui/copyText"),
  });
}
