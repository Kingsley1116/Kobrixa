import { parentPort } from "node:worker_threads";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { loadProject } from "@kobrixa/compiler";
import type { DiagnosticsReply, DiagnosticsRequest } from "./language-protocol.js";

const port = parentPort;
if (!port) throw new Error("Diagnostics must run in a worker.");

port.on("message", async ({ id, input, overlays }: DiagnosticsRequest) => {
  let reply: DiagnosticsReply;
  try {
    const loaded = await loadProject(
      input.inputPath,
      new Map(Object.entries(overlays)),
      input.selectedEntry,
    );
    if (!loaded.project) {
      if (!loaded.diagnostics.length) throw new Error("Choose an entry file before checking.");
      reply = { id, ok: true, diagnostics: loaded.diagnostics };
    } else {
      const result = await new BasicPlusFrontend().compile(
        loaded.project,
        new AbortController().signal,
      );
      reply = { id, ok: true, diagnostics: result.diagnostics };
    }
  } catch (error) {
    reply = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
