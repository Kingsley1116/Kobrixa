// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyboardSettings } from "../keybindings/keyboard-state.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
import { DEFAULT_FILE_PREFERENCES, type FilePreferences } from "../../shared/file-preferences.js";
import { defaultSettings, type Settings } from "./settings.js";
import { SettingsPanel } from "./settings-panel.js";
import { useFilePreferences } from "./file-settings.js";
vi.mock("../keybindings/shortcuts-panel.js", () => ({ ShortcutsPanel: () => null }));
vi.mock("../updates/updates.js", () => ({ UpdatesPanel: () => null }));
let root: Root, container: HTMLDivElement, values: Settings;
const patch = vi.fn();
const filePatch = vi.fn();
const getFilePreferences = vi.fn();
let fileValues: FilePreferences;
const requestedCategory = { category: "appearance" as const, request: 0 };
function TestPanel() {
  const filePreferences = useFilePreferences();
  return createElement(SettingsPanel, {
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
    filePreferences,
  });
}
const render = () => root.render(createElement(TestPanel));
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
    workspace: {
      getPreferences: getFilePreferences,
      setPreferences: filePatch,
    },
  });
  Element.prototype.scrollTo = vi.fn();
  patch
    .mockReset()
    .mockImplementation(async (change) => ({ ...DEFAULT_DEVICE_PREFERENCES, ...change }));
  fileValues = { ...DEFAULT_FILE_PREFERENCES };
  getFilePreferences.mockReset().mockImplementation(async () => ({ ...fileValues }));
  filePatch.mockReset().mockImplementation(async (change) => {
    fileValues = { ...fileValues, ...change };
    return { ...fileValues };
  });
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
it("shares acknowledged file preferences across categories and resets one modified value", async () => {
  await search("files.externalChangesEnabled");
  expect(getFilePreferences).toHaveBeenCalledOnce();
  await click("#setting-externalChangesEnabled");
  expect(fileValues.externalChangesEnabled).toBe(false);
  expect(container.querySelector(".setting-footer")!.textContent).toContain("Modified");
  await click('input[type="checkbox"]');
  await click('[aria-label="Reset External change detection"]');
  expect(filePatch).toHaveBeenLastCalledWith({ externalChangesEnabled: true });
  expect(fileValues.externalChangesEnabled).toBe(true);
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(0);
  expect(getFilePreferences).toHaveBeenCalledOnce();
});
it("disables detection dependencies and keeps retention available when recording is off", async () => {
  await search("files.");
  expect(container.querySelectorAll('[data-setting-id^="files."]')).toHaveLength(8);
  await click("#setting-externalChangesEnabled");
  expect(
    container.querySelector<HTMLButtonElement>("#setting-externalChangeInterval")!.disabled,
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>("#setting-externalChangeAutoReload")!.disabled,
  ).toBe(true);
  await click("#setting-localHistoryEnabled");
  for (const key of ["Days", "Versions", "SnapshotMiB", "WorkspaceMiB"])
    expect(
      container.querySelector<HTMLButtonElement>(`#setting-localHistory${key}`)!.disabled,
    ).toBe(false);
  expect(container.textContent).toContain("existing history remains available");
  expect(container.textContent).toContain("does not remove existing larger versions");
});
it("keeps effective file values after failure and retries the exact rejected change", async () => {
  await search("files.localHistoryEnabled");
  filePatch.mockRejectedValueOnce(new Error("disk full"));
  await click("#setting-localHistoryEnabled");
  expect(
    container.querySelector("#setting-localHistoryEnabled")!.getAttribute("aria-checked"),
  ).toBe("true");
  expect(container.querySelector('[data-preferences-error="files"]')!.textContent).toContain(
    "Existing values remain active",
  );
  await click('[data-preferences-error="files"] button');
  expect(filePatch).toHaveBeenLastCalledWith({ localHistoryEnabled: false });
  expect(
    container.querySelector("#setting-localHistoryEnabled")!.getAttribute("aria-checked"),
  ).toBe("false");
  expect(container.querySelector('[data-preferences-error="files"]')).toBeNull();
});
it("does not apply a pending file preference and blocks concurrent changes", async () => {
  await search("files.");
  let complete: (preferences: FilePreferences) => void = () => {};
  filePatch.mockImplementationOnce(
    () =>
      new Promise<FilePreferences>((resolve) => {
        complete = resolve;
      }),
  );
  await click("#setting-externalChangesEnabled");
  expect(
    container.querySelector("#setting-externalChangesEnabled")!.getAttribute("aria-checked"),
  ).toBe("true");
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    true,
  );
  await click("#setting-localHistoryEnabled");
  expect(filePatch).toHaveBeenCalledOnce();
  await act(async () => complete({ ...fileValues, externalChangesEnabled: false }));
  expect(
    container.querySelector("#setting-externalChangesEnabled")!.getAttribute("aria-checked"),
  ).toBe("false");
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    false,
  );
});
it("can retry a failed initial file preference load without accepting placeholder controls", async () => {
  await act(async () => root.render(null));
  getFilePreferences.mockRejectedValueOnce(new Error("read failed"));
  await act(async () => render());
  await search("files.localHistoryEnabled");
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    true,
  );
  expect(container.querySelector('[data-preferences-error="files"]')).not.toBeNull();
  await click('[data-preferences-error="files"] button');
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    false,
  );
  expect(
    container.querySelector("#setting-localHistoryEnabled")!.getAttribute("aria-checked"),
  ).toBe("true");
});
