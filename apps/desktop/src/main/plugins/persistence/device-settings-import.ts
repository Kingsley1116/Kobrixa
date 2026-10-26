import { validateSettingsValues } from "../../../../../../packages/plugin-protocol/src/settings.js";
import { createHash } from "node:crypto";
import type {
  LegacyImportInput,
  LegacyImportItem,
  LegacyPreferencesSnapshot,
} from "./import-sources.js";
import { IMPORT_LIMITS, snapshotBytes } from "./import-sources.js";
import { devicePreferencesResource, devicePreferenceValues } from "./device-preferences-port.js";

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
/** Pure two-source mapping prerequisite, NOT an admitted import descriptor.
 * The current worker cannot bind these two originals into a single plan. Only a
 * future worker combined-source resolver may supply validated absence, after the
 * writer barrier and anchored filesystem check. This helper grants no authority,
 * publishes no receipt/complete marker, and must not be run as two replacements. */
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
  validateSettingsValues(
    devicePreferencesResource,
    [...values].map(([key, value]) => ({ key, value })),
    true,
  );
  // Historical remember=false discards addresses; both originals remain evidence.
  if (values.get("rememberWifiAddress") === false) values.set("lastWifiAddress", "");
  const merged = [...values]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
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
