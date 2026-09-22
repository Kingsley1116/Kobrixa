export const LAYOUT_DEFAULTS = {
  filesWidth: 220,
  deviceWidth: 360,
  problemsHeight: 180,
  filesOpen: true,
  deviceOpen: false,
  problemsOpen: false,
} as const;

export const LAYOUT_LIMITS = {
  filesWidth: { min: 176, max: 360 },
  deviceWidth: { min: 320, max: 520 },
  problemsHeight: { min: 112 },
} as const;

export const LAYOUT_STORAGE_KEYS = {
  filesWidth: "kobrixa.layout.filesWidth",
  deviceWidth: "kobrixa.layout.deviceWidth",
  problemsHeight: "kobrixa.layout.problemsHeight",
  filesOpen: "kobrixa.layout.filesOpen",
  deviceOpen: "kobrixa.layout.deviceOpen",
  problemsOpen: "kobrixa.layout.problemsOpen",
} as const;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function readStoredNumber(
  storage: Pick<Storage, "getItem">,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(storage.getItem(key));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function readStoredBoolean(
  storage: Pick<Storage, "getItem">,
  key: string,
  fallback: boolean,
): boolean {
  const value = storage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function activeFileAfterClose(
  files: readonly string[],
  closingFile: string,
  activeFile: string | undefined,
): string | undefined {
  if (closingFile !== activeFile) return activeFile;
  const closingIndex = files.indexOf(closingFile);
  if (closingIndex < 0) return activeFile;
  return files[closingIndex + 1] ?? files[closingIndex - 1];
}

export function activeFileAfterRemoval(
  files: readonly string[],
  activeFile: string | undefined,
  removed: ReadonlySet<string>,
): string | undefined {
  if (!activeFile || !removed.has(activeFile)) return activeFile;
  const activeIndex = files.indexOf(activeFile);
  return (
    files.slice(activeIndex + 1).find((file) => !removed.has(file)) ??
    [...files.slice(0, activeIndex)].reverse().find((file) => !removed.has(file))
  );
}

export type TabCloseDisposition = "close" | "prompt" | "save" | "discard" | "cancel";

export function tabCloseDisposition(
  dirty: boolean,
  choice?: "save" | "discard" | "cancel",
): TabCloseDisposition {
  if (!dirty) return "close";
  return choice ?? "prompt";
}

export function nextDiagnosticIndex(
  length: number,
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (length <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= length) return direction === 1 ? 0 : length - 1;
  return (currentIndex + direction + length) % length;
}
