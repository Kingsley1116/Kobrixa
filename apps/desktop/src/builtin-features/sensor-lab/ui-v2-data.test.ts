import { describe, expect, it } from "vitest";
import { reduceSeries, type Point } from "../../../../../plugins/sensor-lab/src/model/chart.js";
import {
  validateDatasetV2,
  canonicalDatasetV2Bytes,
  effectiveTimeDomainV2,
  type ChartHeaderV2,
  type DatasetPointV2,
} from "../../../../../packages/plugin-protocol/src/ui-v2-data.js";

// Contract parity only: actual reducer output mapped to the proposed wire shape.
// This does not exercise the future Lab process adapter or renderer.
function wire(points: Point[], end: number) {
  const reduced = reduceSeries(points);
  const declaration = {
    kind: "chart" as const,
    series: [{ id: "sensor", label: { en: "Sensor" } }],
  };
  const header: ChartHeaderV2 = {
    kind: "chart",
    timeDomain: [0, end],
    view: "recent60s",
    series: [
      {
        id: "sensor",
        unit: "deg",
        range: reduced.range,
        extrema: reduced.extrema
          ? [
              [reduced.extrema.minimum.time, reduced.extrema.minimum.value!],
              [reduced.extrema.maximum.time, reduced.extrema.maximum.value!],
            ]
          : null,
        fullPointCount: reduced.fullPointCount,
        omittedPoints: reduced.omittedPoints,
        omittedRuns: reduced.omittedRuns.length,
      },
    ],
  };
  const entries: DatasetPointV2[] = reduced.runs.flatMap((run) =>
    run.points.map((point) => [0, run.index, point.time, point.value!] as DatasetPointV2),
  );
  return { declaration, header, entries, reduced };
}
describe("UI v2 data contract with the actual pure Lab reducer", () => {
  it.each([false, true])("preserves full extrema and omitted runs, isolated=%s", (isolated) => {
    const points = Array.from({ length: 3600 }, (_, i) => ({
      time: i * (isolated ? 3000 : 100),
      value: i === 3599 ? -100 : i === 3000 ? 1000 : 1,
    }));
    const { declaration, header, entries, reduced } = wire(points, points.at(-1)!.time);
    expect(validateDatasetV2(declaration, header, entries).entries).toHaveLength(800);
    expect(header.series[0]!.omittedPoints).toBe(2800);
    expect(header.series[0]!.omittedRuns).toBe(isolated ? 2800 : 0);
    expect(entries.some((p) => p[2] === reduced.extrema!.minimum.time && p[3] === -100)).toBe(true);
    expect(entries.some((p) => p[2] === reduced.extrema!.maximum.time && p[3] === 1000)).toBe(true);
    expect(canonicalDatasetV2Bytes(header, entries).byteLength).toBeLessThan(524288);
  });
  it("retains null/error gaps and the trailing empty time span", () => {
    const { declaration, header, entries } = wire(
      [
        { time: 0, value: 1 },
        { time: 100, value: null },
        { time: 200, value: 2 },
        { time: 300, value: 99, status: "error" },
        { time: 400, value: 3 },
        { time: 90000, value: null },
      ],
      90000,
    );
    expect(validateDatasetV2(declaration, header, entries).entries).toEqual([
      [0, 0, 0, 1],
      [0, 1, 200, 2],
      [0, 2, 400, 3],
    ]);
    expect(effectiveTimeDomainV2(header)).toEqual([30000, 90000]);
  });
  it("keeps an empty series with a non-empty time domain", () => {
    const { declaration, header, entries } = wire(
      [
        { time: 0, value: null },
        { time: 120000, value: 3, status: "error" },
      ],
      120000,
    );
    expect(validateDatasetV2(declaration, header, entries).entries).toEqual([]);
    expect(header.series[0]!.extrema).toBeNull();
    expect(effectiveTimeDomainV2(header)).toEqual([60000, 120000]);
  });
  it("does not join decreasing timestamps across reducer runs", () => {
    const { declaration, header, entries } = wire(
      [
        { time: 100, value: 1 },
        { time: 200, value: 2 },
        { time: 100, value: 3 },
        { time: 200, value: 4 },
      ],
      1000,
    );
    expect(validateDatasetV2(declaration, header, entries).entries).toEqual([
      [0, 0, 100, 1],
      [0, 0, 200, 2],
      [0, 1, 100, 3],
      [0, 1, 200, 4],
    ]);
  });
});
