import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { copy, languageDisplayName } from "./i18n/copy.js";
import type { LexicalLanguageRoute } from "./editor/static-language-routing.js";
const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
it("subscribes to the active model's route for the status label", () => {
  expect(app).toMatch(/activeLexicalRoute = useSyncExternalStore\(/);
  expect(app).toContain("staticLanguages.registrar.subscribe");
  expect(app).toContain("activeSession?.editor.models.get(active.file)");
  expect(app).toContain("staticLanguages.registrar.getRoute(model)");
  expect(app).not.toContain("staticLanguages.registrar.resolve(");
});
it("has no unused Basic Plus status copy", () => {
  for (const locale of ["en", "zh-TW"] as const)
    expect(copy[locale]).not.toHaveProperty("basicPlus");
});
it("places the same static barrier before restoration, project initialization, opening and formatting", () => {
  expect(app).toMatch(
    /await staticLanguages\.ready;\s*const saved = await window\.kobrixa\.workspace\.restoreSession\(\)/,
  );
  for (const name of ["initializeProject", "openFile", "saveTab"]) {
    const start = app.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(0);
    const body = app.slice(start).match(/\): Promise<[^>]+> \{\s*([^\n]+)/);
    expect(body?.[1]).toBe("await staticLanguages.ready;");
  }
  expect(app).toContain("languageDisplayName(activeLexicalRoute, locale)");
  expect(app).not.toContain('endsWith(".json") ? "JSON" : t.basicPlus');
});
it.each(["en", "zh-TW"] as const)(
  "uses catalog aliases and localized fallback labels in %s",
  (locale) => {
    const route: LexicalLanguageRoute = {
      kind: "static",
      monacoLanguage: "toy",
      displayName: "Toy 😀",
      catalogRevision: 1,
    };
    expect(languageDisplayName(route, locale)).toBe("Toy 😀");
    expect(languageDisplayName({ ...route, displayName: "toy" }, locale)).toBe("toy");
    expect(languageDisplayName({ ...route, kind: "core", monacoLanguage: "json" }, locale)).toBe(
      "JSON",
    );
    expect(
      languageDisplayName({ ...route, kind: "plaintext", monacoLanguage: "plaintext" }, locale),
    ).toBe(locale === "zh-TW" ? "純文字" : "Plain Text");
  },
);
