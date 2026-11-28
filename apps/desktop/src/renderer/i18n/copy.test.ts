import { expect, it } from "vitest";
import { copy } from "./copy.js";
import { pluginUiCopy } from "../settings/plugin-copy.js";

it.each([
  ["en", "Loading languages…"],
  ["zh-TW", "正在載入語言…"],
] as const)("provides the exact static language loading copy for %s", (locale, message) => {
  expect(copy[locale].staticLanguageLoading).toBe(message);
});

it.each(["en", "zh-TW"] as const)(
  "provides complete generic UI and recovery copy in %s",
  (locale) => {
    const labels = pluginUiCopy[locale];
    expect(Object.keys(labels).sort()).toEqual(Object.keys(pluginUiCopy.en).sort());
    for (const [key, value] of Object.entries(labels)) {
      if (key === "actions") continue;
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
    expect(Object.keys(labels.actions).sort()).toEqual([
      "clear-resolved",
      "manage",
      "reconcile",
      "retry-save",
      "stop",
    ]);
    for (const value of Object.values(labels.actions)) expect(value.trim()).not.toBe("");
    expect(labels.holdHint).toContain("10");
    expect(labels.tools).toBe(locale === "en" ? "Plugin tools" : "插件工具");
  },
);
