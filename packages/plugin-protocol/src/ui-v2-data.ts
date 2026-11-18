import { z } from "zod";
import { localIdSchema, uiLabelSchema } from "./ui-resource.js";

/** Unpublished T0 data leaf. Wire schemas intentionally contain no custom refinements.
 * Call the explicit validators after wire parsing; schemas alone are not admission.
 * Binding/CAS, hashes, transfer lifecycle and RPC envelope budgets belong to the host.
 */
export const UI_DATA_LIMITS_V2 = Object.freeze({
  datasets: 8,
  charts: 4,
  codeDatasets: 1,
  series: 2,
  pointsPerSeries: 800,
  panelPoints: 6400,
  fullPoints: 3600,
  rows: 50,
  chunkEntries: 256,
  datasetBytes: 524288,
  panelBytes: 524288,
  headerBytes: 16384,
  entryBytes: 8192,
  chunkBytes: 49152,
  codePoints: 16384,
  codeBytes: 65536,
  codeEntryPoints: 1024,
});
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// UTF-16 wire bounds allow supplementary characters; scalar counts are semantic.
const text = (max: number) => z.string().max(max * 2);
const column = z.strictObject({
  id: localIdSchema,
  label: uiLabelSchema,
  value: z.enum(["string", "number", "boolean"]),
});
export const datasetDeclarationV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("chart"),
    series: z
      .array(
        z.strictObject({
          id: localIdSchema,
          label: uiLabelSchema,
        }),
      )
      .min(1)
      .max(2),
  }),
  z.strictObject({ kind: z.literal("table"), columns: z.array(column).min(1).max(8) }),
  z.strictObject({ kind: z.literal("list"), columns: z.array(column).min(1).max(3) }),
  z.strictObject({ kind: z.literal("code") }),
]);
export type DatasetDeclarationV2 = z.infer<typeof datasetDeclarationV2Schema>;
export const timeDomainV2Schema = z.tuple([z.literal(0), z.number().min(1000)]);
export const timeViewV2Schema = z.enum(["full", "recent60s"]);
/** A displayed domain may start after zero; header schema requires the full domain. */
export type TimeDomainV2 = [from: number, to: number];
export type TimeViewV2 = z.infer<typeof timeViewV2Schema>;
export const datasetPointV2Schema = z.tuple([counter, counter, z.number().min(0), z.number()]);
export type DatasetPointV2 = z.infer<typeof datasetPointV2Schema>;
export const datasetSeriesV2Schema = z.strictObject({
  id: localIdSchema,
  unit: text(32),
  range: z.tuple([z.number(), z.number()]),
  extrema: z
    .tuple([z.tuple([z.number().min(0), z.number()]), z.tuple([z.number().min(0), z.number()])])
    .nullable(),
  fullPointCount: counter.max(3600),
  omittedPoints: counter.max(3600),
  omittedRuns: counter.max(3600),
});
export type DatasetSeriesV2 = z.infer<typeof datasetSeriesV2Schema>;
export const chartHeaderV2Schema = z.strictObject({
  kind: z.literal("chart"),
  timeDomain: timeDomainV2Schema,
  view: timeViewV2Schema,
  series: z.array(datasetSeriesV2Schema).min(1).max(2),
});
const tableHeader = z.strictObject({ kind: z.literal("table") });
const listHeader = z.strictObject({ kind: z.literal("list") });
const codeHeader = z.strictObject({ kind: z.literal("code") });
export const datasetHeaderV2Schema = z.discriminatedUnion("kind", [
  chartHeaderV2Schema,
  tableHeader,
  listHeader,
  codeHeader,
]);
export type DatasetHeaderV2 = z.infer<typeof datasetHeaderV2Schema>;
export type ChartHeaderV2 = z.infer<typeof chartHeaderV2Schema>;
export const datasetRowV2Schema = z.strictObject({
  key: text(128).min(1),
  version: text(128).min(1).nullable(),
  cells: z.array(z.union([text(200), z.number(), z.boolean(), z.null()])).max(8),
});
export type DatasetRowV2 = z.infer<typeof datasetRowV2Schema>;
const codeEntry = text(1024).min(1);
export const datasetChunkV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chart"), entries: z.array(datasetPointV2Schema).max(256) }),
  z.strictObject({ kind: z.literal("table"), entries: z.array(datasetRowV2Schema).max(50) }),
  z.strictObject({ kind: z.literal("list"), entries: z.array(datasetRowV2Schema).max(50) }),
  z.strictObject({ kind: z.literal("code"), entries: z.array(codeEntry).max(256) }),
]);
export type DatasetChunkV2 = z.infer<typeof datasetChunkV2Schema>;
/** Complete assembled snapshot, not a transfer chunk. Header discriminates entries. */
export const datasetV2Schema = z.union([
  z.strictObject({ header: chartHeaderV2Schema, entries: z.array(datasetPointV2Schema).max(1600) }),
  z.strictObject({ header: tableHeader, entries: z.array(datasetRowV2Schema).max(50) }),
  z.strictObject({ header: listHeader, entries: z.array(datasetRowV2Schema).max(50) }),
  z.strictObject({ header: codeHeader, entries: z.array(codeEntry).max(16384) }),
]);
export type DatasetV2 = z.infer<typeof datasetV2Schema>;

