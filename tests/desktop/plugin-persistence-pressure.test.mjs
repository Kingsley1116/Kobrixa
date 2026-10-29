import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  PRESSURE,
  pressureStep,
  guardPressure,
  settlePressure,
  assertPressurePhases,
  pressureChunk,
  pressureSlice,
  pressureHash,
  createPressureWorkload,
  collectThirtySamples,
  driveTenMinutes,
  verifyFourExecutions,
  verifyPressureWorkerTrace,
  pressureTransport,
  verifyPressureRpcTrace,
} from "./plugin-persistence-pressure.ts";
const signal = () => new AbortController().signal;
// Unit-only SDK-shaped store. Never a native receipt or claimed transport measurement.
function expectedRange(seed, offset, length) {
  const result = Buffer.alloc(length);
  let copied = 0;
  while (copied < length) {
    const absolute = offset + copied,
      base = Math.floor(absolute / PRESSURE.chunkBytes) * PRESSURE.chunkBytes;
    const chunk = Buffer.alloc(PRESSURE.chunkBytes).fill(
        createHash("sha256").update(`${seed}:${base}`).digest(),
      ),
      within = absolute - base;
    const count = Math.min(length - copied, chunk.length - within);
    chunk.copy(result, copied, within, within + count);
    copied += count;
  }
  return result;
}
function storageFixture(options = {}) {
  const records = new Map(),
    writes = new Map(),
    reads = new Map();
  let revision = 0,
    closed = 0;
  const ok = (value) => ({ ok: true, value });
  const storage = {
    async beginWrite(input) {
      const write = randomUUID(),
        id = input.target.mode === "create" ? randomUUID() : input.target.id;
      writes.set(write, { id, input, bytes: 0, hash: createHash("sha256"), state: "receiving" });
      options.onBegin?.();
      return ok({ write, id, expiresAt: Date.now() + 120000 });
    },
    async writeChunk({ write, offset, data }) {
      if (options.failWrite) throw Error("write-failed");
      const w = writes.get(write);
      assert.equal(offset, w.bytes);
      const bytes = Buffer.from(data, "base64");
      assert.equal(bytes.length, PRESSURE.chunkBytes);
      w.hash.update(bytes);
      w.bytes += bytes.length;
      return ok({ receivedBytes: w.bytes, expiresAt: Date.now() + 120000 });
    },
    async sealWrite({ write }) {
      const w = writes.get(write);
      assert.equal(w.bytes, PRESSURE.recordBytes);
      assert.equal(w.hash.digest("hex"), w.input.sha256);
      w.state = "sealed";
      return storage.writeStatus({ write });
    },
    async commitWrite({ write }) {
      const w = writes.get(write);
      const record = {
        id: w.id,
        revision: `r_${String(++revision).padStart(32, "0")}`,
        kind: w.input.kind,
        schemaVersion: 1,
        label: w.input.label,
        mediaType: w.input.mediaType,
        byteLength: w.bytes,
        sha256: w.input.sha256,
        createdAt: 1,
        updatedAt: revision,
        checkpoint: "none",
        interrupted: false,
      };
      records.set(record.id, record);
      writes.delete(write);
      return ok({
        record,
        receipt: {
          revision: record.revision,
          commitId: randomUUID(),
          durability: "file-and-directory-sync",
        },
      });
    },
    async abortWrite({ write }) {
      if (options.unknownAbort) return ok({ disposition: "unknown" });
      writes.delete(write);
      return ok({ disposition: "aborted" });
    },
    async writeStatus({ write }) {
      const w = writes.get(write);
      return ok({
        write,
        id: w.id,
        state: options.expired ? "expired" : w.state,
        receivedBytes: w.bytes,
        expiresAt: Date.now() + 120000,
      });
    },
    async list({ cursor, limit }) {
      const offset = cursor ? Number(cursor) : 0,
        all = [...records.values()];
      return ok({
        entries: all.slice(offset, offset + limit),
        ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
      });
    },
    async openRead({ id, expectedRevision }) {
      const record = records.get(id);
      assert.equal(record.revision, expectedRevision);
      const read = randomUUID();
      reads.set(read, record);
      return ok({ read, record, expiresAt: Date.now() + 120000 });
    },
    async readChunk({ read, offset, maxBytes }) {
      assert.equal(maxBytes, Math.min(PRESSURE.chunkBytes, PRESSURE.recordBytes - offset));
      const size = options.readSizes
        ? options.readSizes[(options.readCalls ?? 0) % options.readSizes.length]
        : maxBytes;
      options.readCalls = (options.readCalls ?? 0) + 1;
      const record = reads.get(read),
        bytes = expectedRange(record.label, offset, Math.min(size, maxBytes));
      if (
        offset % PRESSURE.chunkBytes &&
        (offset % PRESSURE.chunkBytes) + bytes.length > PRESSURE.chunkBytes
      )
        options.crossedBoundary = true;
      if (options.corrupt) bytes[0] ^= 1;
      return ok({
        offset,
        data: bytes.toString("base64"),
        nextOffset: offset + bytes.length,
        eof: offset + bytes.length === PRESSURE.recordBytes,
      });
    },
    async closeRead({ read }) {
      if (options.failClose) throw Error("close-failed");
      reads.delete(read);
      closed++;
      return ok({});
    },
    async flush() {
      if (writes.size)
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_STORAGE_CONFLICT",
            detail: { kind: "persistence", reason: "flush-incomplete" },
          },
        };
      return ok({ barrier: randomUUID(), durability: "file-and-directory-sync" });
    },
    async quota() {
      return ok({
        recordCount: records.size,
        committedBytes: records.size * PRESSURE.recordBytes,
        reservedCreates: writes.size,
        reservedBytes: writes.size * PRESSURE.recordBytes,
      });
    },
  };
  return {
    storage,
    records,
    writes,
    reads,
    options,
    get closed() {
      return closed;
    },
  };
}
test("exact payload size and independent chunk/hash oracle", () => {
  const bytes = pressureChunk("known", 0),
    pattern = createHash("sha256").update("known:0").digest();
  assert.equal(bytes.length, 262144);
  assert.deepEqual(bytes.subarray(0, 32), pattern);
  assert.deepEqual(bytes.subarray(-32), pattern);
  assert.notEqual(pressureHash("a"), pressureHash("b"));
  assert.throws(() => pressureChunk("a", 1));
});
test("50 full-size durable unit records, full readback, two maximum staging and raw BusinessResult observations", async () => {
  const fixtures = [storageFixture(), storageFixture()],
    events = [];
  const workloads = fixtures.map((f, i) =>
    createPressureWorkload(f.storage, `source-${i}`, (e) => events.push(e)),
  );
  for (const w of workloads) {
    for (let i = 0; i < 25; i++) await w.seedOne(signal());
    assert.equal((await w.inventory(signal())).length, 25);
    for (let i = 0; i < 25; i++) assert.equal((await w.verifyOne(signal())).byteLength, 8388608);
    await w.stageOne(signal());
    assert.equal((await w.stagingStatus(signal()))[0].receivedBytes, 8388608);
  }
  let active = 0,
    peak = 0;
  for (const f of fixtures) {
    const read = f.storage.readChunk;
    f.storage.readChunk = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await read(...args);
      } finally {
        active--;
      }
    };
  }
  const bursts = await Promise.all(workloads.map((w) => w.burst(signal())));
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.ok(bursts.every((b) => b.length === 2 && b.every((r) => r.byteLength === 8388608)));
  fixtures[0].options.corrupt = true;
  await assert.rejects(workloads[0].burst(signal()), /Parallel read/);
  assert.equal(fixtures[0].reads.size, 0);
  assert.equal(active, 0);
  fixtures[0].options.corrupt = false;
  assert.equal(
    fixtures.reduce((n, f) => n + f.records.size, 0),
    50,
  );
  assert.equal(
    fixtures.reduce((n, f) => n + f.writes.size, 0),
    2,
  );
  assert.ok(
    events
      .filter((e) => e.operation === "commit")
      .every((e) => e.result.ok && e.result.value.record && e.result.value.receipt),
  );
  assert.ok(
    events
      .filter((e) => e.operation === "list")
      .every((e) => e.result.ok && Array.isArray(e.result.value.entries)),
  );
  await assert.rejects(workloads[0].flush(signal()), /flush-incomplete/);
  assert.equal(fixtures[0].writes.size, 1, "Rejected flush retains the sealed write");
  const order = [];
  const both = async (name) => {
    order.push(name);
    return settlePressure(
      workloads.map(async (w, i) => {
        const startedAt = performance.now();
        const fn = {
          replace: w.replaceOne,
          flush: w.flush,
          stage: w.stageOne,
          staging: w.stagingStatus,
          inventory: w.inventory,
        }[name];
        const result = await fn(signal());
        const snapshot = w.snapshot();
        return {
          pluginId: `source-${i}`,
          command: name,
          result,
          snapshot: {
            recordCount: snapshot.records.length,
            held: snapshot.held,
            readers: snapshot.readers,
          },
          commandInterval: { realm: "main", startedAt, finishedAt: performance.now() },
        };
      }),
    );
  };
  const step = await pressureStep(both, false);
  assert.deepEqual(order, ["replace", "flush", "stage", "staging", "inventory"]);
  assert.equal(
    fixtures.reduce((n, f) => n + f.records.size, 0),
    50,
  );
  assert.equal(
    fixtures.reduce((n, f) => n + f.writes.size, 0),
    2,
  );
  const bad = structuredClone(step.phases);
  bad.restoredStaging[0].commandInterval.startedAt = 0;
  assert.throws(() => assertPressurePhases(bad), /Restaging/);
  const held = structuredClone(step.phases);
  held.settledFlush[0].snapshot.held = step.phases.restoredStaging[0].snapshot.held;
  assert.throws(() => assertPressurePhases(held));
  const before = workloads[0].snapshot().records[1];
  await workloads[0].replaceOne(signal());
  assert.notEqual(workloads[0].snapshot().records[1].revision, before.revision);
  assert.equal(
    fixtures.reduce((n, f) => n + f.writes.size, 0),
    1,
    "Commit consumes staging instead of allocating an extra maximum stage",
  );
  assert.equal(
    fixtures.reduce((n, f) => n + f.records.size, 0),
    50,
  );
  await workloads[0].stageOne(signal());
  fixtures[0].options.expired = true;
  await assert.rejects(workloads[0].stagingStatus(signal()), /Expired staging/);
  for (const w of workloads) await w.cleanup();
  assert.ok(fixtures.every((f) => f.writes.size === 0 && f.reads.size === 0));
});
test("corrupt nested data fails and failed close remains owned for cleanup", async () => {
  const f = storageFixture({ corrupt: true, failClose: true }),
    w = createPressureWorkload(f.storage, "corrupt", () => {});
  for (let i = 0; i < 25; i++) await w.seedOne(signal());
  await assert.rejects(w.verifyOne(signal()), /close-failed/);
  assert.equal(w.snapshot().verified, 0);
  assert.equal(w.snapshot().readers.length, 1);
  f.options.failClose = false;
  await w.cleanup();
  assert.equal(f.reads.size, 0);
  await assert.rejects(w.verifyOne(signal()), /Readback differs/);
  assert.equal(f.reads.size, 0);
});
test("cancel after successful begin cleans the returned handle without using cancelled signal", async () => {
  const control = new AbortController(),
    f = storageFixture({ onBegin: () => control.abort() }),
    w = createPressureWorkload(f.storage, "cancel", () => {});
  await assert.rejects(w.seedOne(control.signal));
  assert.equal(f.writes.size, 0);
  assert.equal(w.snapshot().held.length, 0);
});
test("unknown abort keeps handle retained; later explicit cleanup can reconcile", async () => {
  const f = storageFixture({ failWrite: true, unknownAbort: true }),
    w = createPressureWorkload(f.storage, "unknown", () => {});
  await assert.rejects(w.seedOne(signal()), /cleanup unresolved/);
  assert.equal(w.snapshot().held.length, 1);
  await assert.rejects(w.cleanup(), /incomplete/);
  f.options.unknownAbort = false;
  await w.cleanup();
  assert.equal(w.snapshot().held.length, 0);
});
test("single-flight rejects overlapping commands", async () => {
  let release;
  const pending = new Promise((r) => (release = r)),
    f = storageFixture();
  f.storage.beginWrite = async () => {
    await pending;
    throw Error("stop");
  };
  const w = createPressureWorkload(f.storage, "single", () => {});
  const first = w.seedOne(signal());
  await assert.rejects(w.seedOne(signal()), /Overlapping/);
  release();
  await assert.rejects(first, /stop/);
});
const owners = [0, 1].map((i) => ({
  sourceKey: `dev:source-${i}`,
  pluginId: `acceptance.pressure-${i}`,
  generation: 1,
  hostEpoch: "host",
  processEpoch: `process-${i}`,
}));
const executions = () =>
  [0, 1, 2, 3].map((i) => ({
    boundary: "worker-execution",
    clock: "original-worker-monotonic",
    threadId: 1,
    jobId: String(i),
    owner: owners[i % 2],
    startedAt: i,
    finishedAt: 10 + i,
  }));
