// Build this wrapper into a worker entry; importing it does not start a worker.
import { isAbsolute } from "node:path";
import { runPersistenceWorker } from "../../../../apps/desktop/src/main/plugins/persistence/worker.js";
import {
  syntheticImportDescriptor,
  syntheticPreferencesImportDescriptor,
} from "../../../../apps/desktop/src/main/plugins/persistence/import-fixtures.js";

export function runSyntheticPersistenceWorker(sourceRoots) {
  if (
    !(sourceRoots instanceof Map) ||
    sourceRoots.size !== 1 ||
    !isAbsolute(sourceRoots.get(syntheticImportDescriptor.id) ?? "")
  )
    throw new Error("Synthetic file descriptor requires its explicit absolute source root");
  // Worker validates containment, symlinks and descriptor/root identity before ready.
  runPersistenceWorker({
    mappers: new Map(
      [syntheticImportDescriptor, syntheticPreferencesImportDescriptor].map((d) => [d.id, d]),
    ),
    sourceRoots,
  });
}
