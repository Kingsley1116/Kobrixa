import { useEffect, useState, useSyncExternalStore } from "react";
import { applyAppearance, SettingsStore } from "./settings.js";
export const settingsStore = new SettingsStore(() => window.localStorage, navigator.language);
export function useSettings() {
  const snapshot = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
  const [systemReduced, setSystemReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setSystemReduced(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => applyAppearance(snapshot.values, document.documentElement), [snapshot.values]);
  return { ...snapshot, reducedMotion: snapshot.values.motion === "reduce" || systemReduced };
}
