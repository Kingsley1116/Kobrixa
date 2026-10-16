import type { LanguageAnalysis } from "../../shared/language-types.js";
import { supportsFile, type LanguageStatus } from "../../shared/language-services.js";
import type { WorkspaceSummary } from "../../shared/api.js";
import type { AnalysisOutcome } from "./analysis-transport.js";
import type { EditorAnalysis } from "./editor.js";
import type { Documents } from "./documents.js";
import { LiveDiagnostics } from "./live-diagnostics.js";

type Snapshot = EditorAnalysis & { workspaceId: string; revision: number };
type Checked = {
  workspaceId: string;
  revision: number;
  epoch: number;
  overlays: Record<string, string>;
  outcome: AnalysisOutcome;
};
type Event = "result" | "invalidate" | "reset" | "failure";
export class AnalysisSession {
  private workspace: WorkspaceSummary | undefined;
  private status: LanguageStatus | undefined;
  private snapshot: Snapshot | undefined;
  private readonly listeners = new Set<(snapshot: Snapshot | undefined, event: Event) => void>();
  private readonly checker: LiveDiagnostics<Checked>;
  constructor(
    private readonly documents: Documents,
    callbacks: {
      analyze(workspaceId: string, overlays: Record<string, string>): Promise<AnalysisOutcome>;
      cancel(): void;
      diagnostics(result: LanguageAnalysis): void;
      unavailable(status: Extract<AnalysisOutcome, { kind: "unavailable" }>): void;
      checking(value: boolean): void;
      error(error: unknown): void;
    },
  ) {
    this.checker = new LiveDiagnostics({
      cancel: callbacks.cancel,
      check: async (workspaceId, overlays) => {
        const revision = documents.revision,
          epoch = this.status?.epoch ?? 0;
        return {
          workspaceId,
          revision,
          epoch,
          overlays,
          outcome: await callbacks.analyze(workspaceId, overlays),
        };
      },
      onDiagnostics: (checked) => {
        if (
          checked.revision !== documents.revision ||
          checked.workspaceId !== this.workspace?.id ||
          checked.epoch !== this.status?.epoch ||
          checked.outcome.epoch !== checked.epoch
        )
          return;
        if (checked.outcome.kind === "unavailable") {
          this.snapshot = undefined;
          this.emit("reset");
          callbacks.unavailable(checked.outcome);
          return;
        }
        if (this.status.availability.kind !== "available") return;
        this.snapshot = {
          workspaceId: checked.workspaceId,
          revision: checked.revision,
          epoch: checked.epoch,
          binding: this.status.availability.binding,
          overlays: checked.overlays,
          analysis: checked.outcome.analysis,
        };
        this.emit("result");
        callbacks.diagnostics(checked.outcome.analysis);
      },
      onChecking: callbacks.checking,
      onError: (error) => {
        this.snapshot = undefined;
        this.emit("failure");
        callbacks.error(error);
      },
    });
  }
  readonly getCurrent = (): Snapshot | undefined =>
    this.snapshot?.revision === this.documents.revision &&
    this.snapshot.epoch === this.status?.epoch
      ? this.snapshot
      : undefined;
  readonly subscribe = (listener: (snapshot: Snapshot | undefined, event: Event) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  attach(): () => void {
    const unsubscribe = this.documents.onChange(() => this.schedule());
    this.schedule();
    return () => {
      unsubscribe();
      this.checker.cancel();
      this.snapshot = undefined;
    };
  }
  configure(workspace: WorkspaceSummary | undefined, status?: LanguageStatus): void {
    const previous = this.workspace,
      previousEpoch = this.status?.epoch;
    this.workspace = workspace;
    this.status = status;
    if (
      previous?.id === workspace?.id &&
      previous?.files === workspace?.files &&
      previous?.drafts === workspace?.drafts &&
      previousEpoch === status?.epoch
    )
      return;
    if (previous?.id !== workspace?.id || previousEpoch !== status?.epoch) {
      this.checker.cancel();
      this.snapshot = undefined;
      this.emit("reset");
    }
    this.schedule();
  }
  private schedule(): void {
    const hadSnapshot = Boolean(this.snapshot);
    this.snapshot = undefined;
    if (hadSnapshot) this.emit("invalidate");
    const availability = this.status?.availability;
    if (!this.workspace || availability?.kind !== "available") {
      this.checker.cancel();
      return;
    }
    const binding = availability.binding;
    this.checker.schedule(this.workspace.id, () =>
      Object.fromEntries([
        ...Object.entries(this.workspace?.drafts ?? {}).filter(([file]) =>
          supportsFile(binding, file),
        ),
        ...this.documents
          .getSnapshot()
          .filter((tab) => supportsFile(binding, tab.file))
          .map((tab) => [tab.file, tab.content]),
      ]),
    );
  }
  private emit(event: Event): void {
    for (const listener of this.listeners) listener(this.getCurrent(), event);
  }
}
