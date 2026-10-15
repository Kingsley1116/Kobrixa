import type { BuildProgress, CompileResult, SourceProject } from "@kobrixa/compiler";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import type { OfflinePreviewProgram } from "../../shared/offline-preview.js";
import type { SimulationPrepareResult } from "../../shared/simulator.js";

export interface BuildRequest {
  buildId: string;
  project: SourceProject;
  compiler: CompilerSnapshot;
  cancellation: SharedArrayBuffer;
  preview?: boolean;
  simulation?: { entries: string[]; files: Record<string, number[]> };
}

export type BuildReply =
  | { type: "simulation"; result: SimulationPrepareResult }
  | { type: "progress"; progress: BuildProgress }
  | {
      type: "complete";
      result: CompileResult;
      preview?: OfflinePreviewProgram;
      previewError?: string;
    };
