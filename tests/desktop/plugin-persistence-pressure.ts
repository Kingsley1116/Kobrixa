import type { PluginProcess } from "@kobrixa/plugin-runtime";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import type { RecordMeta, RecordTarget, ResourceOwner } from "@kobrixa/plugin-protocol";

export const PRESSURE = Object.freeze({
  records: 50,
  perSource: 25,
  recordBytes: 8388608,
  chunkBytes: 262144,
  staging: 2,
  samples: 30,
  workloadMs: 600000,
});
type Storage = PluginContext["storage"];
type Observation = { operation: string; startedAt: number; finishedAt: number; result: unknown };
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("Public storage business failure");
  return r.value;
};
/** Expected bytes for an arbitrary read range; never allocates more than 256 KiB. */
export function pressureSlice(seed: string, offset: number, length: number): Buffer {
  assert.ok(Number.isSafeInteger(offset) && offset >= 0);
  assert.ok(Number.isSafeInteger(length) && length > 0 && length <= PRESSURE.chunkBytes);
  assert.ok(offset + length <= PRESSURE.recordBytes);
  const bytes = Buffer.alloc(length);
  let written = 0;
  while (written < length) {
    const absolute = offset + written;
    const block = Math.floor(absolute / PRESSURE.chunkBytes) * PRESSURE.chunkBytes;
    const pattern = createHash("sha256").update(`${seed}:${block}`).digest();
    const end = Math.min(length, written + block + PRESSURE.chunkBytes - absolute);
    while (written < end) {
      const phase = (offset + written - block) % pattern.length;
      const count = Math.min(pattern.length - phase, end - written);
      pattern.copy(bytes, written, phase, phase + count);
      written += count;
    }
  }
  return bytes;
}
export function pressureChunk(seed: string, offset: number): Buffer {
  assert.equal(offset % PRESSURE.chunkBytes, 0);
  return pressureSlice(seed, offset, PRESSURE.chunkBytes);
}
export function pressureHash(seed: string): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < PRESSURE.recordBytes; offset += PRESSURE.chunkBytes)
    hash.update(pressureChunk(seed, offset));
  return hash.digest("hex");
}

