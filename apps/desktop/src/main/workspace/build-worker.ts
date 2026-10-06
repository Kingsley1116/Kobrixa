import { parentPort, workerData } from "node:worker_threads";
import { BuildSession } from "@kobrixa/compiler";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import type { BuildReply, BuildRequest } from "./build-protocol.js";

const port = parentPort;
if (!port) throw new Error("Compilation must run in a worker.");
const request = workerData as BuildRequest;
const cancellation = new Int32Array(request.cancellation);
const controller = new AbortController();
const check = controller.signal.throwIfAborted.bind(controller.signal);
// Messages cannot interrupt synchronous parsing/lowering. Shared cancellation
// remains visible at the compiler's checkpoints, including artifact commits.
controller.signal.throwIfAborted = () => {
  if (Atomics.load(cancellation, 0)) controller.abort();
  check();
};
const send = (reply: BuildReply) => port.postMessage(reply);
const session = new BuildSession(
  new BasicPlusFrontend(),
  new EV3Backend(),
  (progress) => send({ type: "progress", progress }),
  controller,
);
void session.compile(request.project).then((result) => {
  send({ type: "complete", result });
  port.close();
});