export class UiDataValidationErrorV2 extends Error {
  constructor(readonly reason: "schema" | "reference" | "quota") {
    super(`Invalid UI v2 data: ${reason}.`);
    this.name = "UiDataValidationErrorV2";
  }
}
function requireData(
  condition: boolean,
  reason: UiDataValidationErrorV2["reason"] = "schema",
): asserts condition {
  if (!condition) throw new UiDataValidationErrorV2(reason);
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  // Inspect the original object before Zod can omit a dangerous property.
  const pending = [input];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== "object") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    requireData(
      Array.isArray(item) ||
        Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null,
    );
    for (const [key, value] of Object.entries(item)) {
      requireData(!forbidden.has(key));
      pending.push(value);
    }
  }
  const result = schema.safeParse(input);
  requireData(result.success);
  return result.data;
}
function checkText(value: string, maximum: number): void {
  requireData([...value].length <= maximum);
  for (const c of value) {
    const cp = c.codePointAt(0)!;
    requireData(cp !== 0 && !(cp >= 0xd800 && cp <= 0xdfff));
  }
}
function checkId(id: string): void {
  requireData(!forbidden.has(id), "reference");
}
function unique(ids: string[]): void {
  requireData(new Set(ids).size === ids.length, "reference");
}
const encoder = new TextEncoder();
const byteLength = (json: string): number => encoder.encode(json).byteLength;
const json = (value: unknown): string => JSON.stringify(value);