test("requires actual overlap from two original source owners", () =>
  assert.equal(verifyFourExecutions(executions(), owners).peak, 4));
for (const [name, mutate] of Object.entries({
  pending: (r) => (r[0].boundary = "pending"),
  serial: (r) =>
    r.forEach((x, i) => {
      x.startedAt = i * 2;
      x.finishedAt = i * 2 + 1;
    }),
  foreign: (r) => (r[0].owner = { ...owners[0], processEpoch: "stale" }),
  clock: (r) => (r[0].clock = "other"),
  duplicate: (r) => (r[1].jobId = r[0].jobId),
  overflow: (r) => r.push({ ...r[0], jobId: "extra" }),
  oneSource: (r) => r.forEach((x) => (x.owner = owners[0])),
}))
  test(`execution trace rejects ${name}`, () => {
    const r = executions();
    mutate(r);
    assert.throws(() => verifyFourExecutions(r, owners));
  });
test("thirty real callback samples retain results; cancellation stops further work", async () => {
  let clock = 0;
  const rows = await collectThirtySamples(
    async (i) => ({ ok: true, value: { i } }),
    signal(),
    () => clock++,
  );
  assert.equal(rows.length, 30);
  assert.equal(rows[29].result.value.i, 29);
  const c = new AbortController();
  let calls = 0;
  await assert.rejects(
    collectThirtySamples(async () => {
      calls++;
      c.abort();
    }, c.signal),
  );
  assert.equal(calls, 1);
});
test("ten-minute driver uses completed work and elapsed clock; no memory claim", async () => {
  let now = 0,
    calls = 0;
  const result = await driveTenMinutes(
    async () => {
      calls++;
    },
    signal(),
    {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(result.finishedAt - result.startedAt, 600000);
  assert.equal(calls, 600);
  assert.deepEqual(Object.keys(result).sort(), ["finishedAt", "iterations", "startedAt"]);
  now = 0;
  await assert.rejects(
    driveTenMinutes(
      async () => {
        now = 600000;
      },
      signal(),
      { now: () => now, wait: async () => {} },
    ),
    /stalled/,
  );
});

test("inventory bounds empty continuation pages", async () => {
  const f = storageFixture();
  let page = 0;
  f.storage.list = async () => ({ ok: true, value: { entries: [], nextCursor: String(++page) } });
  const w = createPressureWorkload(f.storage, "pagination", () => {});
  await assert.rejects(w.inventory(signal()), /pagination bound/);
  assert.equal(page, 33);
});

test("expected slices preserve pattern phases across chunk boundaries with bounded buffers", () => {
  for (const [offset, length] of [
    [17, 97],
    [262144 - 17, 262144],
    [262144 - 1, 2],
    [8388608 - 31, 31],
  ]) {
    const bytes = pressureSlice("cross", offset, length);
    assert.equal(bytes.length, length);
    assert.deepEqual(bytes, expectedRange("cross", offset, length));
  }
  assert.throws(() => pressureSlice("cross", 0, 262145));
  assert.throws(() => pressureSlice("cross", 8388607, 2));
});
test("short positive reads cross pattern boundaries and verify full record bytes/SHA", async () => {
  const f = storageFixture({ readSizes: [131071, 262144, 17, 65537] });
  const w = createPressureWorkload(f.storage, "short", () => {});
  for (let i = 0; i < 25; i++) await w.seedOne(signal());
  const original = f.storage.readChunk;
  for (const mutate of [
    (result) => {
      result.value.data = "";
      result.value.nextOffset = result.value.offset;
    },
    (result) => {
      result.value.nextOffset++;
    },
    (result) => {
      result.value.offset++;
    },
    (result) => {
      result.value.eof = true;
    },
    (result) => {
      result.value.data = Buffer.alloc(262145).toString("base64");
    },
  ]) {
    f.storage.readChunk = async (params) => {
      const result = await original(params);
      mutate(result);
      return result;
    };
    await assert.rejects(w.verifyOne(signal()));
    assert.equal(w.snapshot().verified, 0);
    assert.equal(f.reads.size, 0);
  }
  f.storage.readChunk = original;
  const verified = await w.verifyOne(signal());
  assert.equal(verified.byteLength, 8388608);
  assert.equal(verified.sha256, pressureHash("short:0:initial"));
  assert.ok(f.options.readCalls > 32);
  assert.equal(f.options.crossedBoundary, true);
  assert.equal(f.reads.size, 0);
});

function workerTrace() {
  const clock = { realm: "worker", pid: 10, threadId: 1, timeOrigin: 1000 };
  const counters = { pending: 0, bytes: 0, active: 0 };
  const observation = { clock, faults: 0, dropped: 0, restored: true, queues: [{ counters }] };
  const rows = Array.from({ length: 4 }, (_, i) => ({
    kind: "request",
    key: `r${i}`,
    id: i,
    operation: "reads.read",
    owner: owners[i % 2],
    first: owners[i % 2],
  }));
  rows.push({
    kind: "queue",
    clock,
    events: [
      ...Array.from({ length: 4 }, (_, i) => ({
        phase: "enter",
        queueId: 1,
        jobId: i,
        requestKey: `r${i}`,
        at: i + 1,
        counters: { ...counters, pending: 4, active: 4 },
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        phase: "fulfilled",
        queueId: 1,
        jobId: i,
        requestKey: `r${i}`,
        at: 10 + i,
        counters,
      })),
    ],
  });
  rows.push(
    ...Array.from({ length: 30 }, () => ({
      kind: "stats",
      observation,
      memory: { rss: 1024 },
      sinkFaults: 0,
    })),
    { kind: "end", observation, sinkFaults: 0 },
  );
  return rows;
}
test("worker correlation requires exact original owner, complete entries, sticky health and close", () => {
  assert.equal(verifyPressureWorkerTrace(workerTrace(), owners).peak, 4);
  for (const corrupt of [
    (r) => {
      r[0].first = { ...r[0].first, processEpoch: "other" };
    },
    (r) => {
      r[4].events[0].requestKey = "missing";
    },
    (r) => {
      r[5].observation.faults = 1;
    },
    (r) => {
      r[5].observation.dropped = 1;
    },
    (r) => {
      r[5].sinkFaults = 1;
    },
    (r) => {
      r.pop();
    },
    (r) => {
      r[4].events[4].phase = "rejected";
    },
    (r) => {
      r[4].events[0].counters = null;
    },
  ]) {
    const rows = structuredClone(workerTrace());
    corrupt(rows);
    assert.throws(() => verifyPressureWorkerTrace(rows, owners));
  }
});
test("transport observer preserves original nested business replies and fails sticky on flattening", () => {
  const raw = [],
    sent = [];
  let receive;
  const child = {
    onMessage(fn) {
      receive = fn;
      return () => {};
    },
    onExit() {
      return () => {};
    },
    send(text) {
      sent.push(text);
    },
  };
  const p = pressureTransport((row) => raw.push(row));
  const observed = p.attach(owners[0], child);
  receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "storage/list", params: {} }));
  const reply = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true, value: { entries: [] } },
  });
  observed.send(reply);
  assert.equal(sent[0], reply);
  assert.deepEqual(raw[1].message.result, { ok: true, value: { entries: [] } });
  assert.equal(p.snapshot().faults.length, 0);
  receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "storage/list", params: {} }));
  observed.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { entries: [] } }));
  assert.equal(sent.length, 2);
  assert.equal(p.snapshot().faults.length, 1);
});

