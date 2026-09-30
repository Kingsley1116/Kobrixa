import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Diagnostic } from "@kobrixa/compiler";
import type { DiagnosticsReply, DiagnosticsRequest } from "./language-protocol.js";
import type { WorkspaceService } from "./workspace.js";

export class LanguageService {
  private worker: Worker | undefined;
  private nextId = 0;
  private disposed = false;
  private pending:
    { id: number; resolve(items: Diagnostic[]): void; reject(error: Error): void } | undefined;

  constructor(
    private readonly workspaces: Pick<WorkspaceService, "projectInput">,
    private readonly createWorker: () => Worker = () =>
      new Worker(path.join(__dirname, "language-worker.cjs")),
  ) {}

  async diagnostics(workspaceId: string, overlays: Record<string, string>): Promise<Diagnostic[]> {
    if (this.disposed) throw new Error("Language service is disposed.");
    const input = this.workspaces.projectInput(workspaceId);
    this.cancel();
    const worker = this.worker ?? this.startWorker();
    const request: DiagnosticsRequest = { id: ++this.nextId, input, overlays };
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject };
      try {
        worker.postMessage(request);
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  cancel(): void {
    // Termination interrupts synchronous parsing too; an abort message cannot.
    if (this.pending && this.worker) this.fail(this.worker, new Error("Diagnostics cancelled."));
  }

  dispose(): void {
    this.disposed = true;
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
      if (worker !== this.worker || reply.id !== this.pending?.id) return;
      const pending = this.pending;
      this.pending = undefined;
      worker.unref();
      if (reply.ok) pending.resolve(reply.diagnostics);
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
    const pending = this.pending;
    this.pending = undefined;
    void worker.terminate();
    pending?.reject(error);
  }
}
