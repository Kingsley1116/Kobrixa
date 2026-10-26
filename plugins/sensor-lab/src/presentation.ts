import type { ChartHeaderV2, DatasetPointV2 } from "@kobrixa/plugin-protocol";
import { calibrate } from "./model/calibration.js";
import { cursorReading, reduceSeries, type Point } from "./model/chart.js";
import {
  compatible,
  immutableSnapshot,
  LIMITS,
  type CalibratedChannel,
  type Frame,
  type Recording,
} from "./model/data.js";
import { compatibleEv3Sources } from "./ev3-source.js";
export interface LabChartInput {
  selected: readonly CalibratedChannel[];
  preview: readonly Frame[];
  current?: Recording;
  comparison?: Recording;
  activeId?: string;
  calibrated: boolean;
}
export type LabChart = { header: ChartHeaderV2; entries: DatasetPointV2[] };
function sources(input: LabChartInput) {
  const channels = input.current?.channels ?? input.selected;
  const frames = input.current?.frames ?? input.preview;
  if (
    channels.length > LIMITS.channels ||
    frames.length > LIMITS.frames ||
    (input.comparison?.frames.length ?? 0) > LIMITS.frames
  )
    throw new RangeError("Lab chart bounds exceeded");
  const live = !input.current || input.current.id === input.activeId;
  const comparison = live ? undefined : input.comparison;
  const end = Math.max(
    1000,
    input.current?.durationMs ?? frames.at(-1)?.elapsedMs ?? 0,
    comparison?.durationMs ?? 0,
  );
  if (!Number.isFinite(end)) throw new RangeError("Invalid chart duration");
  return { channels, frames, comparison, live, end };
}
function other(
  channel: CalibratedChannel | undefined,
  comparison: Recording | undefined,
  calibrated: boolean,
) {
  if (!channel || !comparison) return -1;
  return comparison.channels.findIndex(
    (candidate) =>
      compatible(channel, candidate, calibrated) ||
      compatibleEv3Sources(channel, candidate, calibrated),
  );
}
function points(
  frames: readonly Frame[],
  channel: CalibratedChannel | undefined,
  index: number,
  calibrated: boolean,
): Point[] {
  if (!channel || index < 0) return [];
  return frames.map((frame) => {
    const raw = frame.status === "ok" ? (frame.values[index] ?? null) : null;
    return {
      time: frame.elapsedMs,
      value: calibrated ? calibrate(raw, channel.calibration) : raw,
      status: frame.status,
      segment: frame.segment,
      ...(frame.gap ? { gap: true } : {}),
    };
  });
}
/** Four stable dataset declarations, each with primary and optional comparison
 * content. Empty series still preserve the full common time domain. */
export function labCharts(input: LabChartInput): LabChart[] {
  const { channels, frames, comparison, live, end } = sources(input);
  return immutableSnapshot(
    Array.from({ length: 4 }, (_, index) => {
      const channel = channels[index],
        otherIndex = other(channel, comparison, input.calibrated);
      const comparisonChannel = comparison?.channels[otherIndex];
      const pair = [
        { id: "primary", channel, points: points(frames, channel, index, input.calibrated) },
        {
          id: "comparison",
          channel: comparisonChannel,
          points: points(comparison?.frames ?? [], comparisonChannel, otherIndex, input.calibrated),
        },
      ];
      const entries: DatasetPointV2[] = [];
      const series = pair.map((item, seriesIndex) => {
        const reduced = reduceSeries(item.points);
        for (const run of reduced.runs)
          for (const point of run.points)
            entries.push([seriesIndex, run.index, point.time, point.value!]);
        const unit = item.channel
          ? input.calibrated
            ? item.channel.calibration.unit
            : item.channel.source.channel.unit
          : "";
        return {
          id: item.id,
          unit: Array.from(unit).slice(0, 32).join(""),
          range: reduced.range,
          extrema: reduced.extrema
            ? ([
                [reduced.extrema.minimum.time, reduced.extrema.minimum.value!],
                [reduced.extrema.maximum.time, reduced.extrema.maximum.value!],
              ] as [[number, number], [number, number]])
            : null,
          fullPointCount: reduced.fullPointCount,
          omittedPoints: reduced.omittedPoints,
          omittedRuns: reduced.omittedRuns.length,
        };
      });
      return {
        header: {
          kind: "chart" as const,
          timeDomain: [0, end] as [0, number],
          view: live ? ("recent60s" as const) : ("full" as const),
          series,
        },
        entries,
      };
    }),
  );
}
/** Cursor is evaluated against immutable original samples, never reduced points.
 * Keys are the fixed sixteen declared by each Lab onCursor binding. */
export function labCursorReadings(
  input: LabChartInput,
  time: number,
): Record<string, number | null> {
  const { channels, frames, comparison } = sources(input);
  const result: Record<string, number | null> = {};
  for (let index = 0; index < 4; index++) {
    const channel = channels[index],
      otherIndex = other(channel, comparison, input.calibrated);
    const otherChannel = comparison?.channels[otherIndex];
    for (const [prefix, selected, samples, at] of [
      [`c${index}`, channel, frames, index],
      [`c${index}comparison`, otherChannel, comparison?.frames ?? [], otherIndex],
    ] as const) {
      const raw = cursorReading(points(samples, selected, at, false), time)?.value ?? null;
      result[`${prefix}raw`] = raw;
      result[`${prefix}value`] =
        input.calibrated && selected ? calibrate(raw, selected.calibration) : raw;
    }
  }
  return result;
}
