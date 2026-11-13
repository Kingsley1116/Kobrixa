import { useId } from "react";
import "./dataset-views.css";
import {
  effectiveTimeDomainV2,
  type ChartHeaderV2,
  type DatasetDeclarationV2,
  type DatasetPointV2,
  type DatasetRowV2,
  type TimeViewV2,
} from "@kobrixa/plugin-protocol";
import { translated } from "./recovery-support.js";

type ChartDeclaration = Extract<DatasetDeclarationV2, { kind: "chart" }>;
type TableDeclaration = Extract<DatasetDeclarationV2, { kind: "table" | "list" }>;
const frame = { left: 44, right: 592, top: 16, bottom: 172 };
const fraction = (value: number, low: number, high: number): number => {
  if (low === high) return 0.5;
  const scale = Math.max(Math.abs(low), Math.abs(high), Math.abs(value), 1);
  return (value / scale - low / scale) / (high / scale - low / scale);
};
/** Keep run boundaries and the full declared time axis, including null-only tails.
 * SVG clipping, not point deletion, preserves segments crossing the view edge.
 */
function chartGeometry(
  header: ChartHeaderV2,
  points: readonly DatasetPointV2[],
  view: TimeViewV2 = header.view,
) {
  const [from, to] = effectiveTimeDomainV2(header, view);
  const paths = header.series.map(() => "");
  const isolated: { series: number; x: number; y: number }[] = [];
  // At very large finite times the recent-window subtraction can round to zero
  // width. Only the exact endpoint belongs to that window; value-axis centering
  // must not project unrelated old times into the visible plot.
  const visible = from === to ? points.filter((point) => point[2] === to) : points;
  let lastSeries = -1;
  let lastRun = -1;
  for (let index = 0; index < visible.length; index++) {
    const [series, run, time, value] = visible[index]!;
    const range = header.series[series]!.range;
    const x = frame.left + fraction(time, from, to) * (frame.right - frame.left);
    // A constant series remains centered, rather than inventing an engineering unit range.
    const ratio = fraction(value, range[0], range[1]);
    const y = frame.bottom - ratio * (frame.bottom - frame.top);
    paths[series] +=
      `${series === lastSeries && run === lastRun ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
    const next = visible[index + 1];
    if (
      (series !== lastSeries || run !== lastRun) &&
      (!next || next[0] !== series || next[1] !== run)
    )
      isolated.push({ series, x, y });
    lastSeries = series;
    lastRun = run;
  }
  return { paths, isolated };
}
export function datasetChartPaths(
  header: ChartHeaderV2,
  points: readonly DatasetPointV2[],
  view: TimeViewV2 = header.view,
): string[] {
  return chartGeometry(header, points, view).paths;
}
export function DatasetChart({
  label,
  declaration,
  header,
  points,
  locale,
  view = header.view,
  cursor,
  enabled,
  onCursor,
}: {
  label: string;
  declaration: ChartDeclaration;
  header: ChartHeaderV2;
  points: readonly DatasetPointV2[];
  locale: "en" | "zh-TW";
  view?: TimeViewV2;
  cursor: number | null;
  enabled: boolean;
  onCursor?: (time: number | null) => void;
}) {
  const clip = useId();
  const [from, to] = effectiveTimeDomainV2(header, view);
  const { paths, isolated } = chartGeometry(header, points, view);
  const selected = Math.max(from, Math.min(to, cursor ?? to));
  const x = frame.left + fraction(selected, from, to) * (frame.right - frame.left);
  const zh = locale === "zh-TW";
  return (
    <figure className="plugin-dataset-chart">
      <figcaption>{label}</figcaption>
      <svg viewBox="0 0 608 206" role="img" aria-label={label}>
        <defs>
          <clipPath id={clip}>
            <rect
              x={frame.left}
              y={frame.top}
              width={frame.right - frame.left}
              height={frame.bottom - frame.top}
            />
          </clipPath>
        </defs>
        <path
          d={`M${frame.left},${frame.top}V${frame.bottom}H${frame.right}`}
          fill="none"
          stroke="currentColor"
        />
        <text x={frame.left} y={194} textAnchor="start">
          {(from / 1000).toFixed(1)} s
        </text>
        <text x={frame.right} y={194} textAnchor="end">
          {(to / 1000).toFixed(1)} s
        </text>
        <g clipPath={`url(#${clip})`}>
          {paths.map((path, index) => (
            <path
              key={header.series[index]!.id}
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={index === 0 ? undefined : "7 4"}
            />
          ))}
          {isolated.map((point, index) => (
            <circle
              key={index}
              cx={point.x}
              cy={point.y}
              r="3"
              fill={point.series === 0 ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="2"
            />
          ))}
          {enabled && onCursor && (
            <line
              x1={x}
              x2={x}
              y1={frame.top}
              y2={frame.bottom}
              stroke="currentColor"
              strokeDasharray="2 3"
            />
          )}
        </g>
        {!points.length && (
          <text x="304" y="96" textAnchor="middle">
            {zh ? "沒有有效讀值" : "No valid readings"}
          </text>
        )}
      </svg>
      <ul>
        {header.series.map((series, index) => (
          <li key={series.id}>
            {translated(declaration.series[index]!.label, locale)} —{" "}
            {index === 0 ? (zh ? "實線" : "solid") : zh ? "虛線" : "dashed"}, {series.unit} (
            {series.range[0]} – {series.range[1]})
            {series.omittedPoints > 0 && (
              <>
                {" "}
                · {zh ? "省略點數" : "Omitted points"}: {series.omittedPoints}
              </>
            )}
            {series.omittedRuns > 0 && (
              <>
                {" "}
                · {zh ? "省略區段" : "Omitted runs"}: {series.omittedRuns}
              </>
            )}
          </li>
        ))}
      </ul>
      {onCursor && (
        <label>
          {zh ? "游標時間" : "Cursor time"}
          <input
            type="range"
            min={from}
            max={to}
            step="any"
            value={selected}
            disabled={!enabled}
            aria-label={`${label}: ${zh ? "游標時間" : "Cursor time"}`}
            aria-valuetext={`${(selected / 1000).toFixed(3)} s`}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (enabled && Number.isFinite(value) && value >= from && value <= to)
                onCursor(value);
            }}
            onKeyDown={(event) => {
              if (!enabled) return;
              const delta = ["ArrowRight", "ArrowUp"].includes(event.key)
                ? 100
                : ["ArrowLeft", "ArrowDown"].includes(event.key)
                  ? -100
                  : 0;
              if (delta) {
                event.preventDefault();
                onCursor(Math.min(to, Math.max(from, selected + delta)));
              }
            }}
          />
          <button type="button" disabled={!enabled} onClick={() => onCursor(null)}>
            {zh ? "跟隨最新" : "Follow latest"}
          </button>
        </label>
      )}
    </figure>
  );
}

