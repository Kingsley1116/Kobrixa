import {
  normalizeSettingsValues,
  settingsValidationText,
  validateSettingsValues,
} from "../../../../../../packages/plugin-protocol/src/settings.js";
import { createHash } from "node:crypto";
import type {
  LegacyImportDescriptor,
  LegacyImportInput,
  LegacyImportItem,
  LegacyPreferencesSnapshot,
} from "./import-sources.js";
import { IMPORT_LIMITS, snapshotBytes } from "./import-sources.js";
import { devicePreferencesEvidenceSchema, devicePreferencesEvidenceBytes } from "./namespace.js";
import {
  devicePreferencesResource,
  devicePreferenceValues,
  DEVICE_PREFERENCES_SOURCE,
} from "./device-preferences-port.js";

export const DEVICE_RENDERER_KEYS = Object.freeze([
  "kobrixa.connectionMode",
  "kobrixa.rememberWifiAddress",
  "kobrixa.lastWifiAddress",
]);
const providerKeys = new Set(
  devicePreferencesResource.fields.slice(0, 6).map((field) => field.key),
);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function decode(input: LegacyImportInput, kind: LegacyImportInput["sourceKind"]) {
  if (
    input.sourceKind !== kind ||
    input.bytes.length > IMPORT_LIMITS.preferenceBytes ||
    sha256(input.bytes) !== input.sha256
  )
    throw new Error("invalid-source-evidence");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)) as unknown;
}
/** Pure full-candidate mapping; authority and original evidence are worker-owned. */
export function mapDeviceSettingsSnapshot(input: {
  device: { state: "absent" } | { state: "present"; original: LegacyImportInput };
  renderer: LegacyImportInput;
}): {
  item: Extract<LegacyImportItem, { kind: "settings" }>;
  defaultedKeys: string[];
  originals: { deviceSha256: string | null; rendererSha256: string; rendererNonce: string };
} {
  const values = new Map(
    devicePreferencesResource.fields.map((field) => [field.key, field.default]),
  );
  const defaulted = new Set(values.keys());
  if (input.device.state === "present") {
    if (input.device.original.file?.basename !== "device-settings.json")
      throw new Error("invalid-source-file");
    const raw = decode(input.device.original, "device-settings");
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !providerKeys.has(key))
    )
      throw new Error("invalid-device-settings");
    for (const { key, value } of validateSettingsValues(
      devicePreferencesResource,
      Object.entries(raw).map(([key, value]) => ({ key, value })),
      false,
    )) {
      // Validate the complete merge below; no legacy loader catch-all defaults.
      values.set(key, value);
      defaulted.delete(key);
    }
  }
  const snapshot = decode(input.renderer, "renderer-preferences") as LegacyPreferencesSnapshot;
  if (!Buffer.from(snapshotBytes(snapshot, DEVICE_RENDERER_KEYS)).equals(input.renderer.bytes))
    throw new Error("noncanonical-renderer-evidence");
  for (const { key, raw } of snapshot.entries) {
    if (raw === null) continue;
    const target = key.slice("kobrixa.".length);
    let value: string | boolean = raw;
    if (target === "rememberWifiAddress") {
      if (raw !== "true" && raw !== "false") throw new Error("invalid-renderer-preference");
      value = raw === "true";
    }
    values.set(target, value);
    defaulted.delete(target);
  }
  // Scalar validation precedes normalization; canonical validation follows it.
  const merged = normalizeSettingsValues(
    devicePreferencesResource,
    [...values].map(([key, value]) => ({ key, value })),
  ).sort((a, b) => (a.key < b.key ? -1 : 1));
  devicePreferenceValues({ schemaVersion: 1, revision: null, values: merged });
  return {
    item: { kind: "settings", schemaVersion: 1, values: merged },
    defaultedKeys: [...defaulted].sort(),
    originals: {
      deviceSha256: input.device.state === "present" ? input.device.original.sha256 : null,
      rendererSha256: input.renderer.sha256,
      rendererNonce: snapshot.nonce,
    },
  };
}

export const DEVICE_IMPORT_ID = "kobrixa.device-preferences";
export const deviceImportSettingsAuthority = Object.freeze({
  schemaVersion: 1,
  validationDigest: sha256(Buffer.from(settingsValidationText(devicePreferencesResource))),
});
function mapCombined(input: LegacyImportInput): LegacyImportItem {
  if (
    input.sourceKind !== "renderer-preferences" ||
    input.bytes.length > 196608 ||
    sha256(input.bytes) !== input.sha256
  )
    throw new Error("invalid-source-evidence");
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  const evidence = devicePreferencesEvidenceSchema.parse(raw);
  if (!devicePreferencesEvidenceBytes(evidence).equals(input.bytes))
    throw new Error("noncanonical-combined-evidence");
  const mapped = mapDeviceSettingsSnapshot({
    device:
      evidence.device.state === "absent"
        ? { state: "absent" }
        : {
            state: "present",
            original: {
              sourceKind: "device-settings",
              bytes: Buffer.from(evidence.device.base64, "base64"),
              sha256: evidence.device.sha256,
              file: { basename: "device-settings.json" },
            },
          },
    renderer: {
      sourceKind: "renderer-preferences",
      bytes: Buffer.from(evidence.renderer.base64, "base64"),
      sha256: evidence.renderer.digest,
    },
  });
  if (JSON.stringify(mapped.defaultedKeys) !== JSON.stringify(evidence.defaultedKeys))
    throw new Error("default-evidence-binding");
  return mapped.item;
}
export const deviceSettingsImportDescriptor: LegacyImportDescriptor = Object.freeze({
  id: DEVICE_IMPORT_ID,
  mappingVersion: 1,
  targetSourceKey: DEVICE_PREFERENCES_SOURCE,
  sourceKind: "renderer-preferences",
  combinedSource: "device-preferences-v1",
  sourceFormatVersions: [1],
  targetSettingsSchemaVersion: 1,
  targetRecordSchemaVersions: [],
  rendererKeyAllowlist: DEVICE_RENDERER_KEYS,
  validate(input: LegacyImportInput) {
    try {
      mapCombined(input);
      return true;
    } catch {
      return false;
    }
  },
  map: mapCombined,
});
