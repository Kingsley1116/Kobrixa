import { z } from "zod";
import { channelKey } from "../../shared/sensor-lab.js";
import { validateCalibration } from "../../shared/sensor-calibration.js";

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