/** One real SDK storage context per original process/source. Commands are single-flight. */
export function createPressureWorkload(
  storage: Storage,
  source: string,
  emit: (observation: Observation) => void,
) {
  const records: Array<{ record: RecordMeta; seed: string }> = [];
  const held = new Map<string, { id: string; state: string }>();
  const readers = new Set<string>();
  const closeRead = async (read: string) => {
    value(await storage.closeRead({ read }));
    readers.delete(read);
  };
  let busy = false,
    verifyIndex = 0,
    replacement = 0;
  const timed = async <T>(operation: string, work: () => Promise<T>) => {
    const startedAt = performance.now();
    const result = await work();
    emit({ operation, startedAt, finishedAt: performance.now(), result });
    return result;
  };
  const serial = async <T>(work: () => Promise<T>) => {
    assert.equal(busy, false, "Overlapping pressure commands are forbidden");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  const abort = async (write: string) => {
    // Cleanup is independent of an already-cancelled operation. Unknown stays owned.
    const result = value(await storage.abortWrite({ write }));
    emit({
      operation: "abort",
      startedAt: performance.now(),
      finishedAt: performance.now(),
      result: { write, ...result },
    });
    assert.notEqual(
      result.disposition,
      "unknown",
      "Uncertain staging retained for host reconciliation",
    );
    held.delete(write);
  };
  const stage = async (seed: string, target: RecordTarget, signal: AbortSignal) => {
    signal.throwIfAborted();
    const metadata = {
      kind: "test.pressure",
      schemaVersion: 1,
      label: seed,
      mediaType: "application/octet-stream" as const,
      byteLength: PRESSURE.recordBytes,
      sha256: pressureHash(seed),
    };
    const write = value(await storage.beginWrite({ ...metadata, target }, signal));
    held.set(write.write, { id: write.id, state: "receiving" });
    try {
      for (let offset = 0; offset < PRESSURE.recordBytes; offset += PRESSURE.chunkBytes) {
        signal.throwIfAborted();
        const bytes = pressureChunk(seed, offset);
        const result = value(
          await storage.writeChunk(
            { write: write.write, offset, data: bytes.toString("base64") },
            signal,
          ),
        );
        assert.equal(result.receivedBytes, offset + bytes.length);
      }
      signal.throwIfAborted();
      const sealed = value(await storage.sealWrite({ write: write.write }, signal));
      assert.equal(sealed.state, "sealed");
      assert.equal(sealed.receivedBytes, PRESSURE.recordBytes);
      held.set(write.write, { id: write.id, state: "sealed" });
      signal.throwIfAborted();
      return { write, metadata };
    } catch (error) {
      try {
        await abort(write.write);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Staging failed; cleanup unresolved");
      }
      throw error;
    }
  };
  const verifyRecord = async (
    expected: { record: RecordMeta; seed: string },
    signal: AbortSignal,
  ) => {
    const opened = value(
      await storage.openRead(
        {
          id: expected.record.id,
          expectedRevision: expected.record.revision,
          schemaVersion: 1,
        },
        signal,
      ),
    );
    readers.add(opened.read);
    try {
      assert.deepEqual(opened.record, expected.record);
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < PRESSURE.recordBytes) {
        signal.throwIfAborted();
        const requested = Math.min(PRESSURE.chunkBytes, PRESSURE.recordBytes - offset);
        const chunk = value(
          await storage.readChunk({ read: opened.read, offset, maxBytes: requested }, signal),
        );
        const decodedLength = Buffer.byteLength(chunk.data, "base64");
        assert.ok(
          decodedLength > 0 && decodedLength <= requested,
          "Invalid read progress or length",
        );
        const bytes = Buffer.from(chunk.data, "base64");
        assert.equal(bytes.length, decodedLength);
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.nextOffset, offset + bytes.length);
        assert.equal(chunk.eof, chunk.nextOffset === PRESSURE.recordBytes);
        assert.deepEqual(
          bytes,
          pressureSlice(expected.seed, offset, bytes.length),
          "Readback differs from independently generated payload",
        );
        hash.update(bytes);
        offset = chunk.nextOffset;
      }
      assert.equal(offset, PRESSURE.recordBytes);
      const digest = hash.digest("hex");
      assert.equal(digest, expected.record.sha256);
      return {
        id: expected.record.id,
        revision: expected.record.revision,
        byteLength: offset,
        sha256: digest,
      };
    } finally {
      await closeRead(opened.read);
    }
  };
  let pendingReplacement:
    | {
        staged: Awaited<ReturnType<typeof stage>>;
        target: RecordTarget;
        index: number;
        seed: string;
      }
    | undefined;
  const commit = async (
    staged: Awaited<ReturnType<typeof stage>>,
    target: RecordTarget,
    signal: AbortSignal,
  ) => {
    const { write, metadata } = staged;
    try {
      const saved = value(
        await timed("commit", () => storage.commitWrite({ write: write.write }, signal)),
      );
      assert.equal(saved.record.id, write.id);
      assert.equal(saved.record.byteLength, PRESSURE.recordBytes);
      assert.equal(saved.record.sha256, metadata.sha256);
      assert.equal(saved.receipt.revision, saved.record.revision);
      assert.ok(["file-and-directory-sync", "file-sync-only"].includes(saved.receipt.durability));
      if (target.mode === "replace")
        assert.notEqual(saved.record.revision, target.expectedRevision);
      held.delete(write.write);
      return saved.record;
    } catch (error) {
      try {
        await abort(write.write);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Publication failed; cleanup unresolved");
      }
      throw error;
    }
  };
  const publish = async (seed: string, target: RecordTarget, signal: AbortSignal) =>
    commit(await stage(seed, target, signal), target, signal);
  const inventory = async (signal: AbortSignal) => {
    const entries: RecordMeta[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = value(
        await timed("list", () =>
          storage.list({ kind: "test.pressure", limit: 16, ...(cursor ? { cursor } : {}) }, signal),
        ),
      );
      entries.push(...page.entries);
      assert.ok(entries.length <= PRESSURE.perSource, "Unexpected durable record count");
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        assert.ok(!cursors.has(cursor), "Repeated list cursor");
        cursors.add(cursor);
        assert.ok(cursors.size <= 32, "Pressure inventory pagination bound exceeded");
      }
    } while (cursor !== undefined);
    assert.equal(entries.length, PRESSURE.perSource);
    assert.equal(new Set(entries.map((r) => r.id)).size, PRESSURE.perSource);
    for (const { record } of records)
      assert.deepEqual(
        entries.find((r) => r.id === record.id),
        record,
      );
    return entries;
  };
  return {
    seedOne: (signal: AbortSignal) =>
      serial(async () => {
        assert.ok(records.length < PRESSURE.perSource);
        const seed = `${source}:${records.length}:initial`;
        const record = await publish(seed, { mode: "create" }, signal);
        records.push({ record, seed });
        return record;
      }),
    inventory: (signal: AbortSignal) => serial(() => inventory(signal)),
    verifyOne: (signal: AbortSignal) =>
      serial(async () => {
        assert.equal(records.length, PRESSURE.perSource);
        assert.ok(verifyIndex < records.length);
        const result = await verifyRecord(records[verifyIndex]!, signal);
        verifyIndex++;
        return result;
      }),
    // Exactly two independent read handles; do not fail-fast and abandon the sibling.
    burst: (signal: AbortSignal) =>
      serial(async () => {
        assert.equal(verifyIndex, PRESSURE.perSource);
        const settled = await Promise.allSettled(
          records.slice(0, 2).map((record) => verifyRecord(record, signal)),
        );
        const errors = settled.filter((r) => r.status === "rejected").map((r) => r.reason);
        if (errors.length) throw new AggregateError(errors, "Parallel read verification failed");
        return settled.map((r) => {
          assert.equal(r.status, "fulfilled");
          return r.value;
        });
      }),
    stageOne: (signal: AbortSignal) =>
      serial(async () => {
        assert.equal(verifyIndex, PRESSURE.perSource, "Readback must precede pressure staging");
        assert.equal(held.size, 0, "One maximum staging record per source");
        const index = replacement % records.length,
          old = records[index]!;
        const seed = `${source}:${index}:replacement:${replacement + 1}`;
        const target: RecordTarget = {
          mode: "replace",
          id: old.record.id,
          expectedRevision: old.record.revision,
        };
        const staged = await stage(seed, target, signal);
        pendingReplacement = { staged, target, index, seed };
        return { ...staged.write, byteLength: PRESSURE.recordBytes };
      }),
    stagingStatus: (signal: AbortSignal) =>
      serial(async () => {
        assert.equal(held.size, 1);
        const results = [];
        for (const write of held.keys()) {
          const status = value(await storage.writeStatus({ write }, signal));
          assert.equal(status.state, "sealed", "Expired staging is not live pressure");
          assert.equal(status.receivedBytes, PRESSURE.recordBytes);
          results.push(status);
        }
        return results;
      }),
    replaceOne: (signal: AbortSignal) =>
      serial(async () => {
        assert.equal(verifyIndex, PRESSURE.perSource);
        const index = replacement % records.length,
          old = records[index]!;
        const seed = `${source}:${index}:replacement:${replacement + 1}`;
        const target: RecordTarget = {
          mode: "replace",
          id: old.record.id,
          expectedRevision: old.record.revision,
        };
        // Commit the held maximum-size stage instead of allocating a third stage.
        if (pendingReplacement && !held.has(pendingReplacement.staged.write.write))
          pendingReplacement = undefined;
        if (!pendingReplacement) {
          assert.equal(held.size, 0, "Unresolved write must be cleaned before another publication");
          pendingReplacement = { staged: await stage(seed, target, signal), target, index, seed };
        }
        const pending = pendingReplacement;
        try {
          const record = await commit(pending.staged, pending.target, signal);
          records[pending.index] = { record, seed: pending.seed };
          replacement++;
          return record;
        } finally {
          if (!held.has(pending.staged.write.write)) pendingReplacement = undefined;
        }
      }),
    flush: (signal: AbortSignal) =>
      serial(async () => value(await timed("flush", () => storage.flush({}, signal)))),
    quota: (signal: AbortSignal) => serial(async () => value(await storage.quota({}, signal))),
    cleanup: () =>
      serial(async () => {
        const failures = [];
        for (const read of readers)
          try {
            await closeRead(read);
          } catch (error) {
            failures.push(error);
          }
        for (const write of held.keys())
          try {
            await abort(write);
          } catch (error) {
            failures.push(error);
          }
        if (failures.length) throw new AggregateError(failures, "Owned staging cleanup incomplete");
      }),
    snapshot: () => ({
      records: records.map((r) => r.record),
      verified: verifyIndex,
      held: [...held.entries()],
      readers: [...readers],
    }),
  };
}

