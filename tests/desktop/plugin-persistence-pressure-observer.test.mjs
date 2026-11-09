import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { WorkQueue } from "../../apps/desktop/src/main/plugins/persistence/quota.ts";
import {
  observeWorkQueue,
  attachPressureWorkerTrace,
} from "./plugin-persistence-pressure-observer.ts";

const deferred = () => Promise.withResolvers();
function fixture(t, limit) {
  const original = Object.getOwnPropertyDescriptor(WorkQueue.prototype, "run");
  const observer = observeWorkQueue(WorkQueue, limit);
  t.after(() => {
    observer.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(WorkQueue.prototype, "run"), original);
  });
  return observer;
}
test("real four callback entries, fifth queued, explicit request join and retained accounting", async (t) => {
  const observer = fixture(t),
    queue = new WorkQueue(() => 0);
  const gates = Array.from({ length: 5 }, deferred),
    entered = [];
  const promises = gates.map((gate, i) =>
    observer.withRequest(`raw-request:${i}`, () =>
      queue.run(i % 2 ? "source-b" : "source-a", 100, 10, function () {
        assert.equal(this.source, i % 2 ? "source-b" : "source-a");
        entered.push(observer.currentExecution());
        return gate.promise;
      }),
    ),
  );
  assert.equal(entered.length, 4);
  assert.equal(observer.currentExecution(), null);
  assert.deepEqual(observer.snapshot().queues[0].counters, {
    pending: 5,
    active: 4,
    bytes: 500,
    queued: 1,
    sourceBytes: [
      ["source-a", 300],
      ["source-b", 200],
    ],
    sourceCount: [
      ["source-a", 3],
      ["source-b", 2],
    ],
  });
  gates[0].resolve(0);
  await tick();
  assert.equal(entered.length, 5);
  gates.forEach((g, i) => g.resolve(i));
  assert.deepEqual(await Promise.all(promises), [0, 1, 2, 3, 4]);
  await tick();
  const rows = observer.drain();
  for (let i = 0; i < 5; i++) {
    const own = rows.filter((r) => r.requestKey === `raw-request:${i}`);
    assert.equal(own.filter((r) => r.phase === "enter").length, 1);
    assert.equal(own.filter((r) => r.phase === "fulfilled").length, 1);
    assert.ok(own.every((r) => !("owner" in r)));
  }
  assert.equal(rows.filter((r) => r.phase === "enter").length, 5);
  assert.equal(observer.snapshot().queues[0].counters.pending, 0);
  assert.equal(observer.snapshot().queues[0].counters.bytes, 0);
  assert.equal(observer.snapshot().faults, 0);
  assert.equal(observer.clock.realm, "main");
  assert.equal(observer.clock.threadId, 0);
  assert.equal(observer.clock.pid, process.pid);
  assert.ok(Number.isFinite(observer.clock.timeOrigin));
});
test("deadline admission is not execution; quota rejection unchanged", async (t) => {
  const observer = fixture(t);
  let now = 0;
  const queue = new WorkQueue(() => now),
    gates = Array.from({ length: 4 }, deferred);
  const active = gates.map((g) => queue.run("active", 1, 10, () => g.promise));
  let called = false;
  const expired = queue.run("expired", 1, 1, async () => {
    called = true;
  });
  const rejected = assert.rejects(expired, /timeout/);
  await assert.rejects(
    queue.run("invalid", 1048577, 10, async () => {
      throw new Error("unexpected");
    }),
    /queue/,
  );
  now = 2;
  gates.forEach((g) => g.resolve());
  await Promise.all(active);
  await rejected;
  await tick();
  assert.equal(called, false);
  const rows = observer.drain();
  assert.equal(
    rows.some((r) => ["expired", "invalid"].includes(r.source) && r.phase === "enter"),
    false,
  );
  const returned = rows.find((r) => r.source === "expired" && r.phase === "return");
  assert.equal(returned.counters.pending, 5);
  assert.equal(observer.snapshot().queues[0].counters.pending, 0);
});
test("outward promise identity, async rejection identity and cleanup retained", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(WorkQueue.prototype, "run");
  let returned;
  Object.defineProperty(WorkQueue.prototype, "run", {
    ...descriptor,
    value: function (...args) {
      returned = descriptor.value.apply(this, args);
      return returned;
    },
  });
  const observer = observeWorkQueue(WorkQueue);
  t.after(() => {
    observer.restore();
    Object.defineProperty(WorkQueue.prototype, "run", descriptor);
  });
  const error = new Error("original"),
    queue = new WorkQueue(() => 0);
  const actual = queue.run("s", 20, 10, async () => {
    throw error;
  });
  assert.equal(actual, returned);
  await assert.rejects(actual, (e) => e === error);
  await tick();
  assert.equal(observer.drain().filter((r) => r.phase === "rejected").length, 1);
  assert.equal(observer.snapshot().queues[0].counters.pending, 0);
});
test("synchronous callback throw keeps original queue behavior and restores even when nonidle", (t) => {
  const error = new Error("sync");
  const baseline = new WorkQueue(() => 0);
  assert.throws(
    () =>
      baseline.run("s", 5, 10, () => {
        throw error;
      }),
    (e) => e === error,
  );
  const observer = fixture(t),
    queue = new WorkQueue(() => 0);
  assert.throws(
    () =>
      queue.run("s", 5, 10, () => {
        throw error;
      }),
    (e) => e === error,
  );
  assert.equal(queue.pending, baseline.pending);
  assert.equal(observer.snapshot().queues[0].counters.pending, 1);
  observer.restore();
  assert.equal(observer.snapshot().restored, true);
});
test("bounded drain records dropped coverage and restoration leaves jobs running", async (t) => {
  const observer = fixture(t, 2),
    queue = new WorkQueue(() => 0),
    gate = deferred();
  const result = queue.run("s", 1, 10, () => gate.promise);
  assert.equal(observer.drain().length, 2);
  assert.ok(observer.snapshot().dropped > 0);
  observer.restore();
  gate.resolve(42);
  assert.equal(await result, 42);
  await tick();
  assert.equal(observer.snapshot().queues[0].counters.pending, 0);
  assert.equal(observer.drain().length, 1);
  await queue.run("s", 1, 10, async () => 7);
  await tick();
  assert.equal(observer.drain().length, 0);
});
test("does not overwrite another wrapper; duplicate installation rejected", (t) => {
  const observer = fixture(t),
    observed = Object.getOwnPropertyDescriptor(WorkQueue.prototype, "run");
  assert.throws(() => observeWorkQueue(WorkQueue), /already installed/);
  Object.defineProperty(WorkQueue.prototype, "run", {
    ...observed,
    value: function () {
      throw new Error("other");
    },
  });
  assert.throws(() => observer.restore(), /changed/);
  Object.defineProperty(WorkQueue.prototype, "run", observed);
});
test("counter observation failure cannot change successful work", async (t) => {
  const observer = fixture(t),
    queue = new WorkQueue(() => 0);
  Object.defineProperty(queue, "unused", {
    get() {
      throw new Error("never evaluated");
    },
  });
  assert.equal(await queue.run("s", 1, 10, async () => "ok"), "ok");
  await tick();
  // A changed private shape makes evidence incomplete, not a scheduling intervention.
  Object.defineProperty(queue, "sourceCount", { value: new Map([["bad", -1]]) });
  assert.equal(observer.snapshot().queues[0].counters, null);
  assert.ok(observer.snapshot().faults > 0);
});

