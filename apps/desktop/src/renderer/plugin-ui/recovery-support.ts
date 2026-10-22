import type { Text } from "@kobrixa/plugin-protocol";
export const translated = (text: Text, locale: "en" | "zh-TW"): string =>
  locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;
export type UiLabels = {
  tools: string;
  open: string;
  close: string;
  empty: string;
  unavailable: string;
  loading: string;
  invalid: string;
  recovery: string;
  refresh: string;
  reset: string;
  previous: string;
  next: string;
  retry: string;
  export: string;
  discard: string;
  checkpoint: string;
  holdHint: string;
  actions: Record<"stop" | "reconcile" | "clear-resolved" | "retry-save" | "manage", string>;
};
const viewTimers = new WeakMap<object, () => number>();
export function registerRecoveryDiagnostics(instance: object, timers: () => number): void {
  viewTimers.set(instance, timers);
}
export function recoveryTimers(instance: object): (() => number) | undefined {
  return viewTimers.get(instance);
}