export type WorkerExecution = {
  boundary: "worker-execution";
  clock: string;
  threadId: number;
  jobId: string;
  owner: ResourceOwner;
  startedAt: number;
  finishedAt: number;
};
/** Call only with actual worker callback entry/settlement observations, not RPC intervals.
 * Pure validation cannot establish trace provenance; the foundation integration must retain it. */
export function verifyFourExecutions(rows: WorkerExecution[], owners: readonly ResourceOwner[]) {
  assert.equal(owners.length, 2);
  assert.notEqual(
    owners[0]!.sourceKey,
    owners[1]!.sourceKey,
    "Two legitimate source owners required",
  );
  assert.equal(owners[0]!.hostEpoch, owners[1]!.hostEpoch);
  assert.notEqual(owners[0]!.processEpoch, owners[1]!.processEpoch);
  assert.ok(rows.length >= 4);
  const ids = new Set<string>();
  const events = rows
    .flatMap((row) => {
      assert.equal(row.boundary, "worker-execution");
      assert.ok(row.clock.length > 0 && row.clock === rows[0]!.clock);
      assert.ok(
        Number.isSafeInteger(row.threadId) &&
          row.threadId > 0 &&
          row.threadId === rows[0]!.threadId,
      );
      assert.ok(row.jobId.length > 0 && !ids.has(row.jobId));
      ids.add(row.jobId);
      const owner = owners.findIndex((owner) => isDeepStrictEqual(owner, row.owner));
      assert.ok(owner >= 0, "Foreign/stale owner");
      assert.ok(
        Number.isFinite(row.startedAt) &&
          row.startedAt >= 0 &&
          Number.isFinite(row.finishedAt) &&
          row.finishedAt > row.startedAt,
      );
      return [
        { time: row.startedAt, delta: 1, owner },
        { time: row.finishedAt, delta: -1, owner },
      ];
    })
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  const active = [0, 0];
  let peak = 0,
    both = false;
  for (const event of events) {
    active[event.owner]! += event.delta;
    const total = active[0]! + active[1]!;
    assert.ok(total <= 4, "Worker concurrency limit exceeded");
    peak = Math.max(peak, total);
    if (total === 4 && active.every((count) => count > 0)) both = true;
  }
  assert.equal(peak, 4, "Four actually executing jobs were not observed");
  assert.equal(both, true);
  assert.deepEqual(active, [0, 0]);
  return { peak, owners: owners.map((owner) => owner.sourceKey) };
}

