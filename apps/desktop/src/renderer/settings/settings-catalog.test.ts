import { expect, it, vi } from "vitest";
import { SETTINGS_CATALOG, filterSettings, type CatalogContext } from "./settings-catalog.js";
import { defaultSettings } from "./settings.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
const context = (): CatalogContext => ({
  settings: defaultSettings("en"),
  defaults: defaultSettings("en"),
  device: { ...DEFAULT_DEVICE_PREFERENCES },
  updates: { enabled: true, channel: "stable" },
  reducedMotion: false,
  onChange: vi.fn(),
  onDeviceChange: vi.fn(),
  onUpdateChange: vi.fn(),
});
it("searches bilingual names, descriptions, IDs and normalized multiple keywords", () => {
  const c = context();
  expect(filterSettings(c, "USB 重試 interval", false).map((entry) => entry.id)).toEqual([
    "device.usbRetryInterval",
  ]);
  expect(
    filterSettings(c, "ＫＯＢＲＩＸＡ．ＷＯＲＤＷＲＡＰ", false).map((entry) => entry.id),
  ).toEqual(["kobrixa.wordWrap"]);
  expect(filterSettings(c, "預覽 preview", false).map((entry) => entry.id)).toEqual([
    "updates.channel",
  ]);
  expect(filterSettings(c, "never-matches", false)).toEqual([]);
});
it("compares preferences, not resolved appearances, and resets only the selected source", () => {
  const c = context();
  expect(filterSettings(c, "", true)).toEqual([]);
  c.settings.theme = "system";
  c.settings.wordWrap = true;
  c.device!.usbRetryLimit = 3;
  c.updates!.channel = "preview";
  expect(filterSettings(c, "", true).map((entry) => entry.id)).toEqual([
    "kobrixa.theme",
    "kobrixa.wordWrap",
    "device.usbRetryLimit",
    "updates.channel",
  ]);
  const retry = filterSettings(c, "device.usbRetryLimit", true)[0]!;
  retry.change(c, retry.defaultValue(c));
  expect(c.onDeviceChange).toHaveBeenCalledWith({ usbRetryLimit: "unlimited" });
  expect(c.onChange).not.toHaveBeenCalled();
});
it("keeps dependent preferences discoverable and all IDs unique", () => {
  const c = context();
  c.device!.usbAutoReconnect = false;
  expect(filterSettings(c, "autoSaveDelay", false)[0]!.disabled!(c)).toBeDefined();
  expect(filterSettings(c, "usbRetryInterval", false)[0]!.disabled!(c)).toBeDefined();
  expect(new Set(SETTINGS_CATALOG.map((entry) => entry.controlId)).size).toBe(
    SETTINGS_CATALOG.length,
  );
});
