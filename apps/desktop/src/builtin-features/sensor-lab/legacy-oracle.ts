/** Test-only frozen D0 oracle. Never import from product code.
 * Extracted from commit f822f3c40e0937262646ac78a5e97fc5d47531e9, not the replacement model.
 * Only import/type wiring and the two presentation labels are projected here;
 * function bodies retain baseline behavior (including known chart reduction loss).
 * Original complete-file SHA256 values:
 * main/sensor-lab/schema.ts: b8781b31bcbcffaa567310cbe3408b51d43744c6644f1d0f227337bc814a2908
 * main/sensor-lab/csv.ts: 0b3fa3987029791d948c27aeafe6f845372ae1ffa496ddea7cdf966ec24df18d
 * renderer/device/sensor-lab-chart.tsx: 876dd8f984a64b0b84268bc6ee7fde535ac6256b6192faa5dca13ecda7baf782
 * renderer/device/sensor-lab-panel.tsx: 0ea39db3823f07a150ec756e9202b68b44939aee37e58974930768bb70b5a12c
 * shared/sensor-calibration.ts: 0405bab44cfe809b8ec84d6616617f2b93b6dc25848703db3a6ce7d387d9469c
 * shared/sensor-lab.ts: 81428370dc44fc1f3baedcd2a76c941c563610bfcfb15adfbca90176f96bf6cc
 */
import { z } from "zod";
import type {
  SensorCalibration,
  SensorChannel,
  SensorRecording,
  SensorFrame,
  CalibratedChannel,
} from "../../shared/sensor-lab.js";
type Locale = "en" | "zh-TW";
const labels = {
  en: { current: "Current", comparison: "Comparison" },
  "zh-TW": { current: "本次", comparison: "比較" },
};
export function channelKey(
  source: Omit<SensorChannel, "id" | "name" | "modeName" | "decimals">,
): string {
  return JSON.stringify([
    source.kind,
    source.port,
    source.type,
    source.mode,
    source.channel,
    source.unit,
  ]);
}

const f = Math.fround;
const MAX_FLOAT = 3.4028234663852886e38;

export function identityCalibration(unit: string): SensorCalibration {
  return {
    twoPoint: false,
    sourceA: 0,
    sourceB: 100,
    targetA: 0,
    targetB: 100,
    zeroOffset: 0,
    unit,
  };
}

function scale(c: SensorCalibration): number {
  return f(f(f(c.targetB) - f(c.targetA)) / f(f(c.sourceB) - f(c.sourceA)));
}

/** Stable error keys, translated by the UI. Matches the EV3's float32 arithmetic. */
export function validateCalibration(c: SensorCalibration): string | undefined {
  if (
    typeof c.unit !== "string" ||
    c.unit.length > 32 ||
    [...c.unit].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return "invalidUnit";
  const values = [c.sourceA, c.sourceB, c.targetA, c.targetB, c.zeroOffset];
  if (values.some((value) => !Number.isFinite(value))) return "nonFinite";
  if (values.some((value) => !Number.isFinite(f(value)) || (value !== 0 && f(value) === 0)))
    return "float32Range";
  if (c.twoPoint) {
    if (f(c.sourceA) === f(c.sourceB)) return "sameSource";
    const sourceSpan = f(f(c.sourceB) - f(c.sourceA));
    const targetSpan = f(f(c.targetB) - f(c.targetA));
    const slope = scale(c);
    if (
      ![sourceSpan, targetSpan, slope, f(sourceSpan * targetSpan)].every(Number.isFinite) ||
      (c.targetA !== c.targetB && (targetSpan === 0 || slope === 0)) ||
      !Number.isFinite(f(f(c.targetA) - f(c.zeroOffset))) ||
      !Number.isFinite(f(f(c.targetB) - f(c.zeroOffset)))
    )
      return "float32Range";
  }
  return undefined;
}

/** Invalid inputs/overflow remain missing, never a physical zero. No clamping. */
export function calibrate(value: number | null | undefined, c: SensorCalibration): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || validateCalibration(c))
    return null;
  const input = f(value);
  // Preserve the documented multiply-then-divide order, rounding after every
  // EV3 operation. Precomputing a slope changes results near float32 boundaries.
  const mapped = c.twoPoint
    ? f(
        f(c.targetA) +
          f(
            f(f(input - f(c.sourceA)) * f(f(c.targetB) - f(c.targetA))) /
              f(f(c.sourceB) - f(c.sourceA)),
          ),
      )
    : input;
  const result = f(mapped - f(c.zeroOffset));
  return Number.isFinite(result) ? result : null;
}