export async function collectThirtySamples<T>(
  operation: (index: number, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  now = () => performance.now(),
) {
  const samples = [];
  for (let index = 0; index < PRESSURE.samples; index++) {
    signal.throwIfAborted();
    const startedAt = now();
    const result = await operation(index, signal),
      finishedAt = now();
    signal.throwIfAborted();
    assert.ok(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt);
    samples.push({ index, startedAt, finishedAt, result });
  }
  return samples;
}
/** Integration supplies real device/storage/UI work and observes its own authority fences.
 * No RSS, UI latency or physical-stop result is inferred from this driver. */
export async function driveTenMinutes(
  step: (index: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  clock = {
    now: () => performance.now(),
    wait: (ms: number, signal: AbortSignal) => pause(ms, undefined, { signal }),
  },
) {
  signal.throwIfAborted();
  const startedAt = clock.now();
  let finishedAt = startedAt,
    iterations = 0;
  while (finishedAt - startedAt < PRESSURE.workloadMs) {
    signal.throwIfAborted();
    await step(iterations++, signal);
    signal.throwIfAborted();
    await clock.wait(1000, signal);
    const next = clock.now();
    assert.ok(Number.isFinite(next) && next >= finishedAt);
    finishedAt = next;
  }
  assert.ok(iterations >= PRESSURE.samples, "A stalled operation is not a continuous workload");
  return { startedAt, finishedAt, iterations };
}

// Heterogeneous observed RPC/diagnostic envelopes; never used to implement an endpoint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PressureRow = Record<string, any>;
export function verifyPressureWorkerTrace(rows: PressureRow[], owners: ResourceOwner[]) {
  const requests = new Map<string, PressureRow>(),
    pending = new Map<string, PressureRow>();
  const executions: WorkerExecution[] = [];
  let clock: string | undefined,
    ended = false,
    samples = 0;
  for (const row of rows) {
    if (row.observation) {
      assert.equal(row.observation.faults, 0, "Sticky queue observer fault");
      assert.equal(row.observation.dropped, 0, "Incomplete queue trace");
      assert.equal(row.sinkFaults, 0, "Sticky trace sink fault");
      assert.equal(row.observation.clock.realm, "worker");
      if (row.kind === "stats") {
        assert.ok(row.memory.rss > 0);
        samples++;
      }
      if (row.kind === "end") {
        assert.equal(ended, false);
        ended = true;
        assert.equal(row.observation.restored, true);
        assert.ok(row.observation.queues.length > 0);
        for (const q of row.observation.queues) {
          assert.ok(q.counters);
          assert.equal(q.counters.pending, 0);
          assert.equal(q.counters.bytes, 0);
        }
      }
    }
    if (row.kind === "request") {
      assert.ok(!requests.has(row.key));
      requests.set(row.key, row);
      if (row.owner)
        assert.ok(
          isDeepStrictEqual(row.owner, row.first) || isDeepStrictEqual(row.owner, row.first?.owner),
          "Unproven owner join",
        );
    }
    if (row.kind !== "queue") continue;
    assert.equal(row.clock.realm, "worker");
    assert.ok(row.clock.threadId > 0);
    const domain = JSON.stringify(row.clock);
    clock ??= domain;
    assert.equal(domain, clock);
    for (const event of row.events) {
      assert.ok(event.counters, "Unreadable retained queue accounting");
      assert.ok(event.counters.pending <= 32 && event.counters.active <= 4);
      const request = requests.get(event.requestKey);
      assert.ok(request, "Queue job lacks original request");
      const key = `${event.queueId}:${event.jobId}`;
      if (event.phase === "enter") {
        assert.ok(!pending.has(key));
        pending.set(key, event);
      }
      if (["fulfilled", "rejected", "throw"].includes(event.phase)) {
        const start = pending.get(key);
        assert.ok(start, "Settlement without entry");
        pending.delete(key);
        if (owners.some((owner) => isDeepStrictEqual(owner, request.owner))) {
          assert.equal(event.phase, "fulfilled", "Owned worker operation failed");
          executions.push({
            boundary: "worker-execution",
            clock: domain,
            threadId: row.clock.threadId,
            jobId: key,
            owner: request.owner,
            startedAt: start.at,
            finishedAt: event.at,
          });
        }
      }
    }
  }
  assert.ok(ended && samples >= 30, "Missing worker close/stats");
  assert.equal(pending.size, 0);
  return { ...verifyFourExecutions(executions, owners), executions, samples };
}

/** Join all owners before propagating failure, so cleanup cannot overlap a command. */
export async function settlePressure<T>(work: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(work);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length === 1) throw failures[0]!.reason;
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      "Pressure operations failed",
    );
  return results.map((r) => {
    assert.equal(r.status, "fulfilled");
    if (r.status !== "fulfilled") throw new Error("Unreachable rejection");
    return r.value;
  });
}

