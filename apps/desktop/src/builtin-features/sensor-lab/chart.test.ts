import { describe, expect, it } from "vitest";
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
  // Legacy sensor-lab-panel.tsx nearestChartValue uses <=: later INPUT wins ties.
  expect(
    cursorReading(
      [
        { time: 2, value: 1 },
        { time: 4, value: 2 },
      ],
      3,
    )?.time,
  ).toBe(4);
  expect(cursorReading(points, NaN)).toBeUndefined();
});

it("returns immutable original cursor points without skipping null/error readings", () => {
  const points = [
    { time: 0, value: 7 },
    { time: 100, value: null, status: "error", segment: 2, gap: true },
  ];
  const before = structuredClone(points);
  const reading = cursorReading(points, 90);
  expect(reading).toEqual(points[1]);
  expect(reading).not.toBe(points[1]);
  expect(Object.isFrozen(reading)).toBe(true);
  expect(points).toEqual(before);
  points[1]!.status = "ok";
  expect(reading?.status).toBe("error");
});

it("rejects invalid cursor times and ignores nonfinite sample times", () => {
  const points = [
    { time: NaN, value: 1 },
    { time: Infinity, value: 2 },
    { time: -Infinity, value: 3 },
  ];
  expect(cursorReading([], 0)).toBeUndefined();
  expect(cursorReading(points, 0)).toBeUndefined();
  expect(cursorReading([...points, { time: 0, value: 4 }], 0)?.value).toBe(4);
  for (const time of [NaN, Infinity, -Infinity])
    expect(cursorReading([{ time: 0, value: 4 }], time)).toBeUndefined();
  expect(cursorReading([{ time: -Number.MAX_VALUE, value: 4 }], Number.MAX_VALUE)).toBeUndefined();
});

import { reduceChartPoints, sensorChartGeometry } from "./legacy-oracle.js";
// Transferred baseline assertions: f822f3c renderer/device/sensor-lab-chart.test.ts.
describe("frozen f822f3c sensor curve geometry", () => {
  it("produces finite paths for flat, empty, negative and extreme signals", () => {
    for (const values of [
      [],
      [0, 0],
      [-12, -12],
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [null, NaN, Infinity],
    ]) {
      const result = sensorChartGeometry(
        [{ label: "signal", points: values.map((value, i) => ({ time: i * 500, value })) }],
        [0, 2000],
      );
      expect(result.paths.join("")).not.toMatch(/NaN|Infinity/);
      expect(result.range.every(Number.isFinite)).toBe(true);
      expect(result.range[1]).toBeGreaterThan(result.range[0]);
    }
  });
  it("does not connect missing samples or actual time gaps", () => {
    const result = sensorChartGeometry(
      [
        {
          label: "signal",
          points: [
            { time: 0, value: 1 },
            { time: 500, value: 2 },
            { time: 1000, value: null },
            { time: 1500, value: 4 },
            { time: 4500, value: 5 },
          ],
        },
      ],
      [0, 5000],
    );
    expect(result.paths[0]?.match(/M/g)).toHaveLength(3);
    expect(result.paths[0]?.match(/L/g)).toHaveLength(1);
  });
  it("keeps both trials on the same scale and ignores nonfinite times", () => {
    const result = sensorChartGeometry(
      [
        {
          label: "current",
          points: [
            { time: 0, value: 5 },
            { time: NaN, value: 999 },
          ],
        },
        { label: "previous", comparison: true, points: [{ time: 0, value: -25 }] },
      ],
      [0, 1000],
    );
    expect(result.range).toEqual([-25, 5]);
    expect(result.count).toBe(2);
  });
  it("bounds full recordings while retaining spikes and not inventing gaps after reduction", () => {
    const points = Array.from({ length: 3600 }, (_, index) => ({
      time: index * 500,
      value: index === 1800 ? 1000 : 1,
    }));
    const reduced = reduceChartPoints(points);
    expect(reduced.length).toBeLessThanOrEqual(800);
    expect(reduced.some((point) => point.value === 1000)).toBe(true);
    const result = sensorChartGeometry([{ label: "signal", points }], [0, 3600 * 500]);
    expect(result.paths[0]?.match(/M/g)).toHaveLength(1);
    expect((result.paths[0]?.match(/L/g) ?? []).length).toBeLessThanOrEqual(800);
  });
  it("retains missing-data gaps when downsampling", () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({
      time: index * 500,
      value: index === 400 ? null : 1,
    }));
    expect(reduceChartPoints(points).some((point) => point.value === null)).toBe(true);
    expect(
      sensorChartGeometry([{ label: "signal", points }], [0, 500_000]).paths[0]?.match(/M/g),
    ).toHaveLength(2);
  });
});
