import { describe, expect, it } from "vitest";
import { reduceChartPoints, sensorChartGeometry } from "./sensor-lab-chart.js";

describe("sensor curve geometry", () => {
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
