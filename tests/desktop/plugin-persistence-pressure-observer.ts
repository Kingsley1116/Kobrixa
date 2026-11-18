import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread, threadId, type MessagePort } from "node:worker_threads";
import type { WorkQueue } from "../../apps/desktop/src/main/plugins/persistence/quota.js";

type Counters = {
  pending: number;
  active: number;
  bytes: number;
  queued: number;
  sourceBytes: Array<[string, number]>;
  sourceCount: Array<[string, number]>;
};
type Job = {
  queueId: number;
  jobId: number;
  source: string;
  bytes: number;
  deadline: number;
  requestKey: string | null;
};
export type QueueObservation = Job & {
  sequence: number;
  at: number;
  phase: "call" | "return" | "enter" | "fulfilled" | "rejected" | "throw";
  counters: Counters | null;
};
const installations = new WeakSet<object>();
/** Acceptance-only observer. Supply the ORIGINAL class, before creating any queues.
 * requestKey is an explicit join to a retained real request trace, never an owner.
 * No hook is installed on Worker, MessagePort or the production request handler here. */
export function observeWorkQueue(Queue: typeof WorkQueue, limit = 4096) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536)
    throw new Error("Invalid trace bound");
  const prototype = Queue.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "run");
  if (!descriptor || typeof descriptor.value !== "function" || installations.has(prototype))
    throw new Error("WorkQueue observation already installed or method unavailable");
  const original: WorkQueue["run"] = descriptor.value;
  const clock = Object.freeze({
    realm: isMainThread ? "main" : "worker",
    pid: process.pid,
    threadId,
    timeOrigin: performance.timeOrigin,
  });
  const requests = new AsyncLocalStorage<string>();
  const executions = new AsyncLocalStorage<Job>();
  const queues = new Map<WorkQueue, number>();
  let events: QueueObservation[] = [];
  let nextJob = 0,
    sequence = 0,
    dropped = 0,
    faults = 0,
    restored = false;
  // Read original retained accounting. Do not turn pending into an execution count.
  const counters = (queue: WorkQueue): Counters | null => {
    try {
      const own = Object.getOwnPropertyDescriptors(queue);
      const number = (key: string): number => {
        const value: unknown = own[key]?.value;
        if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Counter shape");
        return value as number;
      };
      const entries = (key: string): Array<[string, number]> => {
        const map: unknown = own[key]?.value;
        if (!(map instanceof Map)) throw new Error("Counter map shape");
        const result: Array<[string, number]> = [];
        for (const [key, value] of map) {
          if (typeof key !== "string" || !Number.isSafeInteger(value) || value < 0)
            throw new Error("Counter entry shape");
          if (value) result.push([key, value]);
          if (result.length > 32) throw new Error("Counter map bound");
        }
        return result;
      };
      const waiting: unknown = own.queue?.value;
      if (!Array.isArray(waiting) || waiting.length > 32) throw new Error("Queue shape");
      return {
        pending: number("pending"),
        active: number("active"),
        bytes: number("bytes"),
        queued: waiting.length,
        sourceBytes: entries("sourceBytes"),
        sourceCount: entries("sourceCount"),
      };
    } catch {
      faults++;
      return null;
    }
  };
  const record = (queue: WorkQueue, job: Job, phase: QueueObservation["phase"]) => {
    try {
      const seq = ++sequence;
      if (events.length >= limit) {
        dropped++;
        return;
      }
      events.push({
        ...job,
        sequence: seq,
        at: performance.now(),
        phase,
        counters: counters(queue),
      });
    } catch {
      faults++;
    }
  };
  function observed<T>(
    this: WorkQueue,
    source: string,
    bytes: number,
    deadline: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    // Keep the queue receiver distinct from the original callback receiver.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const queue = this;
    let queueId = queues.get(queue);
    if (queueId === undefined) {
      if (queues.size >= 16) {
        faults++;
        return original.call(queue, source, bytes, deadline, callback) as Promise<T>;
      }
      queueId = queues.size + 1;
      queues.set(queue, queueId);
    }
    const job: Job = {
      queueId,
      jobId: ++nextJob,
      source,
      bytes,
      deadline,
      requestKey: requests.getStore() ?? null,
    };
    record(queue, job, "call");
    function execute(this: unknown): Promise<T> {
      record(queue, job, "enter");
      try {
        const work = executions.run(job, () => Reflect.apply(callback, this, []) as Promise<T>);
        // Observe callback settlement, not the outward promise: preserve its identity
        // and the caller's original unhandled-rejection responsibility.
        void work.then(
          () => record(queue, job, "fulfilled"),
          () => record(queue, job, "rejected"),
        );
        return work;
      } catch (error) {
        record(queue, job, "throw");
        throw error;
      }
    }
    try {
      const result = original.call(queue, source, bytes, deadline, execute) as Promise<T>;
      record(queue, job, "return");
      return result;
    } catch (error) {
      record(queue, job, "throw");
      throw error;
    }
  }
  Object.defineProperty(prototype, "run", { ...descriptor, value: observed });
  installations.add(prototype);
  return {
    clock,
    /** Integration must retain the actual request bearing this key and full owner. */
    withRequest<T>(key: string, work: () => T): T {
      if (!key || key.length > 256) throw new Error("Invalid request trace key");
      return requests.run(key, work);
    },
    currentExecution: () => {
      const job = executions.getStore();
      return job ? { ...job } : null;
    },
    snapshot: () => ({
      clock,
      restored,
      dropped,
      faults,
      queues: [...queues].map(([queue, queueId]) => ({ queueId, counters: counters(queue) })),
    }),
    drain: () => {
      const result = events;
      events = [];
      return result;
    },
    /** Does not drain/cancel product jobs, and never overwrites a later observer. */
    restore: () => {
      if (restored) return;
      if (Object.getOwnPropertyDescriptor(prototype, "run")?.value !== observed)
        throw new Error("WorkQueue method changed during observation");
      Object.defineProperty(prototype, "run", descriptor);
      installations.delete(prototype);
      restored = true;
    },
  };
}