/** Basic Plus currently has no exponent literals. Expand scientific notation. */
function decimal(value: number): string {
  const text = String(f(value));
  if (!/[eE]/.test(text)) return text;
  const [coefficient, power] = text.toLowerCase().split("e");
  const negative = coefficient!.startsWith("-");
  const unsigned = negative ? coefficient!.slice(1) : coefficient!;
  const dot = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const position = (dot < 0 ? unsigned.length : dot) + Number(power);
  const expanded =
    position <= 0
      ? `0.${"0".repeat(-position)}${digits}`
      : position >= digits.length
        ? digits + "0".repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return `${negative ? "-" : ""}${expanded}`;
}

// A .0 suffix alone is still inferred as an integer by Basic Plus. Division
// forces floating-point lowering, including for large integral coefficients.
function numberExpression(value: number): string {
  return value < 0 ? `(0 - (${decimal(-value)} / 1))` : `(${decimal(value)} / 1)`;
}

/** Complete, single-reading example; only running it changes a sensor mode. */
export function calibrationCode(
  source: SensorChannel,
  c: SensorCalibration,
  locale: "en" | "zh-TW",
): string {
  const error = validateCalibration(c);
  if (error) throw new RangeError(error);
  if (
    !Number.isInteger(source.port) ||
    source.port < 0 ||
    source.port > 3 ||
    !Number.isInteger(source.type) ||
    source.type < 1 ||
    source.type > 124 ||
    !Number.isInteger(source.channel) ||
    source.channel < 0 ||
    source.channel > 7 ||
    !Number.isInteger(source.mode) ||
    source.mode < 0 ||
    source.mode > 7 ||
    (source.kind !== "input" && source.kind !== "output") ||
    (source.kind === "output" &&
      (![7, 8].includes(source.type) || source.mode !== 0 || source.channel !== 0))
  )
    throw new RangeError("invalidSource");
  const zh = locale === "zh-TW";
  const lines = [
    zh ? "' 感測器曲線工具：校正與歸零參數" : "' Sensor lab: calibration and zero offset",
    zh
      ? "' 請沿用建立校正時的感測器與實驗配置。"
      : "' Use the same sensor and physical setup used for calibration.",
    "number labReading",
    "number labCalibrated",
  ];
  if (source.kind === "input") {
    const port = source.port + 1;
    lines.push(
      `Assert.Equal(Sensor.GetType(${port}), ${source.type}, "Sensor type changed")`,
      zh
        ? "' 執行此範例會設定下列模式，並等待感測器就緒。"
        : "' Running this example selects this mode and waits for readiness.",
      `Sensor.SetMode(${port}, ${source.mode})`,
      `Sensor.Wait(${port})`,
      `Assert.Equal(Sensor.GetType(${port}), ${source.type}, "Sensor type changed")`,
      `Assert.Equal(Sensor.GetMode(${port}), ${source.mode}, "Sensor mode changed")`,
      `labReading = Sensor.ReadSIValue(${port}, ${source.channel})`,
      `Assert.Equal(Sensor.GetType(${port}), ${source.type}, "Sensor type changed")`,
      `Assert.Equal(Sensor.GetMode(${port}), ${source.mode}, "Sensor mode changed")`,
    );
  } else lines.push(`labReading = Motor.GetCount("${String.fromCharCode(65 + source.port)}")`);
  lines.push(
    "If labReading <> labReading Then",
    '  Assert.Failed("Sensor reading unavailable")',
    "EndIf",
  );
  if (c.twoPoint)
    lines.push(
      `labCalibrated = ${numberExpression(c.targetA)} + (labReading - ${numberExpression(c.sourceA)}) * (${numberExpression(c.targetB)} - ${numberExpression(c.targetA)}) / (${numberExpression(c.sourceB)} - ${numberExpression(c.sourceA)}) - ${numberExpression(c.zeroOffset)}`,
    );
  else lines.push(`labCalibrated = labReading - ${numberExpression(c.zeroOffset)}`);
  lines.push(
    `If labCalibrated <> labCalibrated Or Math.Abs(labCalibrated) > ${decimal(MAX_FLOAT)} Then`,
    '  Assert.Failed("Calibration result unavailable")',
    "EndIf",
    "LCD.Clear()",
    `LCD.Text(1, 0, 0, 1, labCalibrated + " ${c.unit.replaceAll('"', '""')}")`,
    "LCD.Update()",
  );
  return lines.join("\n") + "\n";
}

export const SENSOR_LAB_LIMITS = {
  channels: 4,
  durationMs: 30 * 60 * 1000,
  frames: 3600,
  recordings: 50,
  checkpointMs: 5000,
  freshMs: 2500,
} as const;

export const sensorLabIdSchema = z.string().uuid();
const label = z
  .string()
  .max(160)
  .refine((value) => !value.includes("\0"));
