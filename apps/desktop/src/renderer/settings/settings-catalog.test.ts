import { expect, it, vi } from "vitest";
import { SETTINGS_CATALOG, filterSettings, type CatalogContext } from "./settings-catalog.js";
import { defaultSettings } from "./settings.js";
import { DEFAULT_FILE_PREFERENCES } from "../../shared/file-preferences.js";
const context = (): CatalogContext => ({
  settings: defaultSettings("en"),
  defaults: defaultSettings("en"),
  files: { ...DEFAULT_FILE_PREFERENCES },
  updates: { enabled: true, channel: "stable" },
  reducedMotion: false,
  onChange: vi.fn(),
  onFileChange: vi.fn(),
  onUpdateChange: vi.fn(),
});
it("searches bilingual names, descriptions, IDs and normalized multiple keywords", () => {
  const c = context();
  expect(filterSettings(c, "外部 interval", false).map((entry) => entry.id)).toEqual([
    "files.externalChangeInterval",
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
  c.files!.localHistoryDays = 90;
  c.updates!.channel = "preview";
  expect(filterSettings(c, "", true).map((entry) => entry.id)).toEqual([
    "kobrixa.theme",
    "kobrixa.wordWrap",
    "files.localHistoryDays",
    "updates.channel",
  ]);
  const retry = filterSettings(c, "files.localHistoryDays", true)[0]!;
  retry.change(c, retry.defaultValue(c));
  expect(c.onFileChange).toHaveBeenCalledWith({ localHistoryDays: 30 });
  expect(c.onChange).not.toHaveBeenCalled();
});
it("keeps dependent preferences discoverable and all IDs unique", () => {
  const c = context();
  c.files!.externalChangesEnabled = false;
  expect(filterSettings(c, "autoSaveDelay", false)[0]!.disabled!(c)).toBeDefined();
  expect(filterSettings(c, "externalChangeInterval", false)[0]!.disabled!(c)).toBeDefined();
  expect(new Set(SETTINGS_CATALOG.map((entry) => entry.controlId)).size).toBe(
    SETTINGS_CATALOG.length,
  );
});
it("finds bilingual file settings and resets only the selected file preference", () => {
  const c = context();
  expect(filterSettings(c, "外部 interval", false).map((entry) => entry.id)).toEqual([
    "files.externalChangeInterval",
  ]);
  expect(filterSettings(c, "snapshot 容量", false).map((entry) => entry.id)).toEqual([
    "files.localHistorySnapshotMiB",
  ]);
  c.files!.localHistoryDays = 90;
  const entries = filterSettings(c, "files.", true);
  expect(entries.map((entry) => entry.id)).toEqual(["files.localHistoryDays"]);
  entries[0]!.change(c, entries[0]!.defaultValue(c));
  expect(c.onFileChange).toHaveBeenCalledWith({ localHistoryDays: 30 });
  expect(c.onChange).not.toHaveBeenCalled();
});
it("disables polling dependencies but allows retention changes while recording is off", () => {
  const c = context();
  c.files!.externalChangesEnabled = false;
  c.files!.localHistoryEnabled = false;
  for (const id of ["externalChangeInterval", "externalChangeAutoReload"])
    expect(filterSettings(c, `files.${id}`, false)[0]!.disabled!(c)).toBeDefined();
  for (const id of [
    "localHistoryDays",
    "localHistoryVersions",
    "localHistorySnapshotMiB",
    "localHistoryWorkspaceMiB",
  ])
    expect(filterSettings(c, `files.${id}`, false)[0]!.disabled?.(c)).toBeUndefined();
});

it("has no legacy connection or device preference writer in any category", () => {
  expect(
    SETTINGS_CATALOG.filter(
      (entry) =>
        entry.id.startsWith("device.") ||
        [
          "kobrixa.connectionMode",
          "kobrixa.rememberWifiAddress",
          "kobrixa.lastWifiAddress",
        ].includes(entry.id),
    ),
  ).toEqual([]);
  expect(filterSettings(context(), "revealDeviceErrors", false)).toHaveLength(1);
});
