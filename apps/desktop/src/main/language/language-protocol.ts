import type { Diagnostic } from "@kobrixa/compiler";
import type { WorkspaceProjectInput } from "../workspace/workspace.js";

export interface DiagnosticsRequest {
  id: number;
  input: WorkspaceProjectInput;
  overlays: Record<string, string>;
}

export type DiagnosticsReply =
  { id: number; ok: true; diagnostics: Diagnostic[] } | { id: number; ok: false; error: string };