export function validateDatasetDeclarationV2(input: unknown): DatasetDeclarationV2 {
  const d = parse(datasetDeclarationV2Schema, input);
  const fields = d.kind === "chart" ? d.series : d.kind === "code" ? [] : d.columns;
  unique(fields.map((f) => f.id));
  for (const f of fields) {
    checkId(f.id);
    for (const label of Object.values(f.label)) {
      checkText(label, 200);
      requireData(
        label.trim().length > 0 &&
          [...label].every((c) => c.codePointAt(0)! >= 32 && c.codePointAt(0)! !== 127),
      );
    }
  }
  return d;
}
/** Rebuild every object in canonical key order; no caller toJSON or insertion order survives. */
function normalizedHeader(h: DatasetHeaderV2): DatasetHeaderV2 {
  if (h.kind !== "chart") return { kind: h.kind };
  return {
    kind: h.kind,
    timeDomain: [...h.timeDomain],
    view: h.view,
    series: h.series.map((s) => ({
      id: s.id,
      unit: s.unit,
      range: [...s.range],
      extrema: s.extrema === null ? null : [[...s.extrema[0]], [...s.extrema[1]]],
      fullPointCount: s.fullPointCount,
      omittedPoints: s.omittedPoints,
      omittedRuns: s.omittedRuns,
    })),
  };
}
function normalizedEntries(
  kind: DatasetHeaderV2["kind"],
  entries: DatasetV2["entries"],
): DatasetV2["entries"] {
  if (kind === "chart") return (entries as DatasetPointV2[]).map((p): DatasetPointV2 => [...p]);
  if (kind === "code") return [...(entries as string[])];
  return (entries as DatasetRowV2[]).map((r) => ({
    key: r.key,
    version: r.version,
    cells: [...r.cells],
  }));
}
export function validateDatasetHeaderV2(
  input: unknown,
  declaration?: DatasetDeclarationV2,
): DatasetHeaderV2 {
  const h = parse(datasetHeaderV2Schema, input);
  if (declaration) {
    const d = validateDatasetDeclarationV2(declaration);
    requireData(d.kind === h.kind, "reference");
    if (d.kind === "chart" && h.kind === "chart")
      requireData(json(d.series.map((s) => s.id)) === json(h.series.map((s) => s.id)), "reference");
  }
  if (h.kind === "chart") {
    unique(h.series.map((s) => s.id));
    for (const s of h.series) {
      checkId(s.id);
      checkText(s.unit, 32);
      requireData(s.range[0] <= s.range[1]);
      requireData((s.fullPointCount === 0) === (s.extrema === null));
      requireData(s.omittedPoints <= s.fullPointCount && s.omittedRuns <= s.omittedPoints);
      if (s.extrema) {
        requireData(s.extrema[0][1] <= s.extrema[1][1]);
        for (const [time, value] of s.extrema)
          requireData(time <= h.timeDomain[1] && value >= s.range[0] && value <= s.range[1]);
      }
    }
  }
  requireData(byteLength(json(normalizedHeader(h))) <= UI_DATA_LIMITS_V2.headerBytes, "quota");
  return h;
}
function checkEntries(
  kind: DatasetHeaderV2["kind"],
  entries: DatasetV2["entries"],
  declaration?: DatasetDeclarationV2,
): void {
  if (kind === "code") {
    for (const entry of entries as string[]) checkText(entry, 1024);
  } else if (kind === "table" || kind === "list") {
    const rows = entries as DatasetRowV2[];
    unique(rows.map((r) => r.key));
    for (const row of rows) {
      checkText(row.key, 128);
      if (row.version !== null) checkText(row.version, 128);
      if (kind === "list") requireData(row.cells.length <= 3);
      if (declaration && (declaration.kind === "table" || declaration.kind === "list")) {
        requireData(row.cells.length === declaration.columns.length, "reference");
        row.cells.forEach((cell, i) =>
          requireData(cell === null || typeof cell === declaration.columns[i]!.value, "reference"),
        );
      }
      for (const cell of row.cells) if (typeof cell === "string") checkText(cell, 200);
    }
  }
  for (const entry of normalizedEntries(kind, entries))
    requireData(byteLength(json(entry)) <= UI_DATA_LIMITS_V2.entryBytes, "quota");
}
function checkChartEntries(h: ChartHeaderV2, entries: DatasetPointV2[], complete: boolean): void {
  const counts = h.series.map(() => 0);
  let previous: DatasetPointV2 | undefined;
  for (const p of entries) {
    const [series, run, time, value] = p;
    const s = h.series[series];
    requireData(s !== undefined, "reference");
    requireData(time <= h.timeDomain[1] && value >= s.range[0] && value <= s.range[1]);
    requireData(s.extrema !== null && value >= s.extrema[0][1] && value <= s.extrema[1][1]);
    if (previous)
      requireData(
        series > previous[0] ||
          (series === previous[0] &&
            (run > previous[1] || (run === previous[1] && time >= previous[2]))),
      );
    counts[series] = counts[series]! + 1;
    requireData(counts[series]! <= 800);
    previous = p;
  }
  if (complete)
    h.series.forEach((s, i) => {
      requireData(s.omittedPoints === s.fullPointCount - counts[i]!);
      // The pure reducer always retains global extrema, including isolated runs.
      for (const extreme of s.extrema ?? [])
        requireData(entries.some((p) => p[0] === i && p[2] === extreme[0] && p[3] === extreme[1]));
    });
}
/** Validates one chunk; cross-chunk ordering, duplicates and totals are checked at assembly. */
export function validateDatasetChunkV2(
  input: unknown,
  header?: DatasetHeaderV2,
  declaration?: DatasetDeclarationV2,
): DatasetChunkV2 {
  const chunk = parse(datasetChunkV2Schema, input);
  const d = declaration && validateDatasetDeclarationV2(declaration);
  if (d) requireData(d.kind === chunk.kind, "reference");
  checkEntries(chunk.kind, chunk.entries, d);
  if (header) {
    const h = validateDatasetHeaderV2(header, d);
    requireData(h.kind === chunk.kind, "reference");
    if (h.kind === "chart" && chunk.kind === "chart") checkChartEntries(h, chunk.entries, false);
  }
  requireData(
    byteLength(json({ kind: chunk.kind, entries: normalizedEntries(chunk.kind, chunk.entries) })) <=
      UI_DATA_LIMITS_V2.chunkBytes,
    "quota",
  );
  return chunk;
}
function validatedDataset(
  header: unknown,
  entries: unknown,
  declaration?: DatasetDeclarationV2,
): DatasetV2 {
  const data = parse(datasetV2Schema, { header, entries });
  const h = validateDatasetHeaderV2(data.header, declaration);
  checkEntries(h.kind, data.entries, declaration);
  if (h.kind === "chart") checkChartEntries(h, data.entries as DatasetPointV2[], true);
  if (h.kind === "code") {
    const code = (data.entries as string[]).join("");
    requireData([...code].length <= 16384 && byteLength(code) <= 65536, "quota");
  }
  requireData(
    byteLength(json([normalizedHeader(h), normalizedEntries(h.kind, data.entries)])) <=
      UI_DATA_LIMITS_V2.datasetBytes,
    "quota",
  );
  return data;
}
export function validateDatasetV2(
  declaration: DatasetDeclarationV2,
  header: unknown,
  entries: unknown,
): DatasetV2 {
  return validatedDataset(header, entries, validateDatasetDeclarationV2(declaration));
}
/** Semantic validity without declaration references; call validateDatasetV2 for admission. */
export function canonicalDatasetV2Json(header: unknown, entries: unknown): string {
  const data = validatedDataset(header, entries);
  return json([normalizedHeader(data.header), normalizedEntries(data.header.kind, data.entries)]);
}
export function canonicalDatasetV2Bytes(header: unknown, entries: unknown): Uint8Array {
  return encoder.encode(canonicalDatasetV2Json(header, entries));
}
export function canonicalHeaderV2Json(header: unknown): string {
  return json(normalizedHeader(validateDatasetHeaderV2(header)));
}
export function canonicalChunkV2Json(input: unknown): string {
  const chunk = validateDatasetChunkV2(input);
  return json({ kind: chunk.kind, entries: normalizedEntries(chunk.kind, chunk.entries) });
}
/** Pure aggregate check. Caller supplies each distinct committed dataset exactly once. */
export function validateDatasetPanelV2(
  datasets: readonly {
    declaration: DatasetDeclarationV2;
    header: DatasetHeaderV2;
    entries: DatasetV2["entries"];
  }[],
): { byteLength: number; pointCount: number } {
  requireData(datasets.length <= 8, "quota");
  let bytes = 0,
    points = 0,
    charts = 0,
    codes = 0;
  for (const item of datasets) {
    const data = validateDatasetV2(item.declaration, item.header, item.entries);
    bytes += canonicalDatasetV2Bytes(data.header, data.entries).byteLength;
    if (data.header.kind === "chart") {
      charts++;
      points += data.entries.length;
    }
    if (data.header.kind === "code") codes++;
  }
  requireData(bytes <= 524288 && points <= 6400 && charts <= 4 && codes <= 1, "quota");
  return { byteLength: bytes, pointCount: points };
}
/** Group membership/presentation readiness is supplied by the caller, not inferred here. */
export function chartTimeDomainsMatchV2(headers: readonly ChartHeaderV2[]): boolean {
  for (const h of headers) validateDatasetHeaderV2(h);
  const first = headers[0];
  return (
    !!first &&
    headers.every(
      (h) =>
        h.view === first.view &&
        h.timeDomain[0] === first.timeDomain[0] &&
        h.timeDomain[1] === first.timeDomain[1],
    )
  );
}
export function effectiveTimeDomainV2(
  header: ChartHeaderV2,
  view: TimeViewV2 = header.view,
): TimeDomainV2 {
  validateDatasetHeaderV2(header);
  parse(timeViewV2Schema, view);
  return [view === "full" ? 0 : Math.max(0, header.timeDomain[1] - 60000), header.timeDomain[1]];
}
