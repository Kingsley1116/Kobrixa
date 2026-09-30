import type { Diagnostic } from "../shared/api.js";

interface DiagnosticsCallbacks {
  cancel(): void;
  check(workspaceId: string, overlays: Record<string, string>): Promise<Diagnostic[]>;
  onDiagnostics(items: Diagnostic[]): void;
  onChecking(checking: boolean): void;
  onError(error: unknown): void;
}

/** Keep at most one IPC check in flight and only check the latest settled edit. */
export class LiveDiagnostics {
  private revision = 0;
  private running = false;
  private checking = false;
  private cancellationRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending:
    { revision: number; workspaceId: string; overlays: Record<string, string> } | undefined;

  constructor(private readonly callbacks: DiagnosticsCallbacks) {}

  schedule(workspaceId: string, overlays: Record<string, string>): void {
    this.cancel();
    const revision = this.revision;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = { revision, workspaceId, overlays };
      void this.run();
    }, 500);
  }

  cancel(): void {
    this.revision += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.setChecking(false);
    if (this.running && !this.cancellationRequested) {
      this.cancellationRequested = true;
      this.callbacks.cancel();
    }
  }

  private setChecking(checking: boolean): void {
    if (checking === this.checking) return;
    this.checking = checking;
    this.callbacks.onChecking(checking);
  }

  private async run(): Promise<void> {
    if (this.running || !this.pending) return;
    const request = this.pending;
    this.pending = undefined;
    this.running = true;
    this.cancellationRequested = false;
    this.setChecking(true);
    try {
      const items = await this.callbacks.check(request.workspaceId, request.overlays);
      if (request.revision === this.revision) this.callbacks.onDiagnostics(items);
    } catch (error) {
      if (request.revision === this.revision) this.callbacks.onError(error);
    } finally {
      this.running = false;
      if (request.revision === this.revision) this.setChecking(false);
      void this.run();
    }
  }
}
