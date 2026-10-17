import { expect, it, vi } from "vitest";
import type { LanguageStatus } from "../../shared/language-services.js";
import { routeLanguage, replaceModelRoute } from "./language-routing.js";
import type { ModelLanguageRoute } from "./model-language-route.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";

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
const lexical: LexicalLanguageRoute = {
  kind: "static",
  monacoLanguage: "bp",
  displayName: "Basic Plus",
  catalogRevision: 1,
  staticOwner: {
    pluginId: "kobrixa.basic-plus",
    sourceKey: "builtin:kobrixa.basic-plus",
    generation: 1,
    languageId: "bp",
  },
};
const plain: LexicalLanguageRoute = {
  kind: "plaintext",
  monacoLanguage: "plaintext",
  displayName: "Plain Text",
  catalogRevision: 2,
};
it("uses the resolver id and retains valid services when only lexical registration fails", () => {
  expect(routeLanguage("中文.BP", status, {}, lexical)).toMatchObject({
    monacoLanguage: "bp",
    binding: { epoch: 1 },
  });
  expect(routeLanguage("main.bp", status, {}, plain)).toMatchObject({
    monacoLanguage: "plaintext",
    binding: { epoch: 1 },
  });
  expect(routeLanguage("readme.txt", status, {}, plain).binding).toBeUndefined();
  expect(
    routeLanguage(
      "kobrixa.json",
      status,
      {},
      { ...plain, kind: "core", monacoLanguage: "json", displayName: "JSON" },
    ).binding,
  ).toBeUndefined();
  expect(
    routeLanguage(
      "main.bp",
      {
        epoch: 2,
        conflicts: [],
        availability: {
          kind: "unavailable",
          reason: "missing",
          language: "bp",
        },
      },
      {},
      lexical,
    ),
  ).toEqual(lexical);
});
it("replaces catalog, owner, rename and workspace attachments without replacing the model", () => {
  const model = { text: "LCD.Clear()", undo: ["previous"] };
  const dispose = vi.fn();
  const attach = vi.fn(() => ({ dispose }));
  const first = routeLanguage("main.bp", status, {}, lexical);
  let attached = replaceModelRoute(undefined, model, "main.bp", "w1", first, attach);
  expect(replaceModelRoute(attached, model, "main.bp", "w1", { ...first }, attach)).toBe(attached);
  const changes: ModelLanguageRoute[] = [
    { ...first, catalogRevision: 2 },
    { ...first, catalogRevision: 3, staticOwner: { ...lexical.staticOwner!, generation: 2 } },
    { ...plain, binding: first.binding! },
  ];
  for (const route of changes)
    attached = replaceModelRoute(attached, model, "main.bp", "w1", route, attach);
  attached = replaceModelRoute(attached, model, "renamed.bp", "w1", first, attach);
  attached = replaceModelRoute(attached, model, "renamed.bp", "w2", first, attach);
  expect(attach).toHaveBeenCalledTimes(6);
  expect(dispose).toHaveBeenCalledTimes(5);
  expect(model).toEqual({ text: "LCD.Clear()", undo: ["previous"] });
  attached.dispose();
  attached.dispose();
  expect(dispose).toHaveBeenCalledTimes(6);
});
