import type { WorkspaceSummary } from "../../shared/api.js";
import {
  isSearchableFile,
  type WorkspaceSearchOptions,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResult,
} from "../../shared/workspace-search.js";
import type { Documents } from "../editor/documents.js";

export interface SearchState {
  options: WorkspaceSearchOptions;
  busy: boolean;
  result?: WorkspaceSearchResult;
  error?: string;
}

/** One request at a time; edits invalidate results before the debounced scan starts. */
export class SearchController {
  private state: SearchState = {
    options: { query: "", caseSensitive: false, wholeWord: false },
    busy: false,
  };
  private listeners = new Set<() => void>();
  private workspace: WorkspaceSummary | undefined;
  private active = false;
  private disposed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private pending = false;
  private detach: (() => void) | undefined;

  constructor(
    private readonly documents: Documents,
    private readonly search: (
      workspaceId: string,
      request: WorkspaceSearchRequest,
    ) => Promise<WorkspaceSearchResult>,
  ) {}
  attach(): () => void {
    this.disposed = false;
    this.detach?.();
    this.detach = this.documents.onChange(() => {
      if (this.active && this.state.options.query) this.refresh();
    });
    this.refresh();
    return () => this.dispose();
  }
  readonly getSnapshot = (): SearchState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: SearchState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  configure(workspace: WorkspaceSummary, active: boolean): void {
    if (workspace === this.workspace && active === this.active) return;
    this.workspace = workspace;
    this.active = active;
    this.refresh();
  }
  setOptions(patch: Partial<WorkspaceSearchOptions>): void {
    this.state = { ...this.state, options: { ...this.state.options, ...patch } };
    this.refresh();
  }
  refresh = (delay = 250): void => {
    if (this.disposed) return;
    this.generation++;
    clearTimeout(this.timer);
    this.pending = false;
    const busy = this.active && !!this.workspace && this.state.options.query.length > 0;
    this.publish({ options: this.state.options, busy });
    if (busy) this.timer = setTimeout(() => void this.run(), delay);
  };
  private async run(): Promise<void> {
    if (this.disposed || !this.active || !this.workspace || !this.state.options.query) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    const generation = this.generation;
    const workspace = this.workspace;
    const overlays: Record<string, string> = Object.fromEntries(
      Object.entries(workspace.drafts).filter(([file]) => isSearchableFile(file)),
    );
    for (const tab of this.documents.getSnapshot())
      if (isSearchableFile(tab.file)) overlays[tab.file] = tab.content;
    this.inFlight = true;
    try {
      const result = await this.search(workspace.id, { ...this.state.options, overlays });
      if (!this.disposed && generation === this.generation)
        this.publish({ options: this.state.options, busy: false, result });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.publish({
          options: this.state.options,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      this.inFlight = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        void this.run();
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.detach?.();
    this.detach = undefined;
  }
}
