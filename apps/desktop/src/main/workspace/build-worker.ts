import { parentPort, workerData } from "node:worker_threads";
import { BuildSession, failedBuild, requirePublished } from "@kobrixa/compiler";
import type { KobrixaIR } from "@kobrixa/ir";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createBuiltinCompilers } from "./builtin-compilers.js";
import { prepareSimulation } from "./prepare-simulation.js";
import type { BuildReply, BuildRequest } from "./build-protocol.js";
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
controller.signal.throwIfAborted = () => {
  if (Atomics.load(cancellation, 0)) controller.abort();
  check();
};
const send = (reply: BuildReply) => port.postMessage(reply);
async function run(): Promise<void> {
  if (request.simulation) {
    const result = await prepareSimulation(
      request.project,
      request.simulation.entries,
      request.simulation.files,
      controller.signal,
      request.compiler,
    );
    send({ type: "simulation", result });
    return;
  }
  const { frontend, backend, sources } = createBuiltinCompilers(request.compiler);
  let previewIR: KobrixaIR | undefined;
  const session = new BuildSession(
    {
      id: frontend.id,
      compile: async (project, signal) => {
        const result = await frontend.compile(project, signal);
        if (request.preview) previewIR = result.ir;
        return result;
      },
    },
    backend,
    (progress) => send({ type: "progress", progress }),
    controller,
    request.buildId,
    {},
    sources,
  );
  const result = await session.compile(request.project);
  let preview: OfflinePreviewProgram | undefined;
  let previewError: string | undefined;
  if (result.success && previewIR) {
    try {
      if (previewIR.version !== 1) throw new Error("Unsupported preview IR version.");
      const assets = result.artifacts.filter((artifact) => artifact.role === "deploy-asset");
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
        if (!asset.remotePath || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
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
}
void run()
  .catch((error: unknown) => {
    const result = failedBuild(
      request.buildId,
      request.project.manifest.target,
      error,
      request.project.manifest.entry,
    );
    if (request.simulation)
      send({
        type: "simulation",
        result: { success: false, diagnostics: requirePublished(result.diagnostics) },
      });
    else send({ type: "complete", result });
  })
  .finally(() => port.close());
