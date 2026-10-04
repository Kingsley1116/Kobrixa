import type { FilePreferences } from "./file-preferences.js";
import type {
  LocalHistoryEntry,
  WorkspaceFileSnapshot,
  WorkspaceRefreshResult,
  WorkspaceWriteResult,
} from "./workspace-files.js";
export type {
  LocalHistoryEntry,
  WorkspaceFileSnapshot,
  WorkspaceRefreshResult,
  WorkspaceWriteResult,
} from "./workspace-files.js";
import type { DevicePreferences } from "./device-preferences.js";
import type { UpdatesApi } from "./updates.js";
import type { CompletionSyncReply, CompletionSyncRequest } from "./completion-sync.js";
import type { BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
import type { LanguageSyncRequest, LanguageSyncReply } from "./language-sync.js";
import type { KeyboardContext } from "./keyboard.js";
import type {
  BuildArtifact,
  BuildProgress,
  CompileResult,
  Diagnostic,
  ProjectManifest,
} from "@kobrixa/compiler";
import type {
  DeviceDescriptor,
  DeviceErrorCategory,
  RemoteEntry,
  DeviceMonitorSnapshot,
  DeviceInputModes,
} from "@kobrixa/device";

export type MonitorResult<T> =
  | { status: "ok"; value: T }
  | { status: "busy" }
  | { status: "error"; category: DeviceErrorCategory; message: string };

export interface WorkspaceSummary {
  id: string;
  name: string;
  rootLabel: string;
  /** Display-only location; filesystem access still uses the registered id. */
  locationLabel?: string;
  files: string[];
  entries: WorkspaceEntry[];
  manifest?: ProjectManifest;
  implicit: boolean;
  entryCandidates: string[];
  drafts: Record<string, string>;
  draftRevisions?: Record<string, string | null>;
}

export interface EditorLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  scrollTop: number;
  scrollLeft: number;
}
export interface WorkspaceView {
  workspaceId: string;
  files: string[];
  activeFile?: string | undefined;
  selectedTreePath: string;
  expandedTreePaths: string[];
  locations: Record<string, EditorLocation>;
}
export interface WorkspaceSessionState {
  projects: WorkspaceView[];
  activeWorkspaceId?: string | undefined;
}
export interface RestoredWorkspaceSession extends WorkspaceSessionState {
  workspaces: WorkspaceSummary[];
  issues: string[];
}

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceMutationResult {
  workspace: WorkspaceSummary;
  moved: Record<string, string>;
  removed: string[];
}

export type BuildEvent =
  | { type: "progress"; workspaceId: string; buildId: string; progress: BuildProgress }
  | { type: "complete"; workspaceId: string; buildId: string; result: CompileResult };

export type RemoteFileRequest = {
  sessionId: string;
  requestId: string;
  action: "list" | "upload" | "download" | "mkdir" | "rename" | "delete";
  path: string;
  name?: string | undefined;
  locale: "en" | "zh-TW";
};
export type RemoteFileResult = {
  sessionId: string;
  requestId: string;
} & (
  | { ok: true; entries?: RemoteEntry[]; cancelled?: boolean }
  | {
      ok: false;
      category: DeviceErrorCategory;
      message: string;
    }
);
export type FileBatchAction = "upload" | "download" | "delete";
export interface FileBatchRequest {
  sessionId: string;
  requestId: string;
  action: FileBatchAction;
  path: string;
  paths: string[];
  source: "files" | "folders";
  locale: "en" | "zh-TW";
}
export interface FileBatchRef {
  sessionId: string;
  requestId: string;
  planId: string;
}
export interface FileBatchItem {
  id: string;
  label: string;
  kind: "file" | "directory";
  size?: number;
  conflict: boolean;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed";
  message?: string;
}
export interface FileBatchSnapshot extends FileBatchRef {
  action: FileBatchAction;
  phase: "checking" | "ready" | "running" | "complete" | "failed" | "stopped" | "cancelled";
  items: FileBatchItem[];
  issues: string[];
  stopRequested: boolean;
  currentId?: string | undefined;
  progress?: { transferred: number; total: number } | undefined;
}
export type DeviceEvent =
  | {
      type: "usb-recovery";
      state: "waiting" | "connecting" | "cancelled" | "unavailable" | "exhausted";
      previousSessionId: string;
      descriptor: DeviceDescriptor;
    }
  | {
      type: "usb-recovery";
      state: "restored";
      previousSessionId: string;
      sessionId: string;
      descriptor: DeviceDescriptor;
      deployment: "verified" | "changed" | "none";
      buildId?: string;
    }
  | { type: "file-batch"; snapshot: FileBatchSnapshot }
  | { type: "files-changed"; sessionId: string; requestId: string; paths: string[] }
  | {
      type: "file-progress";
      sessionId: string;
      requestId: string;
      transferred: number;
      total: number;
    }
  | {
      type: "state";
      state: "disconnected" | "connecting" | "connected" | "busy" | "error";
      sessionId?: string;
      message?: string;
      transport?: string;
    }
  | { type: "error"; category: DeviceErrorCategory; message: string; recoverable: boolean };

