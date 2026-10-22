import { calibrate } from "./calibration.js";
import { requireModel } from "./data.js";
import type { Recording } from "./data.js";

export function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  // Apply to every string before quoting; negative numeric cells remain numbers.
  // Control bytes are intentionally covered for spreadsheet formula protection.
  const text =
    typeof value === "number"
      ? String(value)
      : /^[\t\r\n]|^[\s\p{Cc}]*[=+\-@\t\r\n]/u.test(value)
        ? `'${value}`
        : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function date(value: number): string {
  requireModel(
    Number.isFinite(value) && value >= 0 && value <= 8.64e15,
    "date",
    "unrepresentable-date",
  );
  return new Date(value).toISOString();
}
/** Export the complete raw recording, never chart-reduced samples. */
export function recordingCsv(record: Recording): string {
  const start = date(record.startedAt),
    end = record.endedAt === undefined ? undefined : date(record.endedAt);
  const rows: Array<Array<string | number | null | undefined>> = [
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
      "source_origin",
      "source_kind",
      "port",
      "sensor_type",
      "mode",
      "mode_name",
      "component",
      "source_name",
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
      "channel_id",
      "provider_id",
      "session_id",
      "source_revision",
      "sequence",
      "gap_from_sequence",
      "gap_to_sequence",
      "gap_reason",
      "program",
      "device_id",
      "device_address",
      "device_serial_number",
      "device_metadata",
    ],
  ];
  for (const frame of record.frames) {
    const received = date(frame.sampledAt);
    record.channels.forEach(({ source, calibration: c }, i) => {
      const raw = frame.values[i] ?? null,
        calibrated = calibrate(raw, c);
      const status =
        frame.status !== "ok"
          ? frame.status
          : raw === null
            ? "invalid"
            : calibrated === null
              ? "invalid-calibration"
              : "ok";
      const legacy = source.origin === "legacy-ev3" ? source.channel : undefined;
      const pub = source.origin === "public" ? source : undefined;
      const device = record.provenance?.device;
      rows.push([
        record.id,
        record.name,
        start,
        end,
        record.reason,
        device?.name,
        device?.transport,
        received,
        frame.elapsedMs,
        source.origin,
        source.channel.kind,
        legacy
          ? legacy.kind === "input"
            ? legacy.port + 1
            : String.fromCharCode(65 + legacy.port)
          : pub?.channel.portId,
        legacy?.type ?? pub?.channel.typeId,
        legacy?.mode ?? pub?.channel.modeId,
        source.channel.modeName,
        legacy?.channel ?? pub?.channel.component,
        source.channel.name,
        source.channel.unit,
        c.unit,
        raw,
        calibrated,
        status,
        frame.segment,
        c.twoPoint ? "true" : "false",
        c.sourceA,
        c.sourceB,
        c.targetA,
        c.targetB,
        c.zeroOffset,
        legacy?.id ?? pub?.channel.channelId,
        pub?.provenance.providerId,
        pub?.provenance.sessionId,
        frame.sourceRevision,
        frame.sequence,
        frame.gap?.fromSequence,
        frame.gap?.toSequence,
        frame.gap?.reason,
        frame.program,
        device?.id,
        device?.address,
        device?.serialNumber,
        device?.metadata ? JSON.stringify(device.metadata) : undefined,
      ]);
    });
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
