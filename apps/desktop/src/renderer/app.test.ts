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
it("U04/U15 shares parallel UI/static barriers before restoration, project initialization, opening and formatting", () => {
  expect(app).toContain("const pluginUi = pluginUiWindow();");
  expect(app).toMatch(
    /await Promise\.all\(\[staticLanguages\.ready, pluginUi\.ready\]\);\s*const saved = await window\.kobrixa\.workspace\.restoreSession\(\)/,
  );
  for (const name of ["initializeProject", "openFile", "saveTab"]) {
    const start = app.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(0);
    const body = app.slice(start).match(/\): Promise<[^>]+> \{\s*([^\n]+)/);
    expect(body?.[1]).toBe("await Promise.all([staticLanguages.ready, pluginUi.ready]);");
  }
  expect(app).toContain("languageDisplayName(activeLexicalRoute, locale)");
  expect(app).not.toContain('endsWith(".json") ? "JSON" : t.basicPlus');
});
it("U15 mounts independent recovery, generic tools and footer status with pre-hide gates", () => {
  expect(app).toContain("<CoreRecoveryView");
  expect(app).toContain("pluginRecoveryPort(pluginUi.recovery,");
  expect(app).toContain("port={recoveryPort}");
  expect(app).toContain("request={recoveryRequest}");
  expect(app).toContain('hidden={rightPanel !== "plugins" || settingsActive}');
  expect(app).toMatch(/<footer>\s*<PluginStatusHost/);
  expect(app).toContain('pluginUi.gate("settings", next);');
  expect(app).toContain('pluginUi.gate("modal", modalOpen || updatePreparing);');
  const pane = app.match(/<div\s+className="right-pane-content plugin-pane"[\s\S]*?<\/div>/)?.[0];
  expect(pane).toContain("<PluginToolsPane");
  expect(pane).not.toMatch(/MotorTest|MonitorWorkspace/);
  expect(app).toContain("<PluginRecoveryNotice");
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
