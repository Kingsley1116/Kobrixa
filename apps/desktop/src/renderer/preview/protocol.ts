import type { KobrixaIR } from "@kobrixa/ir";
import type { PreviewSnapshot } from "../../preview/runtime.js";
import type { PreviewInputs } from "../../preview/virtual-device.js";

export type PreviewCommand =
  | { type: "load"; ir: KobrixaIR; files?: Record<string, number[]>; inputs?: PreviewInputs }
  | { type: "run" | "pause" | "step" | "stop" }
  | { type: "speed"; value: number }
  | { type: "inputs"; inputs: PreviewInputs };
export type PreviewResponse =
  { type: "snapshot"; snapshot: PreviewSnapshot } | { type: "error"; message: string };

export const previewSpeeds = [0.25, 0.5, 1, 2, 4] as const;
