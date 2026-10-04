// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyboardSettings } from "../keybindings/keyboard-state.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
import { defaultSettings, type Settings } from "./settings.js";
import { SettingsPanel } from "./settings-panel.js";
vi.mock("../keybindings/shortcuts-panel.js", () => ({ ShortcutsPanel: () => null }));
vi.mock("../updates/updates.js", () => ({ UpdatesPanel: () => null }));
let root: Root, container: HTMLDivElement, values: Settings;
const patch = vi.fn();
const requestedCategory = { category: "appearance" as const, request: 0 };
const render = () =>
  root.render(
    createElement(SettingsPanel, {
      settings: values,
      onChange: (key, value) => {
        values = { ...values, [key]: value };
        render();
      },
      onReset: vi.fn(),
      active: true,
      saveError: false,
      onRetry: vi.fn(),
      keyboard: {} as KeyboardSettings,
      requestedCategory,
      updates: undefined,
      updateBusy: false,
      onInstallUpdate: vi.fn(),
      reducedMotion: false,
    }),
  );
const click = async (selector: string) => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click();
  });
};
const search = async (query: string) => {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("kobrixa", {
    device: {
      getPreferences: vi.fn(async () => ({ ...DEFAULT_DEVICE_PREFERENCES })),
      setPreferences: patch,
    },
  });
  Element.prototype.scrollTo = vi.fn();
  patch
    .mockReset()
    .mockImplementation(async (change) => ({ ...DEFAULT_DEVICE_PREFERENCES, ...change }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  values = defaultSettings("en");
  await act(async () => render());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("filters across categories and restores focus when a modified row disappears", async () => {
  await search("word wrap");
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(1);
  await click("#setting-wordWrap");
  await click('input[type="checkbox"]');
  expect(container.querySelector(".setting-footer")!.textContent).toContain("Modified");
  await click('[aria-label="Reset Word wrap"]');
  expect(values.wordWrap).toBe(false);
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(0);
  expect(document.activeElement).toBe(container.querySelector('input[type="search"]'));
});
it("shows disabled dependent settings in search results, with a usable reset", async () => {
  values = { ...values, autoSaveDelay: 5000 };
  await act(async () => render());
  await search("autosavedelay");
  expect(container.querySelector<HTMLButtonElement>("#setting-autoSaveDelay")!.disabled).toBe(true);
  expect(container.textContent).toContain("Select After delay");
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Reset Auto save delay"]')!.disabled,
  ).toBe(false);
  await click('[aria-label="Reset Auto save delay"]');
  expect(values.autoSaveDelay).toBe(1000);
});
it("keeps acknowledged device values after a failed save and retries the same patch", async () => {
  await search("device.usbAutoReconnect");
  patch.mockRejectedValueOnce(new Error("disk full"));
  await click("#setting-usbAutoReconnect");
  expect(container.querySelector("#setting-usbAutoReconnect")!.getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    "Existing values remain active",
  );
  await click('[role="alert"] button');
  expect(patch).toHaveBeenLastCalledWith({ usbAutoReconnect: false });
  expect(container.querySelector("#setting-usbAutoReconnect")!.getAttribute("aria-checked")).toBe(
    "false",
  );
});
it("preserves search text while switching languages", async () => {
  await search("USB 重試 interval");
  values = { ...values, locale: "zh-TW" };
  await act(async () => render());
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe(
    "USB 重試 interval",
  );
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(1);
  expect(container.textContent).toContain("USB 重試間隔");
});
