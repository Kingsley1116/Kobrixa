import { parentPort, workerData } from "node:worker_threads";
import { BUILTIN_LANGUAGE_SERVICES } from "../workspace/builtin-language-services.js";
import { startCompletionWorker } from "./completion-worker.js";
import { LanguageWorkerSession } from "./language-worker-session.js";
import type {
  DiagnosticsRequest,
  DiagnosticsReply,
  QuickFixWorkerRequest,
  QuickFixWorkerReply,
  FeatureWorkerRequest,
  FeatureWorkerReply,
} from "./language-protocol.js";
const port = parentPort;
if (!port) throw new Error("Diagnostics must run in a worker.");
if (workerData?.completion) startCompletionWorker(port, BUILTIN_LANGUAGE_SERVICES);
else {
  const session = new LanguageWorkerSession(BUILTIN_LANGUAGE_SERVICES);
  let queue = Promise.resolve();
  port.on(
    "message",
    (request: DiagnosticsRequest | QuickFixWorkerRequest | FeatureWorkerRequest) => {
      queue = queue.then(async () => {
        if ("kind" in request) {
          if (request.kind === "quick-fixes")
            port.postMessage({
              kind: "quick-fixes",
              id: request.id,
              epoch: request.request.epoch,
              result: session.quickFixes(request),
            } satisfies QuickFixWorkerReply);
          else {
            let result: FeatureWorkerReply["result"];
            try {
              result = session.feature(request);
            } catch {
              result = { kind: "stale", epoch: request.request.epoch };
            }
            port.postMessage({
              kind: "feature",
              id: request.id,
              epoch: request.request.epoch,
              result,
            } satisfies FeatureWorkerReply);
          }
          return;
        }
        let reply: DiagnosticsReply;
        try {
          reply = {
            id: request.id,
            epoch: request.binding.epoch,
            ok: true,
            reply: await session.sync(request),
          };
        } catch (error) {
          reply = {
            id: request.id,
            epoch: request.binding.epoch,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        port.postMessage(reply);
      });
    },
  );
  port.once("close", () => session.dispose());
}
