import { expect, it, vi } from "vitest";
import type { LanguageStatus } from "../../shared/language-services.js";
import { routeLanguage, replaceModelRoute } from "./language-routing.js";
vi.mock("monaco-editor", () => ({}));
const status: LanguageStatus = {
  epoch: 1,
  conflicts: [],
  availability: {
    kind: "available",
    binding: {
      epoch: 1,
      pluginId: "kobrixa.basic-plus",
      sourceKey: "builtin:kobrixa.basic-plus",
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: ["analysis", "completion"],
      frontend: {
        language: "bp",
        entryExtensions: ["bp"],
        sourceExtensions: ["bp", "bpi", "bpm"],
        ir: { min: 1, max: 1 },
      },
    },
  },
};
it("routes only selected extensions and preserves JSON and lexical highlighting", () => {
  expect(routeLanguage("中文.BP", status)).toMatchObject({
    monacoLanguage: "basic-plus",
    binding: { epoch: 1 },
  });
  expect(routeLanguage("kobrixa.json", status)).toEqual({ monacoLanguage: "json" });
  expect(routeLanguage("readme.txt", status)).toEqual({ monacoLanguage: "plaintext" });
  expect(
    routeLanguage("main.bp", {
      epoch: 2,
      conflicts: [],
      availability: {
        kind: "unavailable",
        reason: "missing",
        language: "bp",
      },
    }),
  ).toEqual({ monacoLanguage: "basic-plus" });
});
it("detaches a renamed or replaced model without losing its text", () => {
  const text = "LCD.Clear()";
  const oldModel = { text };
  const newModel = { text };
  const dispose = vi.fn();
  const attach = vi.fn(() => ({ dispose }));
  let previous = replaceModelRoute(undefined, oldModel, "main.bp", status, attach);
  previous = replaceModelRoute(previous, oldModel, "main.json", status, attach);
  expect(dispose).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledTimes(1);
  previous = replaceModelRoute(previous, newModel, "main.bp", status, attach);
  expect(attach).toHaveBeenCalledTimes(2);
  expect(oldModel.text).toBe(text);
  expect(newModel.text).toBe(text);
  previous.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
});
