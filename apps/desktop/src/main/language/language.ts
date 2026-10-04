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
import type {
  DiagnosticsReply,
  DiagnosticsRequest,
  QuickFixWorkerReply,
  QuickFixWorkerRequest,
} from "./language-protocol.js";
import type { QuickFixReply, QuickFixRequest } from "../../shared/quick-fixes.js";
import type { WorkspaceService } from "../workspace/workspace.js";

export class LanguageService {
  private worker: Worker | undefined;
  private nextId = 0;
  private documents:
    | { workspaceId: string; session: string; revision: number; overlays: Record<string, string> }
    | undefined;
  private workerSession: string | undefined;
  private disposed = false;
  private accepted:
    { workspaceId: string; session: string; revision: number; analysisVersion: number } | undefined;
  private readonly pendingFixes = new Map<
    number,
    {
      workspaceId: string;
      requestId: string;
      cancellation: Int32Array;
      resolve(result: QuickFixReply): void;
    }
  >();
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
    if (
      this.documents?.workspaceId === workspaceId &&
      this.documents.session === update.session &&
      this.documents.revision === update.revision
    )
      this.accepted = {
        workspaceId,
        session: update.session,
        revision: update.revision,
        analysisVersion: patch.version,
      };
    return { kind: "result", session: update.session, revision: update.revision, patch };
  }

  async quickFixes(workspaceId: string, request: QuickFixRequest): Promise<QuickFixReply> {
    if (this.disposed) throw new Error("Language service is disposed.");
    this.workspaces.projectInput(workspaceId);
    const accepted = this.accepted;
    const worker = this.worker;
    if (
      !worker ||
      !accepted ||
      accepted.workspaceId !== workspaceId ||
      accepted.session !== request.session ||
      accepted.revision !== request.revision ||
      accepted.analysisVersion !== request.analysisVersion
    )
      return { kind: "stale" };
    // A query identity belongs to exactly one live request in one workspace.
    if (
      [...this.pendingFixes.values()].some(
        (pending) => pending.workspaceId === workspaceId && pending.requestId === request.requestId,
      )
    )
      return { kind: "stale" };
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const message: QuickFixWorkerRequest = {
      kind: "quick-fixes",
      id: ++this.nextId,
      workspaceId,
      request,
      cancellation: cancellation.buffer as SharedArrayBuffer,
    };
    worker.ref();
    const result = await new Promise<QuickFixReply>((resolve) => {
      this.pendingFixes.set(message.id, {
        workspaceId,
        requestId: request.requestId,
        cancellation,
        resolve,
      });
      try {
        worker.postMessage(message);
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.accepted === accepted ? result : { kind: "stale" };
  }

  cancelQuickFix(workspaceId: string, requestId: string): void {
    for (const [id, pending] of this.pendingFixes) {
      if (pending.workspaceId !== workspaceId || pending.requestId !== requestId) continue;
      Atomics.store(pending.cancellation, 0, 1);
      pending.resolve({ kind: "stale" });
      this.pendingFixes.delete(id);
      // The worker sees cancellation through shared memory even during parsing.
      // A late response is ignored, without invalidating the accepted analysis.
      if (!this.pending && !this.pendingFixes.size) this.worker?.unref();
      return;
    }
  }

  cancel(): void {
    this.accepted = undefined;
    for (const pending of this.pendingFixes.values()) {
      Atomics.store(pending.cancellation, 0, 1);
      pending.resolve({ kind: "stale" });
    }
    this.pendingFixes.clear();
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
    worker.on("message", (reply: DiagnosticsReply | QuickFixWorkerReply) => {
      if (worker !== this.worker) return;
      if ("kind" in reply) {
        const pending = this.pendingFixes.get(reply.id);
        this.pendingFixes.delete(reply.id);
        pending?.resolve(reply.result);
        if (!this.pending && !this.pendingFixes.size) worker.unref();
        return;
      }
      if (reply.id !== this.pending?.id) {
        if (!this.pending && !this.pendingFixes.size) worker.unref();
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (!this.pendingFixes.size) worker.unref();
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
    this.accepted = undefined;
    for (const pending of this.pendingFixes.values()) pending.resolve({ kind: "stale" });
    this.pendingFixes.clear();
    const pending = this.pending;
    this.pending = undefined;
    void worker.terminate();
    pending?.reject(error);
  }
}
