import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openStoreRoot } from "../../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import { startPersistenceWorker } from "../../../apps/desktop/src/main/plugins/persistence/worker.ts";
import { createLegacyWriterBarrier } from "../../../apps/desktop/src/main/plugins/persistence/import-sources.ts";
import { createLegacyImportCoordinator } from "../../../apps/desktop/src/main/plugins/persistence/import-coordinator.ts";
import { syntheticImportDescriptor as descriptor } from "../../../apps/desktop/src/main/plugins/persistence/import-fixtures.ts";

export async function launch(
  root,
  testControl,
  importDescriptor = descriptor,
  expectedRecovery = "ready",
  profile = { hostEpoch: randomUUID(), assertHeld() {} },
) {
  const { backend, recovery } = await startPersistenceWorker({
    profile,
    testControl,
    root: await openStoreRoot({ userData: root, profile }),
    now: () => performance.now(),
    workerEntry: fileURLToPath(
      new URL("../fixtures/plugin-persistence/stream-import-worker.mjs", import.meta.url),
    ),
  });
  if (recovery !== expectedRecovery) await backend.dispose();
  assert.equal(recovery, expectedRecovery);
  const owner = {
    sourceKey: importDescriptor.targetSourceKey,
    pluginId: importDescriptor.id,
    generation: 1,
    hostEpoch: profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  const options = { backend, descriptors: [importDescriptor], importOwner: () => owner };
  const coordinator = createLegacyImportCoordinator({
    ...options,
    sources: backend.sources,
    currentSource: () => true,
    currentScope: () => true,
    barrier: createLegacyWriterBarrier({ ...options, writers: [] }),
  });
  return { backend, owner, coordinator };
}
