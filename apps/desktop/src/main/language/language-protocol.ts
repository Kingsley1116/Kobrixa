import type { AnalysisPatch, LanguageSyncRequest } from "../../shared/language-sync.js";
import type { WorkspaceProjectInput } from "../workspace/workspace.js";

export interface DiagnosticsRequest {
  id: number;
  input: WorkspaceProjectInput;
  sync: LanguageSyncRequest;
  workspaceId: string;
  cancellation: SharedArrayBuffer;
}

export type DiagnosticsReply =
  { id: number; ok: true; patch: AnalysisPatch } | { id: number; ok: false; error: string };