const name = label.min(1).refine((value) => value.trim().length > 0);
const finite = z.number().finite();
const source = z
  .object({
    id: z.string().max(300),
    kind: z.enum(["input", "output"]),
    port: z.number().int().min(0).max(3),
    type: z.number().int().min(1).max(124),
    mode: z.number().int().min(0).max(7),
    channel: z.number().int().min(0).max(7),
    name: label,
    modeName: label,
    unit: label,
    decimals: z.number().int().min(0).max(6),
  })
  .strict()
  .refine((value) => value.id === channelKey(value), "Invalid source identity.")
  .refine(
    (value) =>
      value.kind === "input" ||
      ([7, 8].includes(value.type) &&
        value.mode === 0 &&
        value.channel === 0 &&
        value.unit === "deg"),
    "Invalid motor channel.",
  );

export const sensorCalibrationSchema = z
  .object({
    twoPoint: z.boolean(),
    sourceA: finite,
    sourceB: finite,
    targetA: finite,
    targetB: finite,
    zeroOffset: finite,
    unit: label,
  })
  .strict()
  .superRefine((value, ctx) => {
    const error = validateCalibration(value);
    if (error) ctx.addIssue({ code: "custom", message: `Invalid calibration: ${error}` });
  });
const calibratedChannel = z.object({ source, calibration: sensorCalibrationSchema }).strict();
const channels = z
  .array(calibratedChannel)
  .min(1)
  .max(SENSOR_LAB_LIMITS.channels)
  .refine(
    (values) => new Set(values.map((value) => value.source.id)).size === values.length,
    "Choose each channel only once.",
  );

export const sensorLabStartSchema = z
  .object({
    sessionId: sensorLabIdSchema,
    name,
    channels,
  })
  .strict();

export const sensorLabCalibrationSchema = z
  .object({
    id: sensorLabIdSchema.optional(),
    name,
    source,
    calibration: sensorCalibrationSchema,
  })
  .strict();

export const calibrationProfileSchema = sensorLabCalibrationSchema.extend({
  id: sensorLabIdSchema,
});

const stopReason = z.enum([
  "manual",
  "limit",
  "source-changed",
  "disconnected",
  "suspend",
  "close",
  "update",
  "interrupted",
]);
const frame = z
  .object({
    sampledAt: finite.nonnegative(),
    elapsedMs: finite.nonnegative().max(SENSOR_LAB_LIMITS.durationMs),
    values: z.array(finite.nullable()).min(1).max(SENSOR_LAB_LIMITS.channels),
    status: z.enum(["ok", "busy", "error"]),
    segment: z.number().int().nonnegative(),
  })
  .strict();

export const sensorRecordingSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: sensorLabIdSchema,
    name,
    startedAt: finite.nonnegative(),
    endedAt: finite.nonnegative().optional(),
    durationMs: finite.nonnegative().max(SENSOR_LAB_LIMITS.durationMs),
    frameCount: z.number().int().min(0).max(SENSOR_LAB_LIMITS.frames),
    reason: stopReason.optional(),
    device: z
      .object({
        id: z.string().min(1).max(1024),
        name: label,
        transport: z.enum(["usb", "wifi", "mock"]),
        address: z.string().max(1024).optional(),
        serialNumber: z.string().max(1024).optional(),
        metadata: z.record(z.string().max(1024), z.string().max(4096)).optional(),
      })
      .strict()
      .transform(({ address, serialNumber, metadata, ...base }) => ({
        ...base,
        ...(address === undefined ? {} : { address }),
        ...(serialNumber === undefined ? {} : { serialNumber }),
        ...(metadata === undefined ? {} : { metadata }),
      })),
    channels,
    frames: z.array(frame).max(SENSOR_LAB_LIMITS.frames),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.frameCount !== record.frames.length ||
      record.frames.some(
        (sample, index) =>
          sample.values.length !== record.channels.length ||
          sample.elapsedMs > record.durationMs ||
          (index > 0 && sample.elapsedMs < record.frames[index - 1]!.elapsedMs),
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid recording frames." });
    if ((record.endedAt === undefined) !== (record.reason === undefined))
      ctx.addIssue({ code: "custom", message: "Incomplete recording status." });
  });

function cell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  // Quoting alone does not prevent spreadsheet programs from executing formulas.
  const text =
    typeof value === "number" ? String(value) : /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Every row is one channel sample, with its immutable source/calibration metadata. */
