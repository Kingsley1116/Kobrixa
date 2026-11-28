import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { getHeapSpaceStatistics } from "node:v8";
import { BroadcastChannel, Worker, threadId } from "node:worker_threads";
const now = () => Number(process.hrtime.bigint()) / 1e6;

type Trigger = {
  label: string;
  at: number;
  seq?: number;
  bytes?: number;
  count?: number;
};

// Test bundle only. Each isolate samples its own V8 instance. Preserve both clocks:
// delivery can be delayed while the product owns the main loop or the worker.
export function observeIsolate(file: string, channelName: string, metrics?: () => unknown) {
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  const capture = (trigger: Trigger) => {
    const at = now();
    try {
      const row = {
        trigger,
        at,
        pid: process.pid,
        threadId,
        memory: process.memoryUsage(),
        spaces: getHeapSpaceStatistics(),
        maxRSSKiB: process.resourceUsage().maxRSS,
        ...(metrics ? { processes: metrics() } : {}),
        finishedAt: now(),
      };
      appendFileSync(file + ".checkpoints.jsonl", JSON.stringify(row) + "\n");
    } catch (error) {
      console.error("B2 attribution unavailable", trigger, error);
    }
  };
  channel.onmessage = (event) => capture((event as MessageEvent<Trigger>).data);
  const sample = () => {
    const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    appendFileSync(
      file,
      JSON.stringify({
        at: Number(process.hrtime.bigint()) / 1e6,
        pid: process.pid,
        threadId,
        heapUsed,
        heapTotal,
        external,
        arrayBuffers,
      }) + "\n",
    );
  };
  sample();
  const timer = setInterval(sample, 500);
  timer.unref();
  return {
    checkpoint(label: string, count?: number) {
      const trigger = { label, at: now(), ...(count === undefined ? {} : { count }) };
      channel.postMessage(trigger);
      capture(trigger);
    },
    stop() {
      clearInterval(timer);
      channel.close();
    },
  };
}
export async function startRss(config: {
  identity: string;
  mainDiagnostics: string;
  sampler: string;
  raw: string;
  trial: string;
  node: string;
  profile: string;
}) {
  writeFileSync(
    config.identity,
    JSON.stringify({
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      execArgv: process.execArgv,
      argv: process.argv,
      trial: config.trial,
      profile: config.profile,
      started: Date.now(),
      coldUptimeSeconds: process.uptime(),
      hrtimeMs: Number(process.hrtime.bigint()) / 1e6,
      performanceMs: performance.now(),
      timeOrigin: performance.timeOrigin,
      nodeEnv: Reflect.get(process.env, "NODE_ENV"),
    }),
    { flag: "wx" },
  );
  const { app } = await import("electron");
  const observer = observeIsolate(config.mainDiagnostics, config.raw, () =>
    app.getAppMetrics().map(({ pid, type, creationTime, memory }) => ({
      pid,
      type,
      creationTime,
      workingSetKiB: memory?.workingSetSize ?? null,
    })),
  );
  const worker = new Worker(config.sampler, {
    workerData: {
      file: config.raw,
      trial: config.trial,
      node: config.node,
      checkpointChannel: config.raw,
    },
  });
  const exit = once(worker, "exit");
  // Observe errors even during a long workload before the final join.
  exit.catch(() => {});
  async function phase(name: "work" | "idle" | "cleanup", send = true) {
    const ack = once(worker, "message");
    if (send) worker.postMessage(name);
    const [reply] = await Promise.race([ack, exit]);
    assert.equal(reply, name);
  }
  await phase("work", false);
  observer.checkpoint("baseline-end");
  return {
    checkpoint: observer.checkpoint,
    cleanup: async () => {
      await phase("cleanup");
      observer.checkpoint("work-end");
    },
    async idle() {
      try {
        await phase("idle");
        const [code] = await exit;
        assert.equal(code, 0);
      } finally {
        observer.stop();
      }
    },
  };
}
