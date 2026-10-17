import { expect, it } from "vitest";
import { copy } from "./copy.js";

it.each([
  ["en", "Loading languages…"],
  ["zh-TW", "正在載入語言…"],
] as const)("provides the exact static language loading copy for %s", (locale, message) => {
  expect(copy[locale].staticLanguageLoading).toBe(message);
});
