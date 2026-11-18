import { createHash } from "node:crypto";
import type {
  LegacyImportDescriptor,
  LegacyImportInput,
  LegacyImportItem,
} from "./import-sources.js";
import {
  importLegacyRecording,
  importLegacyCalibration,
} from "../../../../../../plugins/sensor-lab/src/model/legacy-import.js";

// Same UUID vocabulary as the legacy model, preserving exact case identity.
const filename =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\.json$/;
function descriptor(profile: boolean): LegacyImportDescriptor {
  function map(input: LegacyImportInput): LegacyImportItem {
    const match = filename.exec(input.file?.basename ?? "");
    if (
      input.sourceKind !== "sensor-lab" ||
      !match ||
      input.bytes.byteLength > 8388608 ||
      createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
    )
      throw new Error("invalid-resource");
    const result = profile
      ? importLegacyCalibration(input.bytes, match[1]!)
      : importLegacyRecording(input.bytes, match[1]!);
    if (!result.ok) throw new Error("invalid-resource");
    const bytes = new TextEncoder().encode(JSON.stringify(result.value));
    if (bytes.length > 8388608) throw new Error("size-limit");
    return {
      kind: "record",
      bytes,
      metadata: {
        kind: profile ? "sensor-lab.calibration" : "sensor-lab.recording",
        schemaVersion: 2,
        label: result.value.name,
        mediaType: "application/json",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
  return Object.freeze({
    id: profile ? "kobrixa.sensor-lab.calibrations-import" : "kobrixa.sensor-lab.recordings-import",
    mappingVersion: 1,
    targetSourceKey: "builtin:kobrixa.sensor-lab",
    sourceKind: "sensor-lab",
    fileFormat: profile ? "sensor-lab-profile-v1" : "sensor-lab-recording-v1",
    sourceFormatVersions: Object.freeze([1]),
    targetRecordSchemaVersions: Object.freeze([2]),
    validate(input: LegacyImportInput) {
      try {
        map(input);
        return true;
      } catch {
        return false;
      }
    },
    map,
  });
}
/** Fixed worker/main allowlist. Roots and writer barriers are attached only by the host. */
export const sensorLabImportDescriptors: readonly LegacyImportDescriptor[] = Object.freeze([
  descriptor(false),
  descriptor(true),
]);