export function sensorRecordingCsv(record: SensorRecording): string {
  const rows: Array<Array<string | number | undefined | null>> = [
    [
      "recording_id",
      "recording_name",
      "started_at",
      "ended_at",
      "stop_reason",
      "device_name",
      "transport",
      "host_received_at",
      "elapsed_ms",
      "source",
      "port",
      "sensor_type",
      "mode",
      "mode_name",
      "channel",
      "raw_unit",
      "calibrated_unit",
      "raw_value",
      "calibrated_value",
      "status",
      "segment",
      "two_point",
      "source_a",
      "source_b",
      "target_a",
      "target_b",
      "zero_offset",
    ],
  ];
  for (const frame of record.frames) {
    record.channels.forEach(({ source, calibration }, index) => {
      const raw = frame.values[index] ?? null;
      const calibrated = calibrate(raw, calibration);
      const status =
        frame.status !== "ok"
          ? frame.status
          : raw === null
            ? "invalid"
            : calibrated === null
              ? "invalid-calibration"
              : "ok";
      rows.push([
        record.id,
        record.name,
        new Date(record.startedAt).toISOString(),
        record.endedAt === undefined ? undefined : new Date(record.endedAt).toISOString(),
        record.reason,
        record.device.name,
        record.device.transport,
        new Date(frame.sampledAt).toISOString(),
        frame.elapsedMs,
        source.kind,
        source.kind === "input" ? source.port + 1 : String.fromCharCode(65 + source.port),
        source.type,
        source.mode,
        source.modeName,
        source.channel,
        source.unit,
        calibration.unit,
        raw,
        calibrated,
        status,
        frame.segment,
        calibration.twoPoint ? "true" : "false",
        calibration.sourceA,
        calibration.sourceB,
        calibration.targetA,
        calibration.targetB,
        calibration.zeroOffset,
      ]);
    });
  }
  return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
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

export function recordingPoints(
  frames: readonly SensorFrame[],
  channel: CalibratedChannel,
  index: number,
  calibrated: boolean,
): SensorChartPoint[] {
  const points: SensorChartPoint[] = [];
  let segment: number | undefined;
  for (const frame of frames) {
    if (segment !== undefined && segment !== frame.segment)
      points.push({ time: frame.elapsedMs, value: null });
    const raw = frame.status === "ok" ? (frame.values[index] ?? null) : null;
    points.push({
      time: frame.elapsedMs,
      value: raw === null ? null : calibrated ? calibrate(raw, channel.calibration) : raw,
    });
    segment = frame.segment;
  }
  return points;
}

export function recordingSeries(
  channel: CalibratedChannel,
  index: number,
  frames: readonly SensorFrame[],
  comparison: SensorRecording | undefined,
  calibrated: boolean,
  locale: Locale,
): SensorChartSeries[] {
  const series: SensorChartSeries[] = [
    { label: labels[locale].current, points: recordingPoints(frames, channel, index, calibrated) },
  ];
  const otherIndex =
    comparison?.channels.findIndex((item) => item.source.id === channel.source.id) ?? -1;
  const other = comparison?.channels[otherIndex];
  if (comparison && other && (!calibrated || other.calibration.unit === channel.calibration.unit)) {
    series.push({
      label: labels[locale].comparison,
      points: recordingPoints(comparison.frames, other, otherIndex, calibrated),
      comparison: true,
    });
  }
  return series;
}

export function nearestChartValue(
  points: readonly SensorChartPoint[],
  time: number,
): number | null {
  let nearest: SensorChartPoint | undefined;
  for (const point of points) {
    if (!nearest || Math.abs(point.time - time) <= Math.abs(nearest.time - time)) nearest = point;
  }
  return nearest && Math.abs(nearest.time - time) <= 1500 ? nearest.value : null;
}

// Retained verbatim because parseCalibrationDraft uses the baseline return type.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function calibrationDraft(calibration: SensorCalibration) {
  return {
    twoPoint: calibration.twoPoint,
    sourceA: String(calibration.sourceA),
    sourceB: String(calibration.sourceB),
    targetA: String(calibration.targetA),
    targetB: String(calibration.targetB),
    zeroOffset: String(calibration.zeroOffset),
    unit: calibration.unit,
  };
}
export function parseCalibrationDraft(
  draft: ReturnType<typeof calibrationDraft>,
): SensorCalibration | undefined {
  const keys = ["sourceA", "sourceB", "targetA", "targetB", "zeroOffset"] as const;
  if (keys.some((key) => !draft[key].trim() || !Number.isFinite(Number(draft[key]))))
    return undefined;
  return {
    twoPoint: draft.twoPoint,
    sourceA: Number(draft.sourceA),
    sourceB: Number(draft.sourceB),
    targetA: Number(draft.targetA),
    targetB: Number(draft.targetB),
    zeroOffset: Number(draft.zeroOffset),
    unit: draft.unit,
  };
}
