import { useId } from "react";
import type { Locale } from "../i18n/copy.js";

export interface SensorChartPoint {
  /** Milliseconds relative to the beginning of this recording. */
  time: number;
  value: number | null;
}
export interface SensorChartSeries {
  label: string;
  points: readonly SensorChartPoint[];
  comparison?: boolean;
}
export interface SensorChartGeometry {
  paths: string[];
  range: [number, number];
  count: number;
}

const LEFT = 48;
const RIGHT = 316;
const TOP = 12;
const BOTTOM = 108;
const GAP_MS = 2_000;

export function chartNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100_000 || (value !== 0 && Math.abs(value) < 0.001))
    return value.toExponential(2);
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

/** Buckets preserve extrema; a bucket with missing data remains a visible gap. */
export function reduceChartPoints(
  points: readonly SensorChartPoint[],
  maximum = 800,
): SensorChartPoint[] {
  const budget = Math.max(2, Math.floor(maximum / 2) * 2);
  if (points.length <= budget) return [...points];
  const size = Math.ceil(points.length / (budget / 2));
  const result: SensorChartPoint[] = [];
  for (let start = 0; start < points.length; start += size) {
    const bucket = points.slice(start, start + size);
    const missing = bucket.find(
      (point, i) =>
        point.value === null ||
        !Number.isFinite(point.value) ||
        (i > 0 && point.time - bucket[i - 1]!.time > GAP_MS),
    );
    if (missing) {
      result.push({ time: missing.time, value: null });
      continue;
    }
    let minimum = 0,
      maximumIndex = 0;
    bucket.forEach((point, i) => {
      if (point.value! < bucket[minimum]!.value!) minimum = i;
      if (point.value! > bucket[maximumIndex]!.value!) maximumIndex = i;
    });
    if (minimum === maximumIndex) {
      result.push(bucket[0]!, bucket.at(-1)!);
    } else {
      result.push(
        bucket[Math.min(minimum, maximumIndex)]!,
        bucket[Math.max(minimum, maximumIndex)]!,
      );
    }
  }
  return result;
}

export function sensorChartGeometry(
  series: readonly SensorChartSeries[],
  domain: readonly [number, number],
): SensorChartGeometry {
  const from = Number.isFinite(domain[0]) ? domain[0] : 0;
  const to = Number.isFinite(domain[1]) && domain[1] > from ? domain[1] : from + 1;
  const visible = series.map((item) =>
    item.points.filter(
      (point) => Number.isFinite(point.time) && point.time >= from && point.time <= to,
    ),
  );
  const numbers = visible.flatMap((points) =>
    points.flatMap((point) =>
      point.value !== null && Number.isFinite(point.value) ? [point.value] : [],
    ),
  );
  let minimum = numbers.length ? Math.min(...numbers) : 0;
  let maximum = numbers.length ? Math.max(...numbers) : 1;
  if (minimum === maximum) {
    const pad = Math.max(1, Math.abs(minimum) * 0.05);
    minimum = Math.max(-Number.MAX_VALUE, minimum - pad);
    maximum = Math.min(Number.MAX_VALUE, maximum + pad);
  }
  const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum), 1);
  const low = minimum / magnitude;
  const span = maximum / magnitude - low || 1;
  const paths = visible.map((points) => {
    const separated = points.flatMap((point, index): SensorChartPoint[] => {
      const previous = points[index - 1];
      return previous && (point.time - previous.time > GAP_MS || point.time < previous.time)
        ? [{ time: point.time, value: null }, point]
        : [point];
    });
    const reduced = reduceChartPoints(separated);
    let previous: SensorChartPoint | undefined;
    let path = "";
    for (const point of reduced) {
      if (point.value === null || !Number.isFinite(point.value)) {
        previous = undefined;
        continue;
      }
      const x = LEFT + ((point.time - from) / (to - from)) * (RIGHT - LEFT);
      const y = BOTTOM - ((point.value / magnitude - low) / span) * (BOTTOM - TOP);
      const connected = previous && point.time >= previous.time;
      path += `${connected ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
      // A zero-length line with a round cap keeps an isolated sample visible.
      if (!connected) path += `l0,0`;
      previous = point;
    }
    return path;
  });
  return { paths, range: [minimum, maximum], count: numbers.length };
}

export function SensorLabChart({
  title,
  unit,
  series,
  domain,
  locale,
  cursor,
}: {
  title: string;
  unit: string;
  series: readonly SensorChartSeries[];
  domain: readonly [number, number];
  locale: Locale;
  cursor?: number;
}): React.JSX.Element {
  const id = useId();
  const geometry = sensorChartGeometry(series, domain);
  const zh = locale === "zh-TW";
  const end = domain[1] > domain[0] ? domain[1] : domain[0] + 1;
  const cursorX =
    cursor === undefined
      ? undefined
      : LEFT + ((cursor - domain[0]) / (end - domain[0])) * (RIGHT - LEFT);
  return (
    <svg
      className="sensor-lab-chart"
      viewBox="0 0 328 140"
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
      data-testid="sensor-lab-chart"
    >
      <title id={`${id}-title`}>
        {title}
        {unit ? ` (${unit})` : ""}
      </title>
      <desc id={`${id}-description`}>
        {zh ? "相對時間（秒）" : "Elapsed time (seconds)"}: {chartNumber(domain[0] / 1000)}–
        {chartNumber(end / 1000)}.{zh ? "數值範圍" : "Value range"}:{" "}
        {chartNumber(geometry.range[0])}–{chartNumber(geometry.range[1])}.{geometry.count}{" "}
        {zh
          ? "筆有效讀值。缺少讀值以斷線表示。"
          : "valid readings. Missing readings appear as gaps."}
        {series
          .map(
            (item) =>
              `${item.label}: ${item.comparison ? (zh ? "虛線" : "dashed") : zh ? "實線" : "solid"}`,
          )
          .join("; ")}
      </desc>
      {[TOP, (TOP + BOTTOM) / 2, BOTTOM].map((y) => (
        <line key={y} className="sensor-lab-grid" x1={LEFT} x2={RIGHT} y1={y} y2={y} />
      ))}
      <text className="sensor-lab-tick" x={LEFT - 5} y={TOP + 4} textAnchor="end">
        {chartNumber(geometry.range[1])}
      </text>
      <text className="sensor-lab-tick" x={LEFT - 5} y={BOTTOM + 3} textAnchor="end">
        {chartNumber(geometry.range[0])}
      </text>
      <text className="sensor-lab-tick" x={LEFT} y={128}>
        {chartNumber(domain[0] / 1000)} s
      </text>
      <text className="sensor-lab-tick" x={RIGHT} y={128} textAnchor="end">
        {chartNumber(end / 1000)} s
      </text>
      {series.map((item, index) => (
        <path
          key={`${item.label}-${index}`}
          className={`sensor-lab-line ${item.comparison ? "is-comparison" : ""}`}
          d={geometry.paths[index]}
        />
      ))}
      {cursorX !== undefined && cursorX >= LEFT && cursorX <= RIGHT && (
        <line className="sensor-lab-cursor" x1={cursorX} x2={cursorX} y1={TOP} y2={BOTTOM} />
      )}
      {!geometry.count && (
        <text className="sensor-lab-empty-chart" x={(LEFT + RIGHT) / 2} y={64} textAnchor="middle">
          {zh ? "等待有效讀值" : "Waiting for readings"}
        </text>
      )}
    </svg>
  );
}
