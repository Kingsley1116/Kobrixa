/** A process-wide monotonic timestamp shared by main and Node worker threads. */
export function hrtimeMilliseconds(): number {
  const ns = process.hrtime.bigint();
  return Number(ns / 1000000n) + Number(ns % 1000000n) / 1000000;
}

export type PersistenceClockKind = "node-performance" | "hrtime";

export const nodePerformanceMilliseconds = () => performance.now();

export function persistenceClock(kind: PersistenceClockKind) {
  return kind === "hrtime" ? hrtimeMilliseconds : nodePerformanceMilliseconds;
}

/** The foundation creates the external, absolute lifecycle and device offers. */
export function realWorkerFoundation<T extends { now: () => number }>(
  options: T,
  kind: PersistenceClockKind = "node-performance",
) {
  return { ...options, now: persistenceClock(kind) };
}