/** Failure cleanup never publishes; preserve the original failure even if cleanup fails. */
export async function guardPressure<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<unknown>,
): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], "Pressure failed; cleanup also failed", {
        cause,
      });
    }
    throw cause;
  }
}

export async function pressureStep(both: (name: string) => Promise<PressureRow[]>, burst: boolean) {
  if (burst) await both("burst");
  const committed = await both("replace");
  const flushed = await both("flush");
  const restaged = await both("stage");
  const staging = await both("staging");
  const inventory = await both("inventory");
  const phases = { settledFlush: flushed, restoredStaging: restaged };
  assertPressurePhases(phases);
  return { committed, flushed, staging, inventory, phases };
}

/** Receipts prove a settled flush interval, not constant 416 MiB staging pressure. */
export function assertPressurePhases(phases: PressureRow) {
  const { settledFlush, restoredStaging } = phases;
  for (const pair of [settledFlush, restoredStaging]) {
    assert.equal(pair.length, 2);
    assert.equal(new Set(pair.map((r: PressureRow) => r.pluginId)).size, 2);
    for (const row of pair) {
      assert.equal(row.commandInterval.realm, "main");
      assert.ok(Number.isFinite(row.commandInterval.startedAt));
      assert.ok(row.commandInterval.finishedAt >= row.commandInterval.startedAt);
      assert.equal(row.snapshot.recordCount, PRESSURE.perSource);
      assert.equal(row.snapshot.readers.length, 0);
    }
  }
  assert.deepEqual(
    settledFlush.map((r: PressureRow) => r.pluginId).sort(),
    restoredStaging.map((r: PressureRow) => r.pluginId).sort(),
  );
  for (const row of settledFlush) {
    assert.equal(row.command, "flush");
    assert.deepEqual(row.snapshot.held, []);
  }
  for (const row of restoredStaging) {
    assert.equal(row.command, "stage");
    assert.equal(row.result.byteLength, PRESSURE.recordBytes);
    assert.equal(row.snapshot.held.length, 1);
    assert.equal(row.snapshot.held[0][1].state, "sealed");
  }
  assert.ok(
    Math.max(...settledFlush.map((r: PressureRow) => r.commandInterval.finishedAt)) <=
      Math.min(...restoredStaging.map((r: PressureRow) => r.commandInterval.startedAt)),
    "Restaging must follow both settled flushes",
  );
}

