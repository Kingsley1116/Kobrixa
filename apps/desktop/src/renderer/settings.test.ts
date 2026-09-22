import { describe, expect, it, vi } from "vitest";
import { defaultSettings, readSettings, SETTINGS_KEYS, SettingsStore } from "./settings.js";
function storage(values: Record<string, string> = {}) {
  return {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values[key] = value;
    }),
  };
}
describe("application settings", () => {
  it("uses offline defaults and the system language only until the user chooses", () => {
    const s = storage(),
      store = new SettingsStore(() => s, "zh-Hant-TW");
    expect(store.getSnapshot()).toEqual({
      values: defaultSettings("zh-Hant-TW"),
      saveError: false,
    });
    expect(store.getSnapshot().values).toMatchObject({
      locale: "zh-TW",
      theme: "dark",
      uiScale: 100,
      codeSize: 16,
      motion: "system",
      wordWrap: false,
      indentSize: 2,
    });
    store.set("locale", "en");
    expect(new SettingsStore(() => s, "zh-TW").getSnapshot().values.locale).toBe("en");
  });
  it("preserves legacy appearance and layout values, clamping an old EV3 pane width", () => {
    const s = storage({
      "kobrixa.theme": "light",
      "kobrixa.uiScale": "125",
      "kobrixa.codeSize": "20",
      "kobrixa.layout.deviceWidth": "280",
      "kobrixa.layout.filesWidth": "300",
      "kobrixa.layout.filesOpen": "false",
      "kobrixa.tools.tab": "files",
    });
    expect(readSettings(s, "en")).toMatchObject({
      theme: "light",
      uiScale: 125,
      codeSize: 20,
      deviceWidth: 320,
      filesWidth: 300,
      filesOpen: false,
      toolTab: "files",
    });
  });
  it("rejects invalid values without erasing unrelated valid preferences", () => {
    const s = storage(
      Object.fromEntries(Object.values(SETTINGS_KEYS).map((key) => [key, "invalid"])),
    );
    s.setItem(SETTINGS_KEYS.locale, "zh-TW");
    s.setItem(SETTINGS_KEYS.filesOpen, "false");
    expect(readSettings(s, "en")).toEqual({ ...defaultSettings("zh-TW"), filesOpen: false });
    s.setItem(SETTINGS_KEYS.deviceWidth, "");
    expect(readSettings(s, "en").deviceWidth).toBe(360);
  });
  it("updates subscribers immediately and persists new editor and motion preferences", () => {
    const s = storage(),
      store = new SettingsStore(() => s, "en"),
      listener = vi.fn();
    const stop = store.subscribe(listener);
    store.set("indentSize", 4);
    store.set("wordWrap", (old) => !old);
    store.set("motion", "reduce");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(new SettingsStore(() => s, "en").getSnapshot().values).toMatchObject({
      indentSize: 4,
      wordWrap: true,
      motion: "reduce",
    });
    store.set("indentSize", 4);
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    store.set("indentSize", 2);
    expect(listener).toHaveBeenCalledTimes(3);
  });
  it("keeps changes usable after save failure and retries all pending values", () => {
    const s = storage(),
      store = new SettingsStore(() => s, "en");
    s.setItem.mockImplementationOnce(() => {
      throw new Error("disk quota");
    });
    store.set("theme", "light");
    expect(store.getSnapshot()).toMatchObject({ saveError: true, values: { theme: "light" } });
    store.save();
    expect(store.getSnapshot().saveError).toBe(false);
    expect(new SettingsStore(() => s, "en").getSnapshot().values.theme).toBe("light");
  });
  it("survives storage access being blocked", () => {
    const store = new SettingsStore(() => {
      throw new Error("blocked");
    }, "en");
    expect(store.getSnapshot().saveError).toBe(true);
    store.set("uiScale", 110);
    expect(store.getSnapshot().values.uiScale).toBe(110);
    expect(store.getSnapshot().saveError).toBe(true);
  });
  it("restores only layout preferences and keeps appearance and editor settings", () => {
    const s = storage(),
      store = new SettingsStore(() => s, "en");
    store.set("theme", "light");
    store.set("indentSize", 4);
    store.set("deviceOpen", true);
    store.set("filesWidth", 340);
    store.set("problemsHeight", 300);
    store.set("toolTab", "activity");
    store.resetLayout();
    expect(store.getSnapshot().values).toEqual({
      ...defaultSettings("en"),
      theme: "light",
      indentSize: 4,
    });
    expect(new SettingsStore(() => s, "en").getSnapshot().values).toEqual(
      store.getSnapshot().values,
    );
  });
});
