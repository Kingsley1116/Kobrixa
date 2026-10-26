import { expect, it } from "vitest";
import { validateDatasetV2 } from "@kobrixa/plugin-protocol";
import {
  labCharts,
  labCursorReadings,
} from "../../../../../plugins/sensor-lab/src/presentation.js";
import { recording } from "./data.test.js";
it("keeps a common full time domain including null tails and longer comparison", () => {
  const current = structuredClone(recording());
  current.durationMs = 100000;
  current.frames[0]!.values = [null, null];
  const comparison = { ...recording(), id: "comparison", durationMs: 120000 };
  const output = labCharts({ current, comparison, selected: [], preview: [], calibrated: false });
  expect(output).toHaveLength(4);
  for (const dataset of output) {
    expect(dataset.header.timeDomain).toEqual([0, 120000]);
    expect(dataset.header.view).toBe("full");
    validateDatasetV2(
      {
        kind: "chart",
        series: dataset.header.series.map((s) => ({ id: s.id, label: { en: s.id } })),
      },
      dataset.header,
      dataset.entries,
    );
  }
  expect(output[0]!.header.series[0]!.fullPointCount).toBe(0);
  expect(output[0]!.entries.some((p) => p[0] === 1)).toBe(true);
});
it("live data uses recent view and never overlays history comparison", () => {
  const current = { ...recording(), durationMs: 90000 };
  const comparison = { ...recording(), id: "comparison", durationMs: 120000 };
  const output = labCharts({
    current,
    comparison,
    activeId: current.id,
    selected: [],
    preview: [],
    calibrated: false,
  });
  expect(output[0]!.header.timeDomain).toEqual([0, 90000]);
  expect(output[0]!.header.view).toBe("recent60s");
  expect(output[0]!.entries.every((p) => p[0] === 0)).toBe(true);
});
it("preserves reducer runs, extrema and bounded point metadata for four two-series charts", () => {
  const model = recording();
  const channels = [model.channels[0]!, model.channels[1]!, model.channels[0]!, model.channels[1]!];
  const frames = Array.from({ length: 3600 }, (_, sequence) => ({
    ...model.frames[0]!,
    sequence,
    elapsedMs: sequence * 500,
    sessionElapsedMs: sequence * 500,
    values: [sequence, -sequence, sequence % 7, sequence % 3],
    segment: sequence < 1800 ? 0 : 1,
  }));
  const current = { ...model, channels, frames, frameCount: 3600, durationMs: 1799500 };
  const output = labCharts({
    current,
    comparison: { ...current, id: "other" },
    selected: [],
    preview: [],
    calibrated: false,
  });
  expect(output.reduce((n, d) => n + d.entries.length, 0)).toBeLessThanOrEqual(6400);
  for (const d of output) {
    validateDatasetV2(
      { kind: "chart", series: d.header.series.map((s) => ({ id: s.id, label: { en: s.id } })) },
      d.header,
      d.entries,
    );
    expect(d.header.series.every((s) => s.fullPointCount === 3600)).toBe(true);
    expect(new Set(d.entries.filter((p) => p[0] === 0).map((p) => p[1])).size).toBe(2);
  }
});
it("cursor uses original samples and retains null/error ties rather than interpolating", () => {
  const current = structuredClone(recording());
  current.channels[0]!.calibration.zeroOffset = 2;
  current.frames.push({
    ...current.frames[0]!,
    elapsedMs: 20,
    sessionElapsedMs: 20,
    values: [null, null],
    status: "error",
  });
  current.durationMs = 20;
  current.frameCount = 2;
  const input = { current, selected: [], preview: [], calibrated: true };
  expect(labCursorReadings(input, 10)).toMatchObject({ c0raw: -5, c0value: -7 });
  expect(labCursorReadings(input, 15)).toMatchObject({ c0raw: null, c0value: null });
  expect(Object.values(labCursorReadings(input, 2000)).every((v) => v === null)).toBe(true);
  expect(Object.keys(labCursorReadings(input, 10))).toHaveLength(16);
});
it("empty selected channels still produce valid declared empty datasets", () => {
  for (const d of labCharts({ selected: [], preview: [], calibrated: false })) {
    expect(d.entries).toEqual([]);
    expect(d.header.timeDomain).toEqual([0, 1000]);
    validateDatasetV2(
      { kind: "chart", series: d.header.series.map((s) => ({ id: s.id, label: { en: s.id } })) },
      d.header,
      d.entries,
    );
  }
});