export function assertPressurePartial(p: PressureRow) {
  assert.equal(p.status, "partial-memory-unavailable");
  assert.equal(p.fullPass, false);
  assert.deepEqual(p.unavailableMemory, ["mainAdditionalRSS32MiB", "workerAdditionalRSS64MiB"]);
  assert.ok(p.finishedAt - p.startedAt >= PRESSURE.workloadMs);
  assert.ok(p.steps.length >= 30);
  assert.equal(p.owners.length, 2);
  assert.equal(p.seeded.length, 50);
  assert.equal(p.verified.length, 50);
  assert.equal(new Set(p.seeded.map((r: PressureRow) => r.id)).size, 50);
  assert.equal(new Set(p.verified.map((r: PressureRow) => r.id)).size, 50);
  for (const record of p.seeded) {
    assert.equal(record.byteLength, PRESSURE.recordBytes);
    assert.equal(record.sha256, pressureHash(record.label));
    const read = p.verified.find((r: PressureRow) => r.id === record.id);
    assert.ok(read);
    assert.equal(read.sha256, record.sha256);
    assert.equal(read.byteLength, record.byteLength);
  }
  for (const key of ["inventory", "flush", "commit"]) {
    assert.equal(p.samples[key].length, 30, key);
    for (const pair of p.samples[key])
      for (const sample of pair) {
        assert.equal(sample.commandInterval.realm, "main");
        assert.ok(sample.commandInterval.finishedAt >= sample.commandInterval.startedAt);
      }
  }
  assert.equal(p.ui.fullCounters.main[0].counters.bindings, 32);
  assert.equal(p.ui.fullCounters.main[1].counters.owners, 8);
  assert.ok(p.ui.durationMs >= PRESSURE.workloadMs);
  assert.ok(
    p.ui.final.every((row: PressureRow) => Object.values(row.counters).every((v) => v === 0)),
  );
  assert.equal(p.transport.faults.length, 0);
  assert.equal(p.transport.readers, 0);
  assert.equal(p.transport.pending, 0);
  assert.ok(p.transport.verifiedReads >= 50);
  assert.equal(p.transport.exits.length, 2);
  assert.ok(
    p.steps.every(
      (step: PressureRow) =>
        step.provider.ok === true &&
        step.staging.length === 2 &&
        step.staging.every(
          (source: PressureRow[]) =>
            source.length === 1 &&
            source[0]!.state === "sealed" &&
            source[0]!.receivedBytes === PRESSURE.recordBytes,
        ) &&
        step.ui.main[0].counters.bindings === 32 &&
        step.ui.main[1].counters.owners === 10,
    ),
  );
  for (const step of p.steps) assertPressurePhases(step.phases);
  assert.equal(p.worker.peak, 4);
  verifyFourExecutions(p.worker.executions, p.owners);
  assert.equal(p.mainObserver.faults, 0);
  assert.equal(p.mainObserver.dropped, 0);
  assert.ok(p.mainObserver.queues.every((q: PressureRow) => q.counters?.pending === 0));
}

