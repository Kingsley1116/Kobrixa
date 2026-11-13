import type {
  LegacyPreferencesApi,
  LegacyPreferencesSnapshot,
} from "../../apps/desktop/src/shared/plugin-persistence.js";

export const ORIGINAL_PREFERENCE =
  '{"formatVersion":1,"value":"original preference bytes — unchanged"}';
/** Only documented old-scope guard failures, optionally wrapped by this Electron IPC. */
export function isPreferenceScopeRejection(error: unknown): boolean {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.startsWith("Error: ")) message = message.slice(7);
  const prefix = "Error invoking remote method 'persistence:legacy-preferences-submit': ";
  if (message.startsWith(prefix)) message = message.slice(prefix.length);
  if (message.startsWith("Error: ")) message = message.slice(7);
  return message === "stale" || message === "Invalid preference scope";
}

/** Fixture only. The injected API at runtime is the unmodified production preload. */
export function preferenceCapture(
  api: LegacyPreferencesApi,
  storage: Pick<Storage, "getItem" | "setItem">,
) {
  let retained: LegacyPreferencesSnapshot | undefined;
  let busy: Promise<unknown> | undefined;
  let disposed = false;
  return {
    seed() {
      if (disposed) throw Error("retired capture document");
      // Seed only a fresh profile. Never overwrite a surviving original.
      const prior = storage.getItem("test.preference");
      if (prior === null) storage.setItem("test.preference", ORIGINAL_PREFERENCE);
      else if (prior !== ORIGINAL_PREFERENCE) throw Error("changed original preference");
    },
    capture(oldSnapshot?: LegacyPreferencesSnapshot) {
      if (disposed) return Promise.reject(Error("retired capture document"));
      if (busy) return busy;
      busy = (async () => {
        if (oldSnapshot) {
          let rejected = false;
          try {
            await api.submit(oldSnapshot);
          } catch (error) {
            if (!isPreferenceScopeRejection(error)) throw error;
            rejected = true;
          }
          if (!rejected) throw Error("old window nonce unexpectedly accepted");
        }
        const challenge = await api.challenge("test.synthetic-preferences");
        if (disposed) throw Error("retired capture document");
        if (
          challenge.descriptorId !== "test.synthetic-preferences" ||
          challenge.keys.length !== 1 ||
          challenge.keys[0] !== "test.preference"
        )
          throw Error("wrong preference allowlist");
        if (!retained) {
          const raw = storage.getItem("test.preference"); // Exceptions propagate; never fabricate null.
          if (raw !== ORIGINAL_PREFERENCE) throw Error("missing or changed original preference");
          retained = structuredClone({
            nonce: challenge.nonce,
            scope: challenge.scope,
            entries: [{ key: "test.preference", raw }],
          });
        }
        if (
          retained.nonce !== challenge.nonce ||
          JSON.stringify(retained.scope) !== JSON.stringify(challenge.scope)
        )
          throw Error("changed challenge for retained snapshot");
        const result = await api.submit(structuredClone(retained));
        if (disposed) throw Error("retired capture document");
        return {
          snapshot: structuredClone(retained),
          result,
          original: storage.getItem("test.preference"),
        };
      })().finally(() => {
        busy = undefined;
      });
      return busy;
    },
    dispose() {
      disposed = true;
    },
  };
}
if (typeof window !== "undefined") {
  const capture = preferenceCapture(window.kobrixa.plugins.legacyPreferences, window.localStorage);
  Object.defineProperty(window, "importPreferences", { value: capture });
  window.addEventListener("pagehide", () => capture.dispose(), { once: true });
}
