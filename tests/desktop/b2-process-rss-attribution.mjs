import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, open, rm } from "node:fs/promises";
import { openStoreRoot } from "../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import { startPersistenceWorker } from "../../apps/desktop/src/main/plugins/persistence/worker.ts";
import { createLegacyWriterBarrier } from "../../apps/desktop/src/main/plugins/persistence/import-sources.ts";
import { createLegacyImportCoordinator } from "../../apps/desktop/src/main/plugins/persistence/import-coordinator.ts";
import { syntheticImportDescriptor as descriptor } from "../../apps/desktop/src/main/plugins/persistence/import-fixtures.ts";
import { BroadcastChannel } from "node:worker_threads";
import { writeHeapSnapshot } from "node:v8";
import { setTimeout as wait } from "node:timers/promises";
import { darwinProbe } from "./b2-process-rss-attribution-darwin.mjs";
import { sample } from "./b2-process-rss-attribution-probe.mjs";

async function launch(root) {
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const { backend, recovery } = await startPersistenceWorker({
    profile,
    root: await openStoreRoot({ userData: root, profile }),
    now: () => performance.now(),
    workerEntry: fileURLToPath(new URL("./b2-process-rss-attribution-worker.mjs", import.meta.url)),
  });
  assert.equal(recovery, "ready");
  const owner = {
    sourceKey: descriptor.targetSourceKey,
    pluginId: descriptor.id,
    generation: 1,
    hostEpoch: profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  const options = { backend, descriptors: [descriptor], importOwner: () => owner };
  const coordinator = createLegacyImportCoordinator({
    ...options,
    sources: backend.sources,
    currentSource: () => true,
    currentScope: () => true,
    barrier: createLegacyWriterBarrier({ ...options, writers: [] }),
  });
  return { backend, owner, coordinator };
}

const count = Number(process.argv[2] ?? 50);
const chunkSize = Number(process.argv[3] ?? 262144);
assert.ok([1, 10, 50].includes(count));
assert.ok([65536, 131072, 262144].includes(chunkSize));
assert.equal(typeof globalThis.gc, "function");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "w16a-")));
const port = new BroadcastChannel("w16a-" + process.pid);
const snapDir = process.env.W16A_SNAPSHOTS;
const probe = async (request) => {
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("worker probe timeout")), 60000);
      port.onmessage = ({ data }) => resolve(data);
      port.postMessage(request);
    });
  } finally {
    clearTimeout(timer);
  }
};
try {
  const native = darwinProbe(root);
  const legacy = path.join(root, "legacy");
  await mkdir(legacy);
  const chunk = Buffer.alloc(262144, 0x61),
    expected = [];
  for (let i = 0; i < count; i++) {
    const head = Buffer.from(JSON.stringify({ formatVersion: 1, id: i, payload: "" }).slice(0, -2));
    const fd = await open(path.join(legacy, i + ".json"), "wx");
    const hash = createHash("sha256");
    try {
      for (let n = 0; n < 32; n++) {
        chunk.fill(0x61);
        if (!n) head.copy(chunk);
        if (n === 31) chunk.write('"}', chunk.length - 2);
        await fd.writeFile(chunk);
        hash.update(chunk);
      }
    } finally {
      await fd.close();
    }
    expected.push(hash.digest("hex"));
  }

  const { backend, owner, coordinator } = await launch(root);
  try {
    let peak = 0,
      completed = 0;
    const emit = (row) => console.log(JSON.stringify(row));
    const point = async (phase, request = {}) => {
      const worker = await probe(request);
      const main = sample();
      peak = Math.max(peak, main.memory.rss, worker.memory.rss);
      emit({
        phase,
        completed,
        main,
        worker,
        vm: native.regions?.(),
        freePages: native.freePages?.(),
      });
      return main.memory.rss;
    };
    emit({
      count,
      chunkSize,
      mode: process.env.W16A_MODE ?? "stock",
      pid: process.pid,
      flags: process.execArgv,
      versions: process.versions,
    });
    if (snapDir) {
      writeHeapSnapshot(path.join(snapDir, "main-before.heapsnapshot"));
      await probe({ snapshot: path.join(snapDir, "worker-before.heapsnapshot") });
    }
    let allocationSample;
    if (process.env.W16A_ALLOCATIONS) {
      ({ allocationSample } = await import("./b2-process-rss-attribution-allocations.mjs"));
      await allocationSample("start");
      await probe({ allocations: "start" });
    }
    native.freePages?.(); // Touch observer storage before measuring its baseline.
    const baseline = await point("baseline");
    peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 20);
    try {
      const inventory = backend.sources.inventory;
      backend.sources.inventory = async (...args) => {
        const result = await inventory(...args);
        await point("inventory");
        return result;
      };
      const record = backend.imports.record;
      backend.imports.record = async (...args) => {
        const result = await record(...args);
        if (args[2].state === "committed" && ++completed % 5 === 0) await point("imports");
        return result;
      };
      const append = backend.sources.appendMapped;
      backend.sources.appendMapped = (input) =>
        append({ ...input, maxBytes: Math.min(chunkSize, input.maxBytes) });
      assert.deepEqual(await coordinator.run(descriptor, new AbortController().signal), {
        state: "complete",
        completedItems: count,
        totalItems: count,
      });
      assert.equal(completed, count);
      const end = await point("work-end");
      emit({ baseline, peak, end, peakDelta: peak - baseline, endDelta: end - baseline });
    } finally {
      clearInterval(timer);
    }
    if (allocationSample)
      emit({ allocations: [await allocationSample("stop"), await probe({ allocations: "stop" })] });
    globalThis.gc();
    await point("forced-gc", { gc: true });
    await wait(10000);
    await point("gc-idle-10s");
    if (native.relief) {
      emit({ allocatorReportedRelief: native.relief() });
      await point("after-allocator-relief");
    }
    if (snapDir) {
      writeHeapSnapshot(path.join(snapDir, "main-after.heapsnapshot"));
      await probe({ snapshot: path.join(snapDir, "worker-after.heapsnapshot") });
    }
    const records = (await backend.reads.list(owner, { limit: 64 })).entries;
    assert.equal(records.length, count);
    const actual = [];
    for (const r of records) {
      const hash = createHash("sha256");
      const pin = await backend.reads.open(owner, r.id, r.revision);
      try {
        assert.equal((await backend.reads.read(owner, pin, r.byteLength, 262144)).length, 0);
        for (let offset = 0; offset < 8388608; offset += 262144) {
          const bytes = await backend.reads.read(owner, pin, offset, 262144);
          assert.equal(bytes.length, 262144);
          hash.update(bytes);
        }
      } finally {
        await backend.reads.close(owner, pin);
      }
      actual.push(hash.digest("hex"));
    }
    assert.deepEqual(actual.sort(), expected.sort());

    emit({ verifiedDestinationHashes: actual.length });
  } finally {
    await backend.dispose();
  }
} finally {
  port.close();
  await rm(root, { recursive: true, force: true });
}
