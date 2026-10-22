import {
  isLegacyPreferencesSnapshot,
  type LegacyPreferenceChallenge,
  type LegacyPreferencesApi,
  type LegacyPreferencesSnapshot,
} from "../../shared/plugin-persistence.js";

export function collectLegacyPreferences(
  challenge: LegacyPreferenceChallenge,
  storage: Pick<Storage, "getItem">,
): LegacyPreferencesSnapshot {
  const empty: LegacyPreferencesSnapshot = {
    nonce: challenge.nonce,
    scope: { ...challenge.scope },
    entries: challenge.keys.map((key) => ({ key, raw: null })),
  };
  if (!isLegacyPreferencesSnapshot(empty)) throw new Error("Invalid import challenge");
  const snapshot: LegacyPreferencesSnapshot = {
    ...empty,
    entries: challenge.keys.map((key) => ({ key, raw: storage.getItem(key) })),
  };
  if (!isLegacyPreferencesSnapshot(snapshot)) throw new Error("Import snapshot exceeds its limit");
  return snapshot;
}

export async function submitLegacyPreferences(
  api: LegacyPreferencesApi,
  storage: () => Pick<Storage, "getItem">,
  descriptorId: string,
): Promise<"accepted" | "pending" | "reconciled"> {
  try {
    const challenge = await api.challenge(descriptorId);
    const snapshot = collectLegacyPreferences(challenge, storage());
    return (await api.submit(snapshot)).state;
  } catch {
    return "pending";
  }
}
