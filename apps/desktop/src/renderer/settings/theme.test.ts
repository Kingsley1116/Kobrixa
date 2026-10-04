// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSettings, settingsStore } from "./settings-state.js";
import { SettingsQuickControls } from "./settings-panel.js";
vi.mock("../keybindings/shortcuts-panel.js", () => ({ ShortcutsPanel: () => null }));
vi.mock("../updates/updates.js", () => ({ UpdatesPanel: () => null }));
it("tracks system appearance and motion, while quick theme toggles persist an explicit choice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
  vi.stubGlobal("matchMedia", (query: string) => {
    let item = media.get(query);
    if (!item) {
      item = { matches: false, listeners: new Set() };
      media.set(query, item);
    }
    const current = item;
    return {
      get matches() {
        return current.matches;
      },
      addEventListener: (_: string, callback: () => void) => current.listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => current.listeners.delete(callback),
    };
  });
  function Probe() {
    const state = useSettings();
    return createElement(
      "div",
      { "data-resolved": state.resolvedTheme, "data-reduced": state.reducedMotion },
      createElement(SettingsQuickControls, {
        settings: state.values,
        resolvedTheme: state.resolvedTheme,
        onChange: (key, value) => settingsStore.set(key, value),
        onOpen: vi.fn(),
        shortcut: "",
      }),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    settingsStore.set("theme", "system");
    settingsStore.set("locale", "en");
    await act(async () => root.render(createElement(Probe)));
    expect(document.documentElement.dataset.theme).toBe("light");
    await act(async () => {
      const item = media.get("(prefers-color-scheme: dark)")!;
      item.matches = true;
      item.listeners.forEach((fn) => fn());
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(settingsStore.getSnapshot().values.theme).toBe("system");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Light"]')!.click(),
    );
    expect(settingsStore.getSnapshot().values.theme).toBe("light");
    await act(async () => {
      const item = media.get("(prefers-reduced-motion: reduce)")!;
      item.matches = true;
      item.listeners.forEach((fn) => fn());
    });
    expect(container.firstElementChild!.getAttribute("data-reduced")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
  expect([...media.values()].every((item) => item.listeners.size === 0)).toBe(true);
});