export function DatasetTable({
  label,
  declaration,
  rows,
  locale,
  revision,
  enabled,
  onSelect,
  actions = [],
}: {
  label: string;
  declaration: TableDeclaration;
  rows: readonly DatasetRowV2[];
  locale: "en" | "zh-TW";
  revision: number;
  enabled: boolean;
  onSelect?: (selection: { key: string; version: string | null; revision: number }) => void;
  actions?: readonly {
    id: string;
    label: string;
    select(selection: { key: string; revision: number }): void;
  }[];
}) {
  const zh = locale === "zh-TW";
  return (
    <div className="plugin-dataset-table" tabIndex={0} role="region" aria-label={label}>
      <table>
        <caption>{label}</caption>
        <thead>
          <tr>
            {declaration.columns.map((column) => (
              <th key={column.id} scope="col">
                {translated(column.label, locale)}
              </th>
            ))}
            {(onSelect || actions.length > 0) && <th scope="col">{zh ? "動作" : "Action"}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, index) => (
                <td key={declaration.columns[index]!.id}>
                  {cell === null
                    ? "—"
                    : typeof cell === "boolean"
                      ? cell
                        ? zh
                          ? "是"
                          : "Yes"
                        : zh
                          ? "否"
                          : "No"
                      : String(cell)}
                </td>
              ))}
              {(onSelect || actions.length > 0) && (
                <td>
                  {onSelect && (
                    <button
                      type="button"
                      disabled={!enabled}
                      aria-label={`${zh ? "選取" : "Select"}: ${row.key}`}
                      onClick={() => onSelect({ key: row.key, version: row.version, revision })}
                    >
                      {zh ? "選取" : "Select"}
                    </button>
                  )}
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      disabled={!enabled}
                      aria-label={`${action.label}: ${row.key}`}
                      onClick={() => action.select({ key: row.key, revision })}
                    >
                      {action.label}
                    </button>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function DatasetCode({
  label,
  entries,
  locale,
  enabled,
  onCopy,
}: {
  label: string;
  entries: readonly string[];
  locale: "en" | "zh-TW";
  enabled: boolean;
  onCopy?: () => void;
}) {
  return (
    <section aria-label={label} className="plugin-dataset-code">
      <pre tabIndex={0} aria-label={label}>
        <code>{entries.join("")}</code>
      </pre>
      {onCopy && (
        <button type="button" disabled={!enabled} onClick={onCopy}>
          {locale === "zh-TW" ? "複製" : "Copy"}
        </button>
      )}
    </section>
  );
}