test("outside nested RPC verifier proves all50 distinct complete hashes and rejects payload or owner substitution", () => {
  const rows = [],
    seed = "outside-unit-only",
    sha256 = pressureHash(seed);
  const chunks = Array.from({ length: 32 }, (_, i) => ({
    offset: i * 262144,
    nextOffset: (i + 1) * 262144,
    eof: i === 31,
    dataBytes: 262144,
    dataSha256: createHash("sha256")
      .update(pressureChunk(seed, i * 262144))
      .digest("hex"),
  }));
  let sequence = 0;
  const exchange = (owner, method, params, value) => {
    const id = ++sequence;
    rows.push(
      { kind: "rpc", direction: "plugin", owner, message: { jsonrpc: "2.0", id, method, params } },
      {
        kind: "rpc",
        direction: "host",
        owner,
        message: { jsonrpc: "2.0", id, result: { ok: true, value } },
      },
    );
  };
  for (let i = 0; i < 50; i++) {
    const owner = owners[i % 2],
      id = `unit-record-${i}`,
      read = `unit-read-${i}`;
    exchange(
      owner,
      "storage/openRead",
      { id, expectedRevision: "revision" },
      { read, record: { id, revision: "revision", label: seed, byteLength: 8388608, sha256 } },
    );
    for (const chunk of chunks)
      exchange(owner, "storage/readChunk", { read, offset: chunk.offset, maxBytes: 262144 }, chunk);
    exchange(owner, "storage/closeRead", { read }, {});
  }
  assert.equal(verifyPressureRpcTrace(rows, owners).records.length, 50);
  const wrong = structuredClone(rows);
  wrong[3].message.result.value.dataSha256 = "0".repeat(64);
  assert.throws(() => verifyPressureRpcTrace(wrong, owners));
  assert.throws(
    () =>
      verifyPressureRpcTrace(
        [{ ...rows[0], owner: { ...owners[0], processEpoch: "retired" } }],
        owners,
      ),
    /Foreign/,
  );
  assert.throws(() => verifyPressureRpcTrace(rows.slice(0, -1), owners));
});