/** Observe the original process channels, including nested BusinessResult values. */
export function pressureTransport(write: (row: unknown) => void) {
  const faults: string[] = [],
    outputs: PressureRow[] = [],
    owners: ResourceOwner[] = [],
    exits: PressureRow[] = [];
  let pendingCount = 0,
    readerCount = 0,
    verifiedReads = 0;
  const guard = (work: () => void) => {
    try {
      work();
    } catch (e) {
      if (faults.length < 8) faults.push(String(e));
    }
  };
  return {
    outputs,
    owners,
    output(owner: ResourceOwner, line: string) {
      if (!line.startsWith("PERSISTENCE_PRESSURE:")) return;
      guard(() => {
        const data = JSON.parse(line.slice("PERSISTENCE_PRESSURE:".length));
        assert.equal(data.pluginId, owner.pluginId);
        assert.ok(outputs.length < 10000, "Bounded pressure output trace");
        const row = { ...data, owner: structuredClone(owner), at: performance.now() };
        outputs.push(row);
        write({ kind: "consumer-output", ...row });
      });
    },
    attach(owner: ResourceOwner, child: PluginProcess) {
      owners.push(structuredClone(owner));
      assert.ok(owners.length <= 2);
      const pending = new Map<string, PressureRow>();
      const reads = new Map<
        string,
        { offset: number; hash: ReturnType<typeof createHash>; record: RecordMeta; done: boolean }
      >();
      const observe = (direction: string, text: string) =>
        guard(() => {
          const message = JSON.parse(text),
            row: PressureRow = { kind: "rpc", owner, direction, at: performance.now(), message };
          if (direction === "plugin" && message.method?.startsWith("storage/")) {
            assert.ok(pending.size < 32);
            pending.set(String(message.id), message);
            pendingCount++;
            if (message.params?.data)
              row.message = {
                ...message,
                params: {
                  ...message.params,
                  data: undefined,
                  dataBytes: Buffer.byteLength(message.params.data, "base64"),
                  dataSha256: createHash("sha256")
                    .update(Buffer.from(message.params.data, "base64"))
                    .digest("hex"),
                },
              };
          }
          if (direction === "host" && pending.has(String(message.id))) {
            const request = pending.get(String(message.id))!;
            pending.delete(String(message.id));
            pendingCount--;
            row.method = request.method;
            row.requestId = request.id;
            assert.equal(message.result?.ok, true, JSON.stringify(message));
            const result = message.result.value;
            if (request.method === "storage/openRead") {
              assert.equal(result.record.byteLength, PRESSURE.recordBytes);
              assert.equal(result.record.sha256, pressureHash(result.record.label));
              reads.set(result.read, {
                offset: 0,
                hash: createHash("sha256"),
                record: result.record,
                done: false,
              });
              readerCount++;
            }
            if (request.method === "storage/readChunk") {
              const read = reads.get(request.params.read);
              assert.ok(read);
              const size = Buffer.byteLength(result.data, "base64");
              assert.ok(size > 0 && size <= request.params.maxBytes && size <= PRESSURE.chunkBytes);
              const bytes = Buffer.from(result.data, "base64");
              assert.equal(request.params.offset, read.offset);
              assert.equal(result.offset, read.offset);
              assert.equal(result.nextOffset, read.offset + size);
              assert.deepEqual(bytes, pressureSlice(read.record.label, read.offset, size));
              read.hash.update(bytes);
              read.offset += size;
              assert.equal(result.eof, read.offset === PRESSURE.recordBytes);
              if (result.eof) {
                assert.equal(read.hash.digest("hex"), read.record.sha256);
                read.done = true;
                verifiedReads++;
              }
              row.message = {
                ...message,
                result: {
                  ...message.result,
                  value: {
                    ...result,
                    data: undefined,
                    dataBytes: size,
                    dataSha256: createHash("sha256").update(bytes).digest("hex"),
                  },
                },
              };
            }
            if (request.method === "storage/closeRead") {
              const read = reads.get(request.params.read);
              assert.ok(read?.done);
              reads.delete(request.params.read);
              readerCount--;
            }
          }
          write(row);
        });
      const off = child.onMessage((text) => observe("plugin", text));
      child.onExit((exit) => {
        exits.push({ owner, exit, at: performance.now() });
        off();
      });
      return {
        ...child,
        send(text: string) {
          observe("host", text);
          child.send(text);
        },
      };
    },
    snapshot: () => ({
      faults: [...faults],
      pending: pendingCount,
      readers: readerCount,
      verifiedReads,
      exits: [...exits],
    }),
  };
}