export interface KobrixaApi {
  updates: UpdatesApi;
  keyboard: { updateContext(context: KeyboardContext): Promise<void> };
  workspace: {
    getPreferences(): Promise<FilePreferences>;
    setPreferences(patch: Partial<FilePreferences>): Promise<FilePreferences>;
    restoreSession(): Promise<RestoredWorkspaceSession>;
    saveSession(state: WorkspaceSessionState): Promise<void>;
    close(workspaceId: string): Promise<void>;
    onBeforeClose(listener: (requestId: string) => void): () => void;
    finishClose(requestId: string, ready: boolean): Promise<void>;
    open(): Promise<WorkspaceSummary | undefined>;
    create(name: string): Promise<WorkspaceSummary | undefined>;
    selectEntry(workspaceId: string, entry: string): Promise<WorkspaceSummary>;
    read(workspaceId: string, file: string): Promise<string>;
    readFile(workspaceId: string, file: string): Promise<WorkspaceFileSnapshot>;
    refresh(
      workspaceId: string,
      known: Record<string, string | null>,
    ): Promise<WorkspaceRefreshResult>;
    write(
      workspaceId: string,
      file: string,
      content: string,
      expectedRevision: string | null,
    ): Promise<WorkspaceWriteResult>;
    history(workspaceId: string, file: string): Promise<LocalHistoryEntry[]>;
    historyContent(workspaceId: string, file: string, entryId: string): Promise<string>;
    saveDraft(
      workspaceId: string,
      file: string,
      content: string | undefined,
      baseRevision?: string | null,
    ): Promise<void>;
    createEntry(
      workspaceId: string,
      parent: string,
      kind: WorkspaceEntry["kind"],
      name: string,
    ): Promise<WorkspaceMutationResult>;
    moveEntry(
      workspaceId: string,
      source: string,
      target: string,
    ): Promise<WorkspaceMutationResult>;
    trashEntry(workspaceId: string, entry: string): Promise<WorkspaceMutationResult>;
  };
  build: {
    start(workspaceId: string, overlays: Record<string, string>): Promise<string>;
    cancel(buildId: string): Promise<void>;
    artifacts(buildId: string): Promise<BuildArtifact[]>;
    onEvent(listener: (event: BuildEvent) => void): () => void;
  };
  language: {
    completionSync(
      workspaceId: string,
      request: CompletionSyncRequest,
    ): Promise<CompletionSyncReply>;
    sync(workspaceId: string, request: LanguageSyncRequest): Promise<LanguageSyncReply>;
    analyze(
      workspaceId: string,
      overlays: Record<string, string>,
    ): Promise<BasicPlusProjectAnalysis>;
    cancel(): Promise<void>;
    diagnostics(workspaceId: string, overlays: Record<string, string>): Promise<Diagnostic[]>;
  };
  device: {
    monitor(sessionId: string): Promise<MonitorResult<DeviceMonitorSnapshot>>;
    inputModes(
      sessionId: string,
      port: number,
      expectedType: number,
    ): Promise<MonitorResult<DeviceInputModes>>;
    setInputMode(
      sessionId: string,
      port: number,
      expectedType: number,
      mode: number,
    ): Promise<MonitorResult<DeviceMonitorSnapshot>>;
    getPreferences(): Promise<DevicePreferences>;
    setPreferences(patch: Partial<DevicePreferences>): Promise<DevicePreferences>;
    files(request: RemoteFileRequest): Promise<RemoteFileResult>;
    prepareFiles(request: FileBatchRequest): Promise<FileBatchSnapshot>;
    executeFiles(ref: FileBatchRef, policy: "skip" | "replace"): Promise<FileBatchSnapshot>;
    stopFiles(ref: FileBatchRef): Promise<void>;
    discover(): Promise<DeviceDescriptor[]>;
    connect(descriptor: DeviceDescriptor): Promise<string>;
    connectWifi(address: string): Promise<string>;
    disconnect(sessionId: string): Promise<void>;
    upload(sessionId: string, buildId: string, remotePath: string): Promise<void>;
    deploy(sessionId: string, buildId: string, remoteDirectory: string): Promise<void>;
    run(sessionId: string, remotePath: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
    delete(sessionId: string, remotePath: string): Promise<void>;
    onEvent(listener: (event: DeviceEvent) => void): () => void;
  };
}

export type { BuildArtifact, CompileResult, Diagnostic, DeviceDescriptor, RemoteEntry };
export type {
  DeviceMonitorSnapshot,
  DeviceInputModes,
  MonitorInput,
  MonitorOutput,
} from "@kobrixa/device";
