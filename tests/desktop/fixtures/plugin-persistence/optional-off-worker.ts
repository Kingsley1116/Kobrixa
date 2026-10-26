import { appendFileSync } from "node:fs";
import { threadId } from "node:worker_threads";
import { runPersistenceWorker } from "../../../../apps/desktop/src/main/plugins/persistence/worker.js";
import {
  syntheticImportDescriptor,
  syntheticPreferencesImportDescriptor,
} from "../../../../apps/desktop/src/main/plugins/persistence/import-fixtures.js";
/** Same real worker and mapper descriptors; observe before forwarding every map call. */
export function runOptionalOffWorker(sourceRoots: Map<string, string>) {
  const file = process.env.PERSISTENCE_OPTIONAL_MAPPER_LOG;
  const runId = process.env.PERSISTENCE_OPTIONAL_RUN_ID;
  if (!file || !runId) throw new Error("Missing bounded worker observation destination");
  const descriptors = [syntheticImportDescriptor, syntheticPreferencesImportDescriptor];
  const log = (kind: string, descriptor?: string) =>
    appendFileSync(
      file,
      JSON.stringify({ kind, descriptor, runId, pid: process.pid, threadId, wall: Date.now() }) +
        "\n",
    );
  log("installed");
  runPersistenceWorker({
    sourceRoots,
    mappers: new Map(
      descriptors.map((d) => [
        d.id,
        {
          ...d,
          map(input: Parameters<typeof d.map>[0]) {
            log("map", d.id);
            return d.map(input);
          },
        },
      ]),
    ),
  });
}
