// This isolate measures the Electron main process, including all persistence threads.
import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
const sink = spawn(
  workerData.node,
  [fileURLToPath(new URL("./b2-process-rss-sink.mjs", import.meta.url)), workerData.file],
  { stdio: ["pipe", "inherit", "inherit", "ipc"] },
);
// Only signal a new observed high. The receiving isolates collect their own
// statistics asynchronously. No metric enumeration or diagnostic I/O on tick.
const checkpoints =
  workerData.checkpointChannel && new BroadcastChannel(workerData.checkpointChannel);
let high = 0;
let ended = false;
sink.once("close", (code, signal) => {
  if (!ended || signal || code !== 0)
    throw Error("RSS trace writer exited before successful completion");
  checkpoints?.close();
  parentPort.close();
});
const [message] = await once(sink, "message");
if (message !== "ready") throw Error("Expected RSS trace writer readiness");
const write = (row) => sink.stdin.write(JSON.stringify(row) + "\n");
const now = () => Number(process.hrtime.bigint()) / 1e6;
write({
  kind: "header",
  pid: process.pid,
  trial: workerData.trial,
  writerPid: sink.pid,
  periodMs: 20,
});
// t0 is on the sampler clock, after composition readiness and the open-file acknowledgement.
const start = now();
let phase,
  seq = 0,
  idle,
  timer;
function mark(name, at) {
  phase = name;
  write({ kind: "marker", phase, at });
}
mark("warmup", start);
function tick() {
  const at = now();
  if (phase === "warmup" && at >= start + 5000) mark("baseline", start + 5000);
  if (phase === "baseline" && at >= start + 10000) {
    mark("work", start + 10000);
    parentPort.postMessage("work");
  }
  if (phase === "idle" && at >= idle + 10000) {
    const end = idle + 10000;
    mark("end", end);
    checkpoints?.postMessage({ label: "retained-end", at: end });
    write({ kind: "end", at: end, count: seq });
    ended = true;
    sink.stdin.end();
    return;
  }
  const bytes = process.memoryUsage.rss();
  const writable = write({
    kind: "sample",
    at,
    phase,
    pid: process.pid,
    seq: seq++,
    bytes,
  });
  if (checkpoints && phase !== "warmup" && phase !== "baseline" && bytes > high) {
    high = bytes;
    checkpoints.postMessage({ label: "peak", at, seq: seq - 1, bytes });
  }
  const next = start + (Math.floor((at - start) / 20) + 1) * 20;
  const wake = () => {
    const left = next - now();
    if (left > 0) timer = setTimeout(wake, Math.ceil(left));
    else tick();
  };
  // write(false) accepted this row. Resume on the real clock after drain so
  // a stalled writer is visible in the intervals and slot verdict.
  if (writable) wake();
  else sink.stdin.once("drain", wake);
}
parentPort.on("message", (name) => {
  if ((name === "cleanup" && phase === "work") || (name === "idle" && phase === "cleanup")) {
    const at = now();
    mark(name, at);
    if (name === "idle") idle = at;
    parentPort.postMessage(name);
  } else throw Error("Invalid RSS phase transition");
});
parentPort.on("close", () => clearTimeout(timer));
tick();
