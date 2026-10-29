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

import type { SettingsStore } from "./settings.js";

const devicePreferencesDescriptor = "kobrixa.device-preferences";
const devicePreferencesKeys = [
  "kobrixa.connectionMode",
  "kobrixa.rememberWifiAddress",
  "kobrixa.lastWifiAddress",
] as const;
type DevicePreferencesMigrationState = "accepted" | "pending" | "reconciled";

/** One instance per window. Freeze immediately, then explicitly retry observation;
 * acceptance of a capture does not establish main-side migration readiness. */
export function createDevicePreferencesMigration(input: {
  api: LegacyPreferencesApi;
  settings: Pick<SettingsStore, "freezeDevicePreferences">;
  storage: () => Pick<Storage, "getItem">;
}) {
  input.settings.freezeDevicePreferences();
  let disposed = false;
  let challenge: LegacyPreferenceChallenge | undefined;
  let snapshot: LegacyPreferencesSnapshot | undefined;
  let completed: "accepted" | "reconciled" | undefined;
  let running: Promise<DevicePreferencesMigrationState> | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  const assertCurrent = () => {
    if (disposed) throw new Error("Device preference capture disposed.");
  };
  async function attempt(): Promise<DevicePreferencesMigrationState> {
    try {
      assertCurrent();
      if (!challenge) {
        const received = structuredClone(await input.api.challenge(devicePreferencesDescriptor));
        assertCurrent();
        // Validate the entire allowlist and wire identity BEFORE obtaining storage.
        if (
          !received ||
          Object.keys(received).sort().join(",") !== "descriptorId,keys,nonce,scope" ||
          received.descriptorId !== devicePreferencesDescriptor ||
          !Array.isArray(received.keys) ||
          received.keys.length !== devicePreferencesKeys.length ||
          new Set(received.keys).size !== devicePreferencesKeys.length ||
          !devicePreferencesKeys.every((key) => received.keys.includes(key)) ||
          !isLegacyPreferencesSnapshot({
            nonce: received.nonce,
            scope: received.scope,
            entries: received.keys.map((key) => ({ key, raw: null })),
          })
        )
          throw new Error("Invalid device preference challenge.");
        challenge = received;
      }
      if (!snapshot) {
        const captured = collectLegacyPreferences(challenge, input.storage());
        assertCurrent();
        snapshot = captured;
      }
      assertCurrent();
      // Keep the retained copy private even if a test or API implementation mutates its input.
      const result = await input.api.submit(structuredClone(snapshot));
      assertCurrent();
      if (result.state === "accepted" || result.state === "reconciled") {
        completed = result.state;
        return completed;
      }
      return "pending";
    } catch {
      assertCurrent();
      // Unavailable challenges (including already-complete imports) and storage
      // errors do not authorize an empty capture or imply main-side readiness.
      return "pending";
    }
  }
  return {
    retry(): Promise<DevicePreferencesMigrationState> {
      if (disposed) return Promise.reject(new Error("Device preference capture disposed."));
      if (completed) return Promise.resolve(completed);
      if (running) return running;
      const work = new Promise<DevicePreferencesMigrationState>((resolve, reject) => {
        rejectPending = reject;
        // Defer challenge I/O until after running is installed, including reentrant callers.
        void Promise.resolve().then(attempt).then(resolve, reject);
      });
      running = work;
      const clear = () => {
        if (running === work) {
          running = undefined;
          rejectPending = undefined;
        }
      };
      void work.then(clear, clear);
      return work;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rejectPending?.(new Error("Device preference capture disposed."));
      challenge = undefined;
      snapshot = undefined;
      completed = undefined;
    },
  };
}
