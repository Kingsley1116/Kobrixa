import type { AnalysisPatch, LanguageSyncRequest } from "../../shared/language-sync.js";
import type { WorkspaceProjectInput } from "../workspace/workspace.js";
import type { QuickFixReply, QuickFixRequest } from "../../shared/quick-fixes.js";

export interface QuickFixWorkerRequest {
  kind: "quick-fixes";
  id: number;
  workspaceId: string;
  request: QuickFixRequest;
  cancellation: SharedArrayBuffer;
}
export type QuickFixWorkerReply = {
  kind: "quick-fixes";
  id: number;
  result: QuickFixReply;
};

export interface DiagnosticsRequest {
  id: number;
  input: WorkspaceProjectInput;
  sync: LanguageSyncRequest;
  workspaceId: string;
  cancellation: SharedArrayBuffer;
}

export type DiagnosticsReply =
  { id: number; ok: true; patch: AnalysisPatch } | { id: number; ok: false; error: string };
