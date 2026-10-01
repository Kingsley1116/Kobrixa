import type { BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
import type { WorkspaceSummary } from "../../shared/api.js";
import type { EditorAnalysis } from "./editor.js";
import type { Documents } from "./documents.js";
import { LiveDiagnostics } from "./live-diagnostics.js";

type Snapshot = EditorAnalysis & { workspaceId: string; revision: number };
type Event = "result" | "invalidate" | "reset" | "failure";
/** Schedules analysis from document changes, without going through React. */
export class AnalysisSession {
  private workspace: WorkspaceSummary | undefined;
  private snapshot: Snapshot | undefined;
  private readonly listeners = new Set<(snapshot: Snapshot | undefined, event: Event) => void>();
  private readonly checker: LiveDiagnostics<Snapshot>;
  constructor(
    private readonly documents: Documents,
    callbacks: {
      analyze(
        workspaceId: string,
        overlays: Record<string, string>,
      ): Promise<BasicPlusProjectAnalysis>;
      cancel(): void;
      diagnostics(result: BasicPlusProjectAnalysis): void;
      checking(value: boolean): void;
      error(error: unknown): void;
    },
  ) {
    this.checker = new LiveDiagnostics({
      cancel: callbacks.cancel,
      check: async (workspaceId, overlays) => {
        const revision = documents.revision;
        return {
          workspaceId,
          revision,
          overlays,
          analysis: await callbacks.analyze(workspaceId, overlays),
        };
      },
      onDiagnostics: (snapshot) => {
        if (snapshot.revision !== documents.revision || snapshot.workspaceId !== this.workspace?.id)
          return;
        this.snapshot = snapshot;
        this.emit("result");
        callbacks.diagnostics(snapshot.analysis);
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
    this.snapshot?.revision === this.documents.revision ? this.snapshot : undefined;
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
  configure(workspace: WorkspaceSummary | undefined): void {
    const previous = this.workspace;
    this.workspace = workspace;
    if (
      previous?.id === workspace?.id &&
      previous?.files === workspace?.files &&
      previous?.drafts === workspace?.drafts
    )
      return;
    if (previous?.id !== workspace?.id) {
      this.snapshot = undefined;
      this.emit("reset");
    }
    this.schedule();
  }
  private schedule(): void {
    const hadSnapshot = Boolean(this.snapshot);
    this.snapshot = undefined;
    if (hadSnapshot) this.emit("invalidate");
    if (!this.workspace) {
      this.checker.cancel();
      return;
    }
    this.checker.schedule(this.workspace.id, () =>
      Object.fromEntries([
        ...Object.entries(this.workspace?.drafts ?? {}).filter(([file]) =>
          /\.(bp|bpi|bpm)$/i.test(file),
        ),
        ...this.documents
          .getSnapshot()
          .filter((tab) => /\.(bp|bpi|bpm)$/i.test(tab.file))
          .map((tab) => [tab.file, tab.content]),
      ]),
    );
  }
  private emit(event: Event): void {
    for (const listener of this.listeners) listener(this.getCurrent(), event);
  }
}
