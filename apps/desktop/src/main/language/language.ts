import { CompletionService } from "./completion.js";
import type { CompletionSyncRequest } from "../../shared/completion-sync.js";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
import type { Diagnostic } from "@kobrixa/compiler";
import {
  applyAnalysis,
  applyRecord,
  type AnalysisPatch,
  type LanguageSyncReply,
  type LanguageSyncRequest,
} from "../../shared/language-sync.js";
import type { DiagnosticsReply, DiagnosticsRequest } from "./language-protocol.js";
import type { WorkspaceService } from "../workspace/workspace.js";

export class LanguageService {
  private worker: Worker | undefined;
  private nextId = 0;
  private documents:
    | { workspaceId: string; session: string; revision: number; overlays: Record<string, string> }
    | undefined;
  private workerSession: string | undefined;
  private disposed = false;
  private pending:
    | {
        id: number;
        cancellation: Int32Array;
        resolve(patch: AnalysisPatch): void;
        reject(error: Error): void;
      }
    | undefined;

  private readonly completions: CompletionService;
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "projectInput">,
    private readonly createWorker: () => Worker = () =>
      new Worker(path.join(__dirname, "language-worker.cjs")),
  ) {
    this.completions = new CompletionService(workspaces);
  }

  completionSync(workspaceId: string, request: CompletionSyncRequest) {
    return this.completions.sync(workspaceId, request);
  }

  async diagnostics(workspaceId: string, overlays: Record<string, string>): Promise<Diagnostic[]> {
    return (await this.analyze(workspaceId, overlays)).diagnostics;
  }

  async analyze(
    workspaceId: string,
    overlays: Record<string, string>,
  ): Promise<BasicPlusProjectAnalysis> {
    const reply = await this.sync(workspaceId, {
      session: "compatibility",
      revision: this.nextId + 1,
      baseRevision: null,
      overlays: { set: overlays, removed: [] },
      analysisBase: null,
    });
    if (reply.kind !== "result") throw new Error("Unable to synchronize language documents.");
    return applyAnalysis(undefined, reply.patch).analysis;
  }

  async sync(workspaceId: string, update: LanguageSyncRequest): Promise<LanguageSyncReply> {
    if (this.disposed) throw new Error("Language service is disposed.");
    const input = this.workspaces.projectInput(workspaceId);
    const previous = this.documents;
    if (
      update.baseRevision !== null &&
      (!previous ||
        previous.workspaceId !== workspaceId ||
        previous.session !== update.session ||
        previous.revision !== update.baseRevision ||
        update.revision <= previous.revision)
    )
      return { kind: "resync" };
    const overlays = applyRecord(
      update.baseRevision === null ? Object.create(null) : previous!.overlays,
      update.overlays,
    );
    this.documents = { workspaceId, session: update.session, revision: update.revision, overlays };
    this.cancel();
    const worker = this.worker ?? this.startWorker();
    const workerSession = JSON.stringify([workspaceId, input, update.session]);
    // After restart the main process can seed the worker without retransmitting
    // unchanged buffers from the renderer.
    const sync =
      this.workerSession === workerSession
        ? update
        : {
            ...update,
            baseRevision: null,
            overlays: { set: overlays, removed: [] },
          };
    this.workerSession = workerSession;
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const request: DiagnosticsRequest = {
      id: ++this.nextId,
      input,
      sync,
      workspaceId,
      cancellation: cancellation.buffer as SharedArrayBuffer,
    };
    worker.ref();
    const patch = await new Promise<AnalysisPatch>((resolve, reject) => {
      this.pending = { id: request.id, cancellation, resolve, reject };
      try {
        worker.postMessage(request);
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { kind: "result", session: update.session, revision: update.revision, patch };
  }

  cancel(): void {
    // Shared memory is visible during synchronous parsing, unlike an abort
    // message. Keep the worker and its completed caches for the next revision.
    if (!this.pending) return;
    Atomics.store(this.pending.cancellation, 0, 1);
    this.pending.reject(new Error("Diagnostics cancelled."));
    this.pending = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.completions.dispose();
    this.cancel();
    if (this.worker) {
      void this.worker.terminate();
      this.worker = undefined;
    }
  }

  private startWorker(): Worker {
    const worker = this.createWorker();
    this.worker = worker;
    worker.on("message", (reply: DiagnosticsReply) => {
      if (worker !== this.worker) return;
      if (reply.id !== this.pending?.id) {
        if (!this.pending) worker.unref();
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      worker.unref();
      if (reply.ok) pending.resolve(reply.patch);
      else pending.reject(new Error(reply.error));
    });
    worker.once("error", (error) => this.fail(worker, error));
    worker.once("exit", (code) =>
      this.fail(worker, new Error(`Diagnostics worker exited (${code}).`)),
    );
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    this.workerSession = undefined;
    const pending = this.pending;
    this.pending = undefined;
    void worker.terminate();
    pending?.reject(error);
  }
}
