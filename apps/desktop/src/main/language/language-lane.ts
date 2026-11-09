import type { Worker } from "node:worker_threads";
import type { LanguageBinding } from "../../shared/language-services.js";
import type { LanguageFeatureRequest, LanguageFeatureReply } from "../../shared/language-query.js";
import type { LanguageSyncReply, LanguageSyncRequest } from "../../shared/language-sync.js";
import type {
  FeatureWorkerRequest,
  FeatureWorkerReply,
  DiagnosticsReply,
  DiagnosticsRequest,
  QuickFixWorkerReply,
  QuickFixWorkerRequest,
} from "./language-protocol.js";
import type { QuickFixReply, QuickFixRequest } from "../../shared/quick-fixes.js";
import type { WorkspaceService } from "../workspace/workspace.js";

export class LanguageLane {
  private epoch = 0;
  private worker: Worker | undefined;
  private nextId = 0;
  private documents: { workspaceId: string; session: string; revision: number } | undefined;
  private disposed = false;
  private accepted:
    | {
        epoch: number;
        workspaceId: string;
        session: string;
        revision: number;
        analysisVersion: number;
      }
    | undefined;
  private readonly pendingFixes = new Map<
    number,
    {
      workspaceId: string;
      requestId: string;
      epoch: number;
      cancellation: Int32Array;
      resolve(result: QuickFixReply): void;
    }
  >();
  private pending:
    | {
        id: number;
        epoch: number;
        cancellation: Int32Array;
        resolve(reply: LanguageSyncReply): void;
        reject(error: Error): void;
      }
    | undefined;

