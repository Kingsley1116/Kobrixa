import type { LegacyImportDescriptor } from "./import-sources.js";
import { snapshotBytes, snapshotDigest } from "./import-sources.js";
export const syntheticImportDescriptor: LegacyImportDescriptor = {
  id: "test.synthetic-import",
  mappingVersion: 1,
  targetSourceKey: "builtin:test.synthetic",
  sourceKind: "sensor-lab",
  sourceFormatVersions: [1],
  targetRecordSchemaVersions: [1],
  validate(input) {
    return input.sourceKind === "sensor-lab" && input.bytes.byteLength <= 8388608;
  },
  map(input) {
    return {
      kind: "record",
      metadata: {
        kind: "test.synthetic",
        schemaVersion: 1,
        label: "Synthetic import fixture",
        mediaType: "application/octet-stream",
        byteLength: input.bytes.byteLength,
        sha256: input.sha256,
      },
      bytes: input.bytes,
    };
  },
};
export const syntheticPreferencesImportDescriptor: LegacyImportDescriptor = {
  id: "test.synthetic-preferences",
  mappingVersion: 1,
  targetSourceKey: "builtin:test.preferences",
  sourceKind: "renderer-preferences",
  sourceFormatVersions: [1],
  targetRecordSchemaVersions: [1],
  rendererKeyAllowlist: ["test.preference"],
  validate(input) {
    if (input.sourceKind !== "renderer-preferences") return false;
    try {
      const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
      return (
        Buffer.from(snapshotBytes(snapshot, ["test.preference"])).equals(input.bytes) &&
        snapshotDigest(snapshot, ["test.preference"]) === input.sha256
      );
    } catch {
      return false;
    }
  },
  map(input) {
    if (!syntheticPreferencesImportDescriptor.validate(input)) throw new Error("invalid-resource");
    return {
      kind: "record",
      metadata: {
        kind: "test.preferences",
        schemaVersion: 1,
        label: "Synthetic preferences fixture",
        mediaType: "application/json",
        byteLength: input.bytes.length,
        sha256: input.sha256,
      },
      bytes: input.bytes.slice(),
    };
  },
};
