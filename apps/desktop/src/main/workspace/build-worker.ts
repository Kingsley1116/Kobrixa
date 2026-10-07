import { parentPort, workerData } from "node:worker_threads";
import { BuildSession } from "@kobrixa/compiler";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import type { BuildReply, BuildRequest } from "./build-protocol.js";
import type { KobrixaIR } from "@kobrixa/ir";
import { prepareSimulation } from "./prepare-simulation.js";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  PREVIEW_MAX_FILES,
  PREVIEW_MAX_FILE_BYTES,
  type OfflinePreviewProgram,
} from "../../shared/offline-preview.js";

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
if (request.simulation) {
  void prepareSimulation(
    request.project,
    request.simulation.entries,
    request.simulation.files,
    controller.signal,
  ).then((result) => {
    send({ type: "simulation", result });
    port.close();
  });
} else {
  const frontend = new BasicPlusFrontend();
  let previewIR: KobrixaIR | undefined;
  const session = new BuildSession(
    {
      id: frontend.id,
      async compile(project, signal) {
        const result = await frontend.compile(project, signal);
        if (request.preview) previewIR = result.ir;
        return result;
      },
    },
    new EV3Backend(),
    (progress) => send({ type: "progress", progress }),
    controller,
  );
  void session.compile(request.project).then(async (result) => {
    // Send the exact compiled source snapshot, never re-read a mutable output path.
    let preview: OfflinePreviewProgram | undefined;
    let previewError: string | undefined;
    if (result.success && previewIR) {
      try {
        const assets = result.artifacts.filter((artifact) => artifact.kind === "asset");
        if (assets.length > PREVIEW_MAX_FILES)
          throw new Error("Offline preview supports at most 64 resource files.");
        const files: Record<string, number[]> = Object.create(null);
        let total = 0;
        for (const asset of assets) {
          controller.signal.throwIfAborted();
          const info = await stat(asset.path);
          if (info.size > PREVIEW_MAX_FILE_BYTES - total)
            throw new Error("Offline preview resource files exceed the 1 MiB limit.");
          const bytes = await readFile(asset.path);
          total += bytes.length;
          if (total > PREVIEW_MAX_FILE_BYTES)
            throw new Error("Offline preview resource files exceed the 1 MiB limit.");
          if (
            !asset.remotePath ||
            createHash("sha256").update(bytes).digest("hex") !== asset.sha256
          )
            throw new Error("Build resources changed while preparing the preview. Build again.");
          files[asset.remotePath] = Array.from(bytes);
        }
        controller.signal.throwIfAborted();
        preview = { ir: previewIR, files };
      } catch (error) {
        previewError = error instanceof Error ? error.message : String(error);
      }
    }
    send({
      type: "complete",
      result,
      ...(preview ? { preview } : {}),
      ...(previewError ? { previewError } : {}),
    });
    port.close();
  });
}
