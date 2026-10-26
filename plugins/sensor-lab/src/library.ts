import { createHash } from "node:crypto";
import type { RecordMeta } from "@kobrixa/plugin-protocol";
import { LabStorageError, type LabStorage } from "./persistence.js";
import {
  object,
  text,
  snapshotRecording,
  snapshotPublicSource,
  validateLegacyChannel,
  calibrationSnapshot,
  immutableSnapshot,
  type Recording,
  type CalibrationProfile,
} from "./model/data.js";

export type LabRecordKind = "sensor-lab.recording" | "sensor-lab.calibration";
function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new LabStorageError(result.error.code, result.error.message);
  return result.value;
}
function metadata(meta: RecordMeta): void {
  if (
    !["sensor-lab.recording", "sensor-lab.calibration"].includes(meta.kind) ||
    meta.schemaVersion !== 2 ||
    meta.mediaType !== "application/json" ||
    !Number.isSafeInteger(meta.byteLength) ||
    meta.byteLength < 0 ||
    meta.byteLength > 8388608
  )
    throw new LabStorageError("schema", "Unsupported Lab record");
}
function profile(raw: unknown): CalibrationProfile {
  const input = object(raw, ["schemaVersion", "id", "name", "source", "calibration"]);
  if (input.schemaVersion !== 2)
    throw new LabStorageError("schema", "Unsupported calibration schema");
  text(input.id, 160, "id", true);
  text(input.name, 160, "name", true);
  const source = input.source as CalibrationProfile["source"];
  if (source?.origin === "public") snapshotPublicSource(source.channel, source.provenance);
  else if (source?.origin === "legacy-ev3") validateLegacyChannel(source.channel);
  else throw new LabStorageError("schema", "Unsupported calibration source");
  return immutableSnapshot({
    schemaVersion: 2,
    id: input.id as string,
    name: input.name as string,
    source,
    calibration: calibrationSnapshot(input.calibration),
  });
}
/** Storage IDs/revisions remain host metadata; payload UUIDs are never used as read handles. */
export class LabLibrary {
  constructor(private readonly storage: LabStorage) {}
  async list(kind: LabRecordKind, cursor?: string, signal?: AbortSignal) {
    const page = value(
      await this.storage.list({ kind, limit: 50, ...(cursor ? { cursor } : {}) }, signal),
    );
    if (page.entries.length > 50 || (cursor && page.nextCursor === cursor))
      throw new LabStorageError("page", "Invalid library page");
    for (const meta of page.entries) {
      metadata(meta);
      if (meta.kind !== kind) throw new LabStorageError("identity", "Foreign library kind");
    }
    return immutableSnapshot(page);
  }
  async read(meta: RecordMeta, signal?: AbortSignal): Promise<Recording | CalibrationProfile> {
    meta = immutableSnapshot(meta);
    metadata(meta);
    const opened = value(
      await this.storage.openRead(
        { id: meta.id, expectedRevision: meta.revision, schemaVersion: 2 },
        signal,
      ),
    );
    try {
      metadata(opened.record);
      if (
        ["id", "revision", "kind", "byteLength", "sha256"].some(
          (key) => opened.record[key as keyof RecordMeta] !== meta[key as keyof RecordMeta],
        )
      )
        throw new LabStorageError("identity", "Read does not match selected record revision");
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const chunk = value(
          await this.storage.readChunk({ read: opened.read, offset, maxBytes: 262144 }, signal),
        );
        const bytes = Buffer.from(chunk.data, "base64");
        if (
          bytes.toString("base64") !== chunk.data ||
          chunk.offset !== offset ||
          chunk.nextOffset !== offset + bytes.length ||
          bytes.length > 262144 ||
          chunk.nextOffset > meta.byteLength ||
          (!chunk.eof && !bytes.length)
        )
          throw new LabStorageError("offset", "Invalid record read progress");
        chunks.push(bytes);
        offset = chunk.nextOffset;
        if (chunk.eof) break;
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== meta.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== meta.sha256
      )
        throw new LabStorageError("checksum", "Record bytes do not match selected revision");
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (meta.kind === "sensor-lab.calibration") return profile(raw);
      object(
        raw,
        [
          "schemaVersion",
          "id",
          "name",
          "startedAt",
          "durationMs",
          "frameCount",
          "channels",
          "frames",
        ],
        ["endedAt", "reason", "recordingOrigin", "provenance"],
      );
      return snapshotRecording(raw as Recording);
    } finally {
      // Independent cleanup remains possible after the view signal was cancelled.
      await this.storage.closeRead({ read: opened.read }).catch(() => {});
    }
  }
  async remove(
    meta: RecordMeta,
    protectedIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    meta = immutableSnapshot(meta);
    metadata(meta);
    if (protectedIds.has(meta.id) || meta.checkpoint === "open")
      throw new LabStorageError("active", "Active or unresolved recording cannot be deleted");
    value(await this.storage.delete({ id: meta.id, expectedRevision: meta.revision }, signal));
  }
}
