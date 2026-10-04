import { startCompletionWorker } from "./completion-worker.js";
import { parentPort, workerData } from "node:worker_threads";
import {
  BasicPlusProjectAnalyzer,
  getBasicPlusQuickFixes,
  type BasicPlusProjectAnalysis,
} from "@kobrixa/basic-plus";
import { loadProject, ProjectSourceCache } from "@kobrixa/compiler";
import { applyRecord, diffAnalysis, emptyAnalysis } from "../../shared/language-sync.js";
import type {
  DiagnosticsReply,
  DiagnosticsRequest,
  QuickFixWorkerRequest,
  QuickFixWorkerReply,
} from "./language-protocol.js";
import { sameDiagnostic, type QuickFixReply } from "../../shared/quick-fixes.js";

const port = parentPort;
if (!port) throw new Error("Diagnostics must run in a worker.");
let projectKey = "";
let analyzer = new BasicPlusProjectAnalyzer();
let sources = new ProjectSourceCache();
let documentSession = "";
let documentRevision = 0;
let overlays: Record<string, string> = Object.create(null);
const history = new Map<number, BasicPlusProjectAnalysis>();
const fixes = new Map<string, QuickFixReply>();
let currentWorkspaceId = "";
// Serialize async project loading as well as parsing. Superseded requests are
// skipped before I/O; only completed, version-checked replies reach the renderer.
let queue = Promise.resolve();
if (workerData?.completion) startCompletionWorker(port);
else
  port.on("message", (request: DiagnosticsRequest | QuickFixWorkerRequest) => {
    queue = queue.then(async () => {
      if ("kind" in request) {
        const query = request.request;
        const cancelled = new Int32Array(request.cancellation);
        const controller = new AbortController();
        const originalCheck = controller.signal.throwIfAborted.bind(controller.signal);
        controller.signal.throwIfAborted = () => {
          if (Atomics.load(cancelled, 0)) controller.abort();
          originalCheck();
        };
        let result: QuickFixReply = { kind: "stale" };
        try {
          controller.signal.throwIfAborted();
          const analysis = history.get(query.analysisVersion);
          const source = analysis?.index.sources[query.file];
          if (
            request.workspaceId === currentWorkspaceId &&
            query.session === documentSession &&
            query.revision === documentRevision &&
            source !== undefined &&
            analysis?.diagnostics.some(
              (d) => d.file === query.file && sameDiagnostic(d, query.diagnostic),
            )
          ) {
            const key = JSON.stringify([
              query.session,
              query.revision,
              query.analysisVersion,
              query.file,
              query.diagnostic,
            ]);
            result = fixes.get(key) ?? {
              kind: "result",
              fixes: getBasicPlusQuickFixes(
                query.file,
                source,
                query.diagnostic,
                controller.signal,
              ),
            };
            controller.signal.throwIfAborted();
            fixes.set(key, result);
            while (fixes.size > 128) fixes.delete(fixes.keys().next().value!);
          }
        } catch {
          // Cancellation or an invalid candidate must never offer an unchecked edit.
          result = { kind: "stale" };
        }
        port.postMessage({
          kind: "quick-fixes",
          id: request.id,
          result,
        } satisfies QuickFixWorkerReply);
        return;
      }
      const { id, input, sync, workspaceId } = request;
      currentWorkspaceId = workspaceId;
      fixes.clear();
      const cancellation = new Int32Array(request.cancellation);
      const controller = new AbortController();
      const check = () => {
        if (Atomics.load(cancellation, 0)) controller.abort(new Error("Diagnostics cancelled."));
        controller.signal.throwIfAborted();
      };
      const signal = controller.signal;
      const originalCheck = signal.throwIfAborted.bind(signal);
      signal.throwIfAborted = () => {
        if (Atomics.load(cancellation, 0)) controller.abort(new Error("Diagnostics cancelled."));
        originalCheck();
      };
      let reply: DiagnosticsReply;
      try {
        const key = JSON.stringify([workspaceId, input, sync.session]);
        if (key !== projectKey) {
          projectKey = key;
          analyzer = new BasicPlusProjectAnalyzer();
          sources = new ProjectSourceCache();
          history.clear();
          documentSession = "";
          documentRevision = 0;
          overlays = Object.create(null);
        }
        // Apply even canceled document updates, in order, before skipping work.
        // The next patch may be based on this synchronized revision.
        if (
          sync.baseRevision !== null &&
          (documentSession !== sync.session || documentRevision !== sync.baseRevision)
        )
          throw new Error("Worker document version mismatch.");
        overlays = applyRecord(
          sync.baseRevision === null ? Object.create(null) : overlays,
          sync.overlays,
        );
        documentSession = sync.session;
        documentRevision = sync.revision;
        check();
        const loaded = await loadProject(
          input.inputPath,
          new Map(Object.entries(overlays)),
          input.selectedEntry,
          sources,
        );
        check();
        let analysis: BasicPlusProjectAnalysis;
        if (!loaded.project) {
          if (!loaded.diagnostics.length) throw new Error("Choose an entry file before checking.");
          analysis = { ...emptyAnalysis(), diagnostics: loaded.diagnostics };
        } else analysis = analyzer.analyze(loaded.project, signal);
        check();
        const base = sync.analysisBase === null ? undefined : history.get(sync.analysisBase);
        const patch = diffAnalysis(base, analysis, sync.analysisBase, id);
        check();
        history.set(id, analysis);
        while (history.size > 2) history.delete(history.keys().next().value!);
        reply = { id, ok: true, patch };
      } catch (error) {
        reply = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      port.postMessage(reply);
    });
  });
