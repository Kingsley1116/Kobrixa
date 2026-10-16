import type { Worker } from "node:worker_threads";
import type { CompletionSyncReply, CompletionSyncRequest } from "../../shared/completion-sync.js";
import type { LanguageBinding } from "../../shared/language-services.js";
import type { WorkspaceService } from "../workspace/workspace.js";
import type { CompletionWorkerReply, CompletionWorkerRequest } from "./completion-worker.js";

/** Dedicated lane: diagnostics cancellation and synchronous lowering cannot block it. */
export class CompletionService {
  private epoch = 0;
  private worker: Worker | undefined;
  private nextId = 0;
  private pending:
    | {
        id: number;
        epoch: number;
        cancellation: Int32Array;
        resolve(reply: CompletionSyncReply): void;
        reject(error: Error): void;
      }
    | undefined;
  private disposed = false;
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
    this.stop(new Error("Language binding changed."), false);
  }
  sync(
    workspaceId: string,
    request: CompletionSyncRequest,
    binding: LanguageBinding,
  ): Promise<CompletionSyncReply> {
    if (this.disposed) return Promise.reject(new Error("Completion service is disposed."));
    const input = this.workspaces.projectInput(workspaceId);
    if (request.epoch !== this.epoch || binding.epoch !== this.epoch)
      return Promise.resolve({ kind: "resync", epoch: this.epoch });
    // Preserve the queue so cancelled document deltas are applied before the next one.
    if (this.pending) {
      Atomics.store(this.pending.cancellation, 0, 1);
      this.pending.reject(new Error("Completion request superseded."));
      this.pending = undefined;
    }
    const worker = this.worker ?? this.start();
    const id = ++this.nextId;
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending = { id, epoch: binding.epoch, cancellation, resolve, reject };
      try {
        worker.postMessage({
          id,
          input,
          workspaceId,
          request,
          binding,
          cancellation: cancellation.buffer as SharedArrayBuffer,
        } satisfies CompletionWorkerRequest);
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.stop(new Error("Completion service disposed."), false);
  }
  private stop(error: Error, restart = true): void {
    const worker = this.worker;
    this.worker = undefined;
    if (this.pending) Atomics.store(this.pending.cancellation, 0, 1);
    this.pending?.reject(error);
    this.pending = undefined;
    if (worker) void worker.terminate();
    if (restart) this.restarted();
  }
  private start(): Worker {
    const worker = this.createWorker();
    this.worker = worker;
    worker.on("message", (message: CompletionWorkerReply) => {
      if (worker !== this.worker || message.id !== this.pending?.id) return;
      const pending = this.pending;
      if (message.epoch !== pending.epoch || message.epoch !== this.epoch) return;
      this.pending = undefined;
      worker.unref();
      if (message.ok)
        pending.resolve(
          message.reply.epoch === this.epoch
            ? message.reply
            : { kind: "resync", epoch: this.epoch },
        );
      else pending.reject(new Error(message.error));
    });
    const fail = (error: Error) => {
      if (worker === this.worker) this.stop(error);
    };
    worker.once("error", fail);
    worker.once("exit", (code) => fail(new Error(`Completion worker exited (${code}).`)));
    return worker;
  }
}
