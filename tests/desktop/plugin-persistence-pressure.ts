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
        const expected = records[verifyIndex]!;
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
          verifyIndex++;
          return {
            id: expected.record.id,
            revision: expected.record.revision,
            byteLength: offset,
            sha256: digest,
          };
        } finally {
          await closeRead(opened.read);
        }
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