/** Outside verifier replays hashes of observed nested RPC payloads, not consumer claims. */
export function verifyPressureRpcTrace(rows: PressureRow[], owners: ResourceOwner[]) {
  const pending = new Map<string, PressureRow>();
  const reads = new Map<
    string,
    { record: RecordMeta; offset: number; hash: ReturnType<typeof createHash> }
  >();
  let verifiedReads = 0;
  const records = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "rpc") continue;
    assert.ok(
      owners.some((owner) => isDeepStrictEqual(owner, row.owner)),
      "Foreign transport owner",
    );
    const message = row.message,
      key = `${row.owner.processEpoch}:${message.id}`;
    if (row.direction === "plugin" && message.method?.startsWith("storage/")) {
      assert.ok(!pending.has(key));
      pending.set(key, message);
      continue;
    }
    if (row.direction !== "host" || !pending.has(key)) continue;
    const request = pending.get(key)!;
    pending.delete(key);
    assert.equal(message.result?.ok, true);
    const result = message.result.value;
    const readKey = `${row.owner.processEpoch}:${request.params?.read}`;
    if (request.method === "storage/openRead") {
      assert.equal(result.record.byteLength, PRESSURE.recordBytes);
      assert.equal(result.record.id, request.params.id);
      assert.equal(result.record.revision, request.params.expectedRevision);
      reads.set(`${row.owner.processEpoch}:${result.read}`, {
        record: result.record,
        offset: 0,
        hash: createHash("sha256"),
      });
    }
    if (request.method === "storage/readChunk") {
      const read = reads.get(readKey);
      assert.ok(read);
      const size = result.dataBytes;
      assert.ok(
        Number.isSafeInteger(size) &&
          size > 0 &&
          size <= PRESSURE.chunkBytes &&
          size <= request.params.maxBytes,
      );
      assert.equal(request.params.offset, read.offset);
      assert.equal(result.offset, read.offset);
      const expected = pressureSlice(read.record.label, read.offset, size);
      assert.equal(result.dataSha256, createHash("sha256").update(expected).digest("hex"));
      read.hash.update(expected);
      read.offset += size;
      assert.equal(result.nextOffset, read.offset);
      assert.equal(result.eof, read.offset === PRESSURE.recordBytes);
    }
    if (request.method === "storage/closeRead") {
      const read = reads.get(readKey);
      assert.ok(read);
      assert.equal(read.offset, PRESSURE.recordBytes);
      assert.equal(read.hash.digest("hex"), read.record.sha256);
      reads.delete(readKey);
      verifiedReads++;
      records.add(read.record.id);
    }
  }
  assert.equal(pending.size, 0);
  assert.equal(reads.size, 0);
  assert.ok(verifiedReads >= 50);
  assert.equal(records.size, 50, "Original 50 distinct record payloads required");
  return { verifiedReads, records: [...records].sort() };
}
