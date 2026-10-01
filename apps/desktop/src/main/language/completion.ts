import path from "node:path";
import { Worker } from "node:worker_threads";
import type { CompletionSyncReply, CompletionSyncRequest } from "../../shared/completion-sync.js";
import type { WorkspaceService } from "../workspace/workspace.js";
import type { CompletionWorkerReply, CompletionWorkerRequest } from "./completion-worker.js";

/** Dedicated lane: diagnostics cancellation and synchronous lowering cannot block it. */
export class CompletionService {
  private worker: Worker | undefined;
  private nextId = 0;
  private pending:
    | { id: number; resolve(reply: CompletionSyncReply): void; reject(error: Error): void }
    | undefined;
  private disposed = false;
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "projectInput">,
    private readonly createWorker = () =>
      new Worker(path.join(__dirname, "language-worker.cjs"), { workerData: { completion: true } }),
  ) {}
  sync(workspaceId: string, request: CompletionSyncRequest): Promise<CompletionSyncReply> {
    if (this.disposed) return Promise.reject(new Error("Completion service is disposed."));
    const input = this.workspaces.projectInput(workspaceId);
    // A replacement workspace may arrive while the old worker is still computing.
    if (this.pending) this.stop(new Error("Completion request superseded."));
    const worker = this.worker ?? this.start();
    const id = ++this.nextId;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      try {
        worker.postMessage({ id, input, workspaceId, request } satisfies CompletionWorkerRequest);
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.stop(new Error("Completion service disposed."));
  }
  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    this.pending?.reject(error);
    this.pending = undefined;
    if (worker) void worker.terminate();
  }
  private start(): Worker {
    const worker = this.createWorker();
    this.worker = worker;
    worker.on("message", (message: CompletionWorkerReply) => {
      if (worker !== this.worker || message.id !== this.pending?.id) return;
      const pending = this.pending;
      this.pending = undefined;
      worker.unref();
      if (message.ok) pending.resolve(message.reply);
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
