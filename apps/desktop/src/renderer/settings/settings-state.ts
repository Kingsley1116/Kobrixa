import { useEffect, useState, useSyncExternalStore } from "react";
import { applyAppearance, SettingsStore } from "./settings.js";
import { resolveTheme } from "./theme.js";
export const settingsStore = new SettingsStore(() => window.localStorage, navigator.language);
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export function useSettings() {
  const snapshot = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
  const systemReduced = useMedia("(prefers-reduced-motion: reduce)");
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  useEffect(
    () => applyAppearance(snapshot.values, document.documentElement, systemDark),
    [snapshot.values, systemDark],
  );
  return {
    ...snapshot,
    resolvedTheme: resolveTheme(snapshot.values.theme, systemDark),
    reducedMotion: snapshot.values.motion === "reduce" || systemReduced,
  };
}
