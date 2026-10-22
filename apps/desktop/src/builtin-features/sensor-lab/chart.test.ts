import { expect, it } from "vitest";
import {
  reduceSeries,
  reduceCharts,
  cursorReading,
  finiteRange,
} from "../../../../../plugins/sensor-lab/src/model/chart.js";
it("splits before reduction, retains gap-adjacent spikes and never mutates samples", () => {
  const points = Array.from({ length: 3600 }, (_, i) => ({
    time: i * 100,
    value: i === 400 ? null : i === 401 ? 1000 : i === 399 ? -100 : 1,
    segment: i < 1800 ? 0 : 1,
  }));
  const before = JSON.stringify(points);
  const r = reduceSeries(points);
  expect(r.pointCount).toBeLessThanOrEqual(800);
  expect(r.runs).toHaveLength(3);
  expect(r.runs.flatMap((x) => x.points).some((p) => p.value === 1000)).toBe(true);
  expect(r.range).toEqual([-100, 1000]);
  expect(JSON.stringify(points)).toBe(before);
  expect(cursorReading(points, 40100)?.value).toBe(1000);
  expect(cursorReading(points, 40000)?.value).toBeNull();
});
it("reports omitted isolated runs, retains global extrema, enforces 4 by 2 budgets", () => {
  const points = Array.from({ length: 3600 }, (_, i) => ({
    time: i * 3000,
    value: i === 3599 ? -100 : i === 3000 ? 1000 : 1,
  }));
  const r = reduceSeries(points);
  expect(r.pointCount).toBe(800);
  expect(r.omittedRuns.length).toBe(2800);
  expect(r.runs.every((run) => run.points.length === 1)).toBe(true);
  expect(r.runs.flatMap((run) => run.points).map((p) => p.value)).toContain(-100);
  expect(r.runs.flatMap((run) => run.points).map((p) => p.value)).toContain(1000);
  const charts = reduceCharts(Array.from({ length: 4 }, () => [points, points]));
  expect(charts.pointCount).toBe(6400);
  expect(() => reduceCharts(Array.from({ length: 5 }, () => [points]))).toThrow();
  expect(() => reduceCharts([[points, points, points]])).toThrow();
});
it("splits explicit gaps, bad status, backwards time and keeps finite ranges", () => {
  const r = reduceSeries([
    { time: 0, value: 1 },
    { time: 1, value: 2, gap: true },
    { time: 2, value: 3, status: "busy" },
    { time: 3, value: 4 },
    { time: 2, value: 5 },
  ]);
  expect(r.runs).toHaveLength(4);
  for (const values of [[], [0, 0], [-Number.MAX_VALUE, Number.MAX_VALUE], [NaN, Infinity]]) {
    const range = finiteRange(values);
    expect(range.every(Number.isFinite)).toBe(true);
    expect(range[1]).toBeGreaterThan(range[0]);
  }
});

it("retains extrema on either side of bucket boundaries and reports partial reduction", () => {
  const points = Array.from({ length: 1600 }, (_, i) => ({
    time: i * 10,
    value: i === 799 ? -999 : i === 800 ? null : i === 801 ? 999 : 0,
  }));
  const result = reduceSeries(points, 8);
  expect(result.runs).toHaveLength(2);
  expect(result.pointCount).toBeLessThanOrEqual(8);
  expect(result.extrema?.minimum.value).toBe(-999);
  expect(result.extrema?.maximum.value).toBe(999);
  expect(result.runs.flatMap((r) => r.points).map((p) => p.value)).toEqual(
    expect.arrayContaining([-999, 999]),
  );
  expect(result.omittedPoints).toBe(result.fullPointCount - result.pointCount);
  expect(() => reduceSeries(points, 801)).toThrow(/budget/);
  expect(
    cursorReading(
      [
        { time: 2, value: 1 },
        { time: 4, value: 2 },
      ],
      3,
    )?.time,
  ).toBe(2);
  expect(cursorReading(points, NaN)).toBeUndefined();
});