/** Temporary worker-entry seam. Original handler and original WorkQueue are always called. */
export function attachPressureWorkerTrace(input: {
  Queue: typeof WorkQueue;
  port: MessagePort;
  parseRequest: (raw: unknown) => { id: number; operation: string; args: unknown[] } | null;
  parseOwner: (raw: unknown) => unknown | null;
  write: (row: unknown) => void;
}) {
  const observer = observeWorkQueue(input.Queue);
  const original = input.port.on;
  const own = Object.getOwnPropertyDescriptor(input.port, "on");
  let faults = 0,
    ended = false;
  const emit = (row: unknown) => {
    try {
      input.write(row);
    } catch {
      faults++;
    }
  };
  const flush = () => {
    const events = observer.drain();
    if (events.length) emit({ kind: "queue", clock: observer.clock, events });
    emit({
      kind: "stats",
      at: performance.now(),
      memory: process.memoryUsage(),
      observation: observer.snapshot(),
      sinkFaults: faults,
    });
  };
  input.port.on = function (
    this: typeof input.port,
    event: string,
    listener: (...args: unknown[]) => void,
  ) {
    if (event !== "message") return original.call(this, event, listener);
    return original.call(this, event, function (this: unknown, ...args: unknown[]) {
      let request;
      try {
        request = input.parseRequest(args[0]);
      } catch {
        faults++;
      }
      if (!request) return Reflect.apply(listener, this, args);
      const key = `worker:${observer.clock.threadId}:${request.id}`;
      try {
        const first = request.args[0] as { owner?: unknown } | undefined;
        const owner = input.parseOwner(first) ?? input.parseOwner(first?.owner);
        emit({
          kind: "request",
          key,
          id: request.id,
          operation: request.operation,
          first,
          owner,
          at: performance.now(),
        });
      } catch {
        faults++;
      }
      return observer.withRequest(key, () => Reflect.apply(listener, this, args));
    });
  } as typeof original;
  const timer = setInterval(flush, 20);
  timer.unref();
  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    if (own) Object.defineProperty(input.port, "on", own);
    else delete (input.port as Partial<typeof input.port>).on;
    observer.restore();
    flush();
    emit({ kind: "end", observation: observer.snapshot(), sinkFaults: faults });
  };
  original.call(input.port, "close", finish);
  return { observer, finish };
}
