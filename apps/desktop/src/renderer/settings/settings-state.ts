import { useEffect, useState, useSyncExternalStore } from "react";
import { applyAppearance, SettingsStore } from "./settings.js";
import { resolveTheme } from "./theme.js";
import type { CoreRecoveryPort, PluginUiBridge } from "@kobrixa/plugin-runtime";
import {
  createPluginUiRendererHost,
  rendererSession,
  type PluginUiRendererHost,
} from "../plugin-ui/host-ports.js";
import type { RendererSession } from "../plugin-ui/bootstrap.js";
import { contributionKey } from "../plugin-ui/catalog-store.js";
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

export interface PluginUiWindow {
  readonly host: PluginUiRendererHost;
  readonly session: RendererSession;
  readonly recovery: CoreRecoveryPort;
  readonly ready: Promise<void>;
  gate(name: "settings" | "modal", blocked: boolean): void;
  dispose(): void;
}

export function createPluginUiWindow(input: {
  bridge: PluginUiBridge;
  recovery: CoreRecoveryPort;
  settings: SettingsStore;
  storage: Pick<Storage, "getItem" | "setItem">;
}): PluginUiWindow {
  const host = createPluginUiRendererHost(input);
  const session = rendererSession(host);
  const gates = new Set<string>();
  let disposed = false;
  const sync = (next = input.settings.getSnapshot().values) =>
    session.showPane(
      next.rightPanel === "plugins" && gates.size === 0,
      next.rightPanel === null ? "collapse" : "sidebar",
    );
  const offTransition = input.settings.beforeChange(sync);
  const offSelection = session.subscribe(() => {
    const key = session.selectedKey();
    if (!key) return;
    try {
      input.storage.setItem("kobrixa.layout.pluginPanel", key);
    } catch {
      // Layout persistence is optional; never persist commands, drafts or runtime bindings.
    }
  });
  const ready = host.start().then(() => {
    if (disposed) return;
    try {
      const raw = input.storage.getItem("kobrixa.layout.pluginPanel");
      if (raw && raw.length <= 1024) {
        const identity: unknown = JSON.parse(raw);
        if (
          Array.isArray(identity) &&
          identity.length === 2 &&
          identity.every((part) => typeof part === "string")
        ) {
          const entry = session.catalog
            .getSnapshot()
            .entries.find(
              (item) =>
                item.kind === "panel" &&
                item.availability === "available" &&
                contributionKey(item) === JSON.stringify(identity),
            );
          if (entry) session.select(entry);
        }
      }
    } catch {
      // Corrupt or inaccessible layout cannot activate a source.
    }
    sync();
  });
  return {
    host,
    session,
    recovery: input.recovery,
    ready,
    gate(name, blocked) {
      if (disposed) return;
      const old = gates.has(name);
      if (blocked) gates.add(name);
      else gates.delete(name);
      if (old !== blocked) sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offTransition();
      offSelection();
      host.dispose();
    },
  };
}

let uiWindow: PluginUiWindow | undefined;
export function pluginUiWindow(): PluginUiWindow {
  if (uiWindow) return uiWindow;
  const owner = createPluginUiWindow({
    bridge: window.kobrixa.plugins.ui,
    recovery: window.kobrixa.plugins.recovery,
    settings: settingsStore,
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
  });
  const environment = (reason: "document" | "window") =>
    owner.session.environment(!document.hidden, document.hasFocus(), reason);
  const visibility = () => environment("document");
  const focus = () => environment("window");
  // This owner belongs to the window, so React remounts do not create a second subscription.
  const current: PluginUiWindow = {
    ...owner,
    dispose() {
      owner.dispose();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      window.removeEventListener("pagehide", dispose);
      if (uiWindow === current) uiWindow = undefined;
    },
  };
  const dispose = () => current.dispose();
  uiWindow = current;
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", focus);
  window.addEventListener("pagehide", dispose, { once: true });
  environment("document");
  return current;
}
