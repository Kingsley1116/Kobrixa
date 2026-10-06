import type { BuildProgress, CompileResult, SourceProject } from "@kobrixa/compiler";

export interface BuildRequest {
  project: SourceProject;
  cancellation: SharedArrayBuffer;
}

export type BuildReply =
  { type: "progress"; progress: BuildProgress } | { type: "complete"; result: CompileResult };
