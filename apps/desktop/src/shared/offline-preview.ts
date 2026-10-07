import type { KobrixaIR } from "@kobrixa/ir";

/** Immutable compiler output and resource bytes; no renderer-selected host paths. */
export interface OfflinePreviewProgram {
  ir: KobrixaIR;
  files: Record<string, number[]>;
}

export const PREVIEW_MAX_FILES = 64;
export const PREVIEW_MAX_FILE_BYTES = 1024 * 1024;
