import type { WorkspaceSummary, WorkspaceView, WorkspaceSessionState } from "../../shared/api.js";
import { Documents } from "../editor/documents.js";
import { EditorModels } from "../editor/editor-models.js";

export class ProjectSession {
  readonly documents = new Documents();
  readonly editor: EditorModels;
  view: WorkspaceView;
  unsubscribe: () => void = () => {};
  constructor(
    public workspace: WorkspaceSummary,
    view?: WorkspaceView,
  ) {
    this.view = view ?? {
      workspaceId: workspace.id,
      files: [],
      selectedTreePath: "",
      expandedTreePaths: [""],
      locations: {},
    };
    this.editor = new EditorModels(this.view.locations);
  }
  get dirty(): boolean {
    return (
      this.documents.getSnapshot().some((tab) => tab.dirty) ||
      Object.keys(this.workspace.drafts).length > 0
    );
  }
  snapshot(): WorkspaceView {
    return {
      ...this.view,
      files: [...this.documents.getOpenFiles()],
      locations: { ...this.editor.locations },
    };
  }
}

export class ProjectSessions {
  private projects: ProjectSession[] = [];
  private listeners = new Set<() => void>();
  activeId: string | undefined;
  get active(): ProjectSession | undefined {
    return this.get(this.activeId);
  }
  get(id: string | undefined): ProjectSession | undefined {
    return this.projects.find((item) => item.workspace.id === id);
  }
  readonly getSnapshot = () => this.projects;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  changed(): void {
    this.projects = [...this.projects];
    for (const listener of this.listeners) listener();
  }
  add(workspace: WorkspaceSummary, view?: WorkspaceView): ProjectSession {
    const existing = this.get(workspace.id);
    if (existing) return existing;
    const session = new ProjectSession(workspace, view);
    session.unsubscribe = session.documents.subscribe(() => this.changed());
    this.projects.push(session);
    this.changed();
    return session;
  }
  activate(id: string | undefined): void {
    if (id !== undefined && !this.get(id)) throw new Error("Project is not open.");
    this.activeId = id;
    this.changed();
  }
  nextAfterClose(id: string): string | undefined {
    if (id !== this.activeId) return this.activeId;
    const index = this.projects.findIndex((item) => item.workspace.id === id);
    return (this.projects[index + 1] ?? this.projects[index - 1])?.workspace.id;
  }
  remove(id: string): void {
    const session = this.get(id);
    if (!session) return;
    const next = this.nextAfterClose(id);
    session.unsubscribe();
    // Unbind before destroying retained models, including inactive projects.
    for (const file of session.documents.getOpenFiles()) session.documents.unbind(file);
    session.editor.dispose();
    this.projects = this.projects.filter((item) => item !== session);
    this.activeId = next;
    this.changed();
  }
  snapshot(): WorkspaceSessionState {
    return {
      projects: this.projects.map((item) => item.snapshot()),
      ...(this.activeId ? { activeWorkspaceId: this.activeId } : {}),
    };
  }
}
