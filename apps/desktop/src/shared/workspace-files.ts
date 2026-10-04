import type { WorkspaceSummary } from "./api.js";

/** A missing file has both content and revision set to null. */
export interface WorkspaceFileSnapshot {
  content: string | null;
  revision: string | null;
}

export type WorkspaceWriteResult =
  | { status: "saved"; snapshot: WorkspaceFileSnapshot; warning?: string }
  | { status: "conflict"; snapshot: WorkspaceFileSnapshot };

export interface WorkspaceRefreshResult {
  workspace: WorkspaceSummary;
  /** Any source/manifest/tree change, including unopened dependencies. */
  changed: boolean;
  /** Only requested files whose revision differs from the supplied revision. */
  files: Record<string, WorkspaceFileSnapshot>;
}

export interface LocalHistoryEntry {
  id: string;
  timestamp: number;
  reason: "save" | "external" | "delete";
  size: number;
}