test("failed pressure step joins both owners and cleans both without masking the business cause", async () => {
  const cause = new Error("PLUGIN_E_STORAGE_CONFLICT: flush-incomplete");
  const cleanupFailure = new Error("unknown cleanup disposition");
  for (const failCleanup of [false, true]) {
    const calls = [];
    let secondSettled = false;
    const both = (name) =>
      settlePressure(
        [0, 1].map(async (owner) => {
          calls.push(`${name}:${owner}`);
          if (name === "flush") {
            if (owner === 0) throw cause;
            await new Promise((resolve) => setImmediate(resolve));
            secondSettled = true;
          }
          if (name === "cleanup") {
            assert.equal(secondSettled, true);
            if (owner === 0 && failCleanup) throw cleanupFailure;
          }
          return {};
        }),
      );
    await assert.rejects(
      guardPressure(
        () => pressureStep(both, false),
        () => both("cleanup"),
      ),
      (error) => {
        if (!failCleanup) assert.equal(error, cause);
        else {
          assert.equal(error.cause, cause);
          assert.deepEqual(error.errors, [cause, cleanupFailure]);
        }
        return true;
      },
    );
    assert.deepEqual(calls, [
      "replace:0",
      "replace:1",
      "flush:0",
      "flush:1",
      "cleanup:0",
      "cleanup:1",
    ]);
  }
});
