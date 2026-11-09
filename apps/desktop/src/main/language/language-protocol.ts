import type { LanguageBinding } from "../../shared/language-services.js";
import type { LanguageFeatureRequest, LanguageFeatureReply } from "../../shared/language-query.js";
import type { LanguageSyncReply, LanguageSyncRequest } from "../../shared/language-sync.js";
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
  epoch: number;
  result: QuickFixReply;
};

export interface DiagnosticsRequest {
  binding: LanguageBinding;
  id: number;
  input: WorkspaceProjectInput;
  sync: LanguageSyncRequest;
  workspaceId: string;
  cancellation: SharedArrayBuffer;
}

export type DiagnosticsReply =
  | { id: number; epoch: number; ok: true; reply: LanguageSyncReply }
  | { id: number; epoch: number; ok: false; error: string };

export interface FeatureWorkerRequest {
  kind: "feature";
  id: number;
  workspaceId: string;
  request: LanguageFeatureRequest;
  cancellation: SharedArrayBuffer;
}
export interface FeatureWorkerReply {
  kind: "feature";
  id: number;
  epoch: number;
  result: LanguageFeatureReply;
}