  constructor(
    private readonly workspaces: Pick<WorkspaceService, "projectInput">,
    private readonly createWorker: () => Worker,
    private readonly restarted: () => void,
  ) {}
  setBinding(binding: LanguageBinding): void {
    if (this.epoch === binding.epoch) return;
    this.reset();
    this.epoch = binding.epoch;
  }
  reset(): void {
    this.cancel();
    const worker = this.worker;
    this.worker = undefined;
    this.documents = undefined;
    this.accepted = undefined;
    if (worker) void worker.terminate();
  }
  async sync(
    workspaceId: string,
    update: LanguageSyncRequest,
    binding: LanguageBinding,
  ): Promise<LanguageSyncReply> {
    if (this.disposed) throw new Error("Language service is disposed.");
    const input = this.workspaces.projectInput(workspaceId);
    if (update.epoch !== this.epoch || binding.epoch !== this.epoch)
      return { kind: "resync", epoch: this.epoch };
    const previous = this.documents;
    if (
      update.baseRevision !== null &&
      (!previous ||
        previous.workspaceId !== workspaceId ||
        previous.session !== update.session ||
        previous.revision !== update.baseRevision ||
        update.revision <= previous.revision)
    )
      return { kind: "resync", epoch: this.epoch };
    this.documents = { workspaceId, session: update.session, revision: update.revision };
    this.cancel();
    const worker = this.worker ?? this.startWorker();
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const request: DiagnosticsRequest = {
      binding,
      id: ++this.nextId,
      input,
      sync: update,
      workspaceId,
      cancellation: cancellation.buffer as SharedArrayBuffer,
    };
    worker.ref();
    const reply = await new Promise<LanguageSyncReply>((resolve, reject) => {
      this.pending = { id: request.id, epoch: binding.epoch, cancellation, resolve, reject };
      try {
        worker.postMessage(request);
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (
      reply.kind === "result" &&
      reply.epoch === this.epoch &&
      this.documents?.workspaceId === workspaceId &&
      this.documents.session === update.session &&
      this.documents.revision === update.revision
    )
      this.accepted = {
        epoch: binding.epoch,
        workspaceId,
        session: update.session,
        revision: update.revision,
        analysisVersion: reply.patch.version,
      };
    return reply;
  }

  async quickFixes(workspaceId: string, request: QuickFixRequest): Promise<QuickFixReply> {
    if (this.disposed) throw new Error("Language service is disposed.");
    this.workspaces.projectInput(workspaceId);
    const accepted = this.accepted;
    const worker = this.worker;
    if (
      !worker ||
      !accepted ||
      request.epoch !== this.epoch ||
      accepted.epoch !== request.epoch ||
      accepted.workspaceId !== workspaceId ||
      accepted.session !== request.session ||
      accepted.revision !== request.revision ||
      accepted.analysisVersion !== request.analysisVersion
    )
      return { kind: "stale", epoch: this.epoch };
    // A query identity belongs to exactly one live request in one workspace.
    if (
      [...this.pendingFixes.values()].some(
        (pending) => pending.workspaceId === workspaceId && pending.requestId === request.requestId,
      )
    )
      return { kind: "stale", epoch: this.epoch };
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
        epoch: request.epoch,
        cancellation,
        resolve,
      });
      try {
        worker.postMessage(message);
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.accepted === accepted && this.epoch === request.epoch
      ? result
      : { kind: "stale", epoch: this.epoch };
  }

  cancelQuickFix(workspaceId: string, requestId: string): void {
    for (const [id, pending] of this.pendingFixes) {
      if (pending.workspaceId !== workspaceId || pending.requestId !== requestId) continue;
      Atomics.store(pending.cancellation, 0, 1);
      pending.resolve({ kind: "stale", epoch: this.epoch });
      this.pendingFixes.delete(id);
      // The worker sees cancellation through shared memory even during parsing.
      // A late response is ignored, without invalidating the accepted analysis.
      if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size)
        this.worker?.unref();
      return;
    }
  }

  cancel(): void {
    this.accepted = undefined;
    for (const pending of this.pendingFixes.values()) {
      Atomics.store(pending.cancellation, 0, 1);
      pending.resolve({ kind: "stale", epoch: this.epoch });
    }
    this.pendingFixes.clear();
    for (const pending of this.pendingFeatures.values()) {
      Atomics.store(pending.cancellation, 0, 1);
      pending.resolve({ kind: "stale", epoch: this.epoch });
    }
    this.pendingFeatures.clear();
    // Shared memory is visible during synchronous parsing, unlike an abort
    // message. Keep the worker and its completed caches for the next revision.
    if (!this.pending) {
      this.unrefIdle();
      return;
    }
    Atomics.store(this.pending.cancellation, 0, 1);
    this.pending.reject(new Error("Diagnostics cancelled."));
    this.pending = undefined;
    this.unrefIdle();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private unrefIdle(): void {
    if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size)
      this.worker?.unref();
  }

  private readonly pendingFeatures = new Map<
    number,
    {
      workspaceId: string;
      requestId: string;
      epoch: number;
      cancellation: Int32Array;
      resolve(result: LanguageFeatureReply): void;
    }
  >();
  async feature(
    workspaceId: string,
    request: LanguageFeatureRequest,
  ): Promise<LanguageFeatureReply> {
    if (this.disposed) throw new Error("Language service is disposed.");
    this.workspaces.projectInput(workspaceId);
    const accepted = this.accepted,
      worker = this.worker;
    if (
      !worker ||
      !accepted ||
      request.epoch !== this.epoch ||
      accepted.epoch !== request.epoch ||
      accepted.workspaceId !== workspaceId ||
      accepted.session !== request.session ||
      accepted.revision !== request.revision ||
      accepted.analysisVersion !== request.analysisVersion ||
      [...this.pendingFeatures.values()].some(
        (pending) => pending.workspaceId === workspaceId && pending.requestId === request.requestId,
      )
    )
      return { kind: "stale", epoch: this.epoch };
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const message: FeatureWorkerRequest = {
      kind: "feature",
      id: ++this.nextId,
      workspaceId,
      request,
      cancellation: cancellation.buffer as SharedArrayBuffer,
    };
    worker.ref();
    const result = await new Promise<LanguageFeatureReply>((resolve) => {
      this.pendingFeatures.set(message.id, {
        workspaceId,
        requestId: request.requestId,
        epoch: request.epoch,
        cancellation,
        resolve,
      });
      try {
        worker.postMessage(message);
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.accepted === accepted && this.epoch === request.epoch
      ? result
      : { kind: "stale", epoch: this.epoch };
  }
  cancelFeature(workspaceId: string, requestId: string): void {
    for (const [id, pending] of this.pendingFeatures) {
      if (pending.workspaceId !== workspaceId || pending.requestId !== requestId) continue;
      Atomics.store(pending.cancellation, 0, 1);
      pending.resolve({ kind: "stale", epoch: this.epoch });
      this.pendingFeatures.delete(id);
      if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size)
        this.worker?.unref();
      return;
    }
  }

  private startWorker(): Worker {
    const worker = this.createWorker();
    this.worker = worker;
    worker.on("message", (reply: DiagnosticsReply | QuickFixWorkerReply | FeatureWorkerReply) => {
      if (worker !== this.worker) return;
      if ("kind" in reply && reply.kind === "feature") {
        const pending = this.pendingFeatures.get(reply.id);
        if (!pending || reply.epoch !== pending.epoch || reply.epoch !== this.epoch) return;
        this.pendingFeatures.delete(reply.id);
        pending.resolve(
          reply.result.epoch === this.epoch ? reply.result : { kind: "stale", epoch: this.epoch },
        );
        if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size) worker.unref();
        return;
      }
      if ("kind" in reply) {
        const pending = this.pendingFixes.get(reply.id);
        if (!pending || reply.epoch !== pending.epoch || reply.epoch !== this.epoch) return;
        this.pendingFixes.delete(reply.id);
        pending.resolve(
          reply.result.epoch === this.epoch ? reply.result : { kind: "stale", epoch: this.epoch },
        );
        if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size) worker.unref();
        return;
      }
      if (reply.id !== this.pending?.id) {
        if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size) worker.unref();
        return;
      }
      const pending = this.pending;
      if (reply.epoch !== this.epoch || reply.epoch !== pending.epoch) return;
      this.pending = undefined;
      if (!this.pendingFixes.size && !this.pendingFeatures.size) worker.unref();
      if (reply.ok) pending.resolve(reply.reply);
      else pending.reject(new Error(reply.error));
    });
    worker.once("error", (error) =>
      this.fail(worker, error instanceof Error ? error : new Error(String(error))),
    );
    worker.once("exit", (code) =>
      this.fail(worker, new Error(`Diagnostics worker exited (${code}).`)),
    );
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    this.documents = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) Atomics.store(pending.cancellation, 0, 1);
    this.cancel();
    void worker.terminate();
    pending?.reject(error);
    this.restarted();
  }
}