test("actual 32 retained admissions include only four executing callbacks", async (t) => {
  const observer = fixture(t),
    queue = new WorkQueue(() => 0),
    gate = deferred();
  let entered = 0;
  const jobs = Array.from({ length: 32 }, (_, i) =>
    queue.run(i % 2 ? "a" : "b", 1, 10, () => {
      entered++;
      return gate.promise;
    }),
  );
  assert.equal(entered, 4);
  assert.equal(observer.snapshot().queues[0].counters.pending, 32);
  assert.equal(observer.snapshot().queues[0].counters.queued, 28);
  await assert.rejects(
    queue.run("c", 1, 10, async () => {
      throw new Error("unexpected");
    }),
    /queue/,
  );
  gate.resolve();
  await Promise.all(jobs);
  await tick();
  assert.equal(entered, 32);
  assert.equal(observer.drain().filter((r) => r.phase === "enter").length, 32);
  assert.equal(observer.snapshot().queues[0].counters.pending, 0);
});
test("real worker isolate identifies its own clock and explicit request context", async () => {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');
    (async()=>{
      const {WorkQueue}=await import(${JSON.stringify(new URL("../../apps/desktop/src/main/plugins/persistence/quota.ts", import.meta.url).href)});
      const {observeWorkQueue}=await import(${JSON.stringify(new URL("./plugin-persistence-pressure-observer.ts", import.meta.url).href)});
      const o=observeWorkQueue(WorkQueue), q=new WorkQueue(()=>0);
      await o.withRequest('actual-request:7',()=>q.run('source-only',1,10,async()=>42));
      await new Promise(setImmediate);
      o.restore(); parentPort.postMessage({snapshot:o.snapshot(),rows:o.drain()});
    })().catch(error=>{throw error});`,
    { eval: true },
  );
  let receipt;
  await new Promise((resolve, reject) => {
    worker.on("message", (value) => {
      receipt = value;
    });
    worker.on("error", reject);
    worker.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
    );
  });
  assert.equal(receipt.snapshot.clock.realm, "worker");
  assert.equal(receipt.snapshot.clock.pid, process.pid);
  assert.ok(receipt.snapshot.clock.threadId > 0);
  assert.equal(receipt.snapshot.queues[0].counters.pending, 0);
  assert.equal(receipt.snapshot.restored, true);
  assert.ok(receipt.rows.every((r) => r.requestKey === "actual-request:7" && !("owner" in r)));
});

test("real MessagePort forwarding scopes original queue callback and restores with sticky sink errors", async () => {
  const { MessageChannel } = await import("node:worker_threads");
  const { port1, port2 } = new MessageChannel(),
    rows = [];
  let fail = true;
  const original = WorkQueue.prototype.run;
  const hook = attachPressureWorkerTrace({
    Queue: WorkQueue,
    port: port1,
    parseRequest: (raw) => (raw?.operation === "read" ? raw : null),
    parseOwner: (raw) => (raw?.sourceKey ? raw : null),
    write: (row) => {
      if (fail) {
        fail = false;
        throw Error("sink");
      }
      rows.push(row);
    },
  });
  const queue = new WorkQueue(() => 0),
    done = deferred();
  port1.on("message", function (request) {
    assert.equal(this, port1);
    void queue
      .run(request.args[0].sourceKey, 1, 10, async () => hook.observer.currentExecution())
      .then(done.resolve, done.reject);
  });
  port2.postMessage({
    id: 7,
    operation: "read",
    args: [{ sourceKey: "actual-source", processEpoch: "actual-epoch" }],
  });
  const job = await done.promise;
  assert.match(job.requestKey, /:7$/);
  await tick();
  hook.finish();
  port1.close();
  port2.close();
  assert.equal(WorkQueue.prototype.run, original);
  assert.equal(rows.at(-1).sinkFaults, 1);
  assert.equal(rows.at(-1).observation.queues[0].counters.pending, 0);
});
