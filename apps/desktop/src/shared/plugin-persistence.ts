import type { Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";
export interface PersistenceRecoveryBridge {
  snapshot(input: { itemId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  act(input: {
    itemId: Handle;
    optionId: Handle;
  }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  onOpen(listener: (input: { itemId: Handle }) => void): () => void;
  onChanged(listener: () => void): () => void;
}

/** P150 forward types only. Public storage methods are introduced by P170. */
export type { DrainReport } from "@kobrixa/plugin-runtime";

import type {
  LegacyPreferencesSnapshot,
  LegacyPreferenceChallenge,
  LegacyImportHostPort,
} from "../main/plugins/persistence/import-sources.js";
export type { LegacyPreferencesSnapshot } from "../main/plugins/persistence/import-sources.js";

export type { LegacyPreferenceChallenge } from "../main/plugins/persistence/import-sources.js";
export interface LegacyPreferencesApi {
  challenge(descriptorId: string): Promise<LegacyPreferenceChallenge>;
  submit(
    snapshot: LegacyPreferencesSnapshot,
  ): ReturnType<LegacyImportHostPort["acceptPreferencesEvidence"]>;
}

const importHandle170 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder170 = new TextEncoder();

function exactObject170(
  value: unknown,
  names: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

export function isLegacyPreferencesSnapshot(value: unknown): value is LegacyPreferencesSnapshot {
  if (!exactObject170(value, ["nonce", "scope", "entries"])) return false;
  if (typeof value.nonce !== "string" || !importHandle170.test(value.nonce)) return false;
  if (!exactObject170(value.scope, ["hostEpoch", "workbenchInstance"])) return false;
  if (
    ![value.scope.hostEpoch, value.scope.workbenchInstance].every(
      (item) => typeof item === "string" && importHandle170.test(item),
    )
  )
    return false;
  if (!Array.isArray(value.entries) || value.entries.length > 128) return false;
  const keys = new Set<string>();
  let codeUnits = 0;
  for (const entry of value.entries) {
    if (!exactObject170(entry, ["key", "raw"])) return false;
    if (
      typeof entry.key !== "string" ||
      entry.key.length === 0 ||
      entry.key.includes("\0") ||
      encoder170.encode(entry.key).byteLength > 128
    )
      return false;
    if (entry.raw !== null && typeof entry.raw !== "string") return false;
    if (keys.has(entry.key)) return false;
    codeUnits += entry.key.length + (typeof entry.raw === "string" ? entry.raw.length : 0);
    if (codeUnits > 64 * 1024) return false;
    keys.add(entry.key);
  }
  return encoder170.encode(JSON.stringify(value)).byteLength <= 64 * 1024;
}

import type { BoundSettingsService } from "@kobrixa/plugin-runtime";
import type { Sha256 } from "@kobrixa/plugin-protocol";
export type SettingsApi170 = Omit<BoundSettingsService, "open"> & {
  open(input: {
    sourceKey: string;
    resourceDigest: Sha256;
  }): ReturnType<BoundSettingsService["open"]>;
};
export type { SettingsFormBinding, PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";
