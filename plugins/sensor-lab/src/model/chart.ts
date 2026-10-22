import { immutableSnapshot, LIMITS, requireModel } from "./data.js";

export interface Point {
  time: number;
  value: number | null;
  status?: string;
  segment?: number;
  gap?: boolean;
}
export interface Run {
  index: number;
  points: Point[];
}
export interface ReducedSeries {
  runs: Run[];
  pointCount: number;
  omittedRuns: Array<{ index: number; from: number; to: number; pointCount: number }>;
  omittedPoints: number;
  fullPointCount: number;
  range: [number, number];
  extrema: { minimum: Point; maximum: Point } | null;
}
/** Range calculation uses full data and avoids overflow for extreme finite numbers. */
export function finiteRange(values: readonly number[]): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (const value of values)
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  if (min === Infinity) return [0, 1];
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.05);
    return [Math.max(-Number.MAX_VALUE, min - pad), Math.min(Number.MAX_VALUE, max + pad)];
  }
  return [min, max];
}
function valid(p: Point): boolean {
  return (
    Number.isFinite(p.time) &&
    p.value !== null &&
    Number.isFinite(p.value) &&
    (p.status === undefined || p.status === "ok")
  );
}
function runsFor(points: readonly Point[]): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;
  let previous: Point | undefined;
  for (const point of points) {
    if (!valid(point)) {
      current = undefined;
      previous = undefined;
      continue;
    }
    if (
      !current ||
      point.gap ||
      !previous ||
      point.segment !== previous.segment ||
      point.time < previous.time ||
      point.time - previous.time > 2000
    ) {
      current = { index: runs.length, points: [] };
      runs.push(current);
    }
    current.points.push(point);
    previous = point;
  }
  return runs;
}
/** Each output run is independently drawable; no separator points consume the budget. */
export function reduceSeries(
  points: readonly Point[],
  maximum: number = LIMITS.pointsPerSeries,
): ReducedSeries {
  requireModel(
    Number.isInteger(maximum) && maximum >= 2 && maximum <= LIMITS.pointsPerSeries,
    "budget",
  );
  const runs = runsFor(points);
  const all = runs.flatMap((r) => r.points);
  let minimum: Point | undefined, maximumPoint: Point | undefined;
  for (const point of all) {
    if (!minimum || point.value! < minimum.value!) minimum = point;
    if (!maximumPoint || point.value! > maximumPoint.value!) maximumPoint = point;
  }
  const selected = new Map<number, Set<number>>();
  let count = 0;
  const add = (r: Run, i: number) => {
    let indices = selected.get(r.index);
    if (!indices) {
      indices = new Set();
      selected.set(r.index, indices);
    }
    if (!indices.has(i) && count < maximum) {
      indices.add(i);
      count++;
    }
  };
  // Global extrema take priority even when runs outnumber the display budget.
  for (const point of [minimum, maximumPoint])
    if (point) {
      const run = runs.find((r) => r.points.includes(point))!;
      add(run, run.points.indexOf(point));
    }
  // Represent as many runs as possible, then preserve endpoints where budget permits.
  for (const run of runs) {
    if (count === maximum) break;
    add(run, 0);
  }
  for (const run of runs) {
    if (count === maximum) break;
    add(run, run.points.length - 1);
  }
  // Ordered per-run min/max buckets; selection is sorted below, never by value.
  const remaining = maximum - count;
  const total = runs.reduce((n, r) => n + r.points.length, 0);
  for (const run of runs) {
    if (count === maximum) break;
    const buckets = Math.max(
      1,
      Math.floor((remaining * run.points.length) / Math.max(1, total) / 2),
    );
    const size = Math.ceil(run.points.length / buckets);
    for (let start = 0; start < run.points.length && count < maximum; start += size) {
      let lo = start,
        hi = start;
      for (let i = start; i < Math.min(start + size, run.points.length); i++) {
        if (run.points[i]!.value! < run.points[lo]!.value!) lo = i;
        if (run.points[i]!.value! > run.points[hi]!.value!) hi = i;
      }
      add(run, lo);
      add(run, hi);
    }
  }
  // Use spare capacity deterministically, including flat buckets with identical extrema.
  for (const run of runs)
    for (let i = 0; i < run.points.length && count < maximum; i++) add(run, i);
  const displayed = runs
    .filter((r) => selected.has(r.index))
    .map((r) => ({
      index: r.index,
      points: [...selected.get(r.index)!].sort((a, b) => a - b).map((i) => r.points[i]!),
    }));
  return immutableSnapshot({
    runs: displayed,
    pointCount: count,
    omittedRuns: runs
      .filter((r) => !selected.has(r.index))
      .map((r) => ({
        index: r.index,
        from: r.points[0]!.time,
        to: r.points.at(-1)!.time,
        pointCount: r.points.length,
      })),
    omittedPoints: all.length - count,
    fullPointCount: all.length,
    range: finiteRange(all.map((p) => p.value!)),
    extrema: minimum && maximumPoint ? { minimum, maximum: maximumPoint } : null,
  });
}
export function reduceCharts(charts: readonly (readonly (readonly Point[])[])[]): {
  charts: ReducedSeries[][];
  pointCount: number;
} {
  requireModel(
    charts.length <= LIMITS.charts && charts.every((c) => c.length <= LIMITS.seriesPerChart),
    "charts",
    "limit",
  );
  const result = charts.map((chart) => chart.map((points) => reduceSeries(points)));
  const pointCount = result.flat().reduce((n, s) => n + s.pointCount, 0);
  requireModel(pointCount <= LIMITS.totalPoints, "display", "limit");
  return { charts: result, pointCount };
}
/** Nearest original sample, including missing/error readings; ties retain input order. */
export function cursorReading(points: readonly Point[], time: number): Point | undefined {
  if (!Number.isFinite(time)) return undefined;
  let nearest: Point | undefined;
  for (const point of points)
    if (
      Number.isFinite(point.time) &&
      (!nearest || Math.abs(point.time - time) < Math.abs(nearest.time - time))
    )
      nearest = point;
  return nearest ? immutableSnapshot(nearest) : undefined;
}
