import { calibrate } from "../../shared/sensor-calibration.js";
import type { SensorRecording } from "../../shared/sensor-lab.js";

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
