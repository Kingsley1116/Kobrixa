import type { SensorCalibration, SensorChannel } from "./sensor-lab.js";

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
