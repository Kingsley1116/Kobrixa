import { expect, it } from "vitest";
import type { PublishedDiagnostic } from "@kobrixa/compiler";
import { getDiagnosticHelp } from "@kobrixa/compiler/diagnostic-help";
import type { PluginDiagnosticHelpEntry } from "@kobrixa/plugin-protocol";
import {
  diagnosticIdentity,
  diagnosticSourceLabel,
  localizeHelp,
  resolveDiagnosticHelp,
  type PluginHelpCatalogView,
} from "./diagnostic-help.js";

const pluginEntry = (code: string, helpKey?: string): PluginDiagnosticHelpEntry => ({
  code,
  ...(helpKey ? { helpKey } : {}),
  title: { en: `T ${code}${helpKey ?? ""}` },
  cause: { en: "C", "zh-TW": "原因" },
  steps: { en: ["S"] },
});
const catalog: PluginHelpCatalogView = {
  revision: 3,
  plugins: {
    "acme.x": {
      displayName: { en: "Acme", "zh-TW": "愛克米" },
      entries: [pluginEntry("BP1015"), pluginEntry("ACME1"), pluginEntry("ACME1", "k")],
    },
  },
};

it("resolves built-in sources from the built-in catalog only", () => {
  expect(resolveDiagnosticHelp({ source: "kobrixa.basic-plus", code: "BP1015" }, catalog)).toEqual({
    kind: "builtin",
    help: getDiagnosticHelp("BP1015"),
  });
  const shadowed: PluginHelpCatalogView = {
    revision: 4,
    plugins: {
      "kobrixa.basic-plus": { entries: [pluginEntry("BP1015"), pluginEntry("BP9999")] },
      "kobrixa.ev3": { entries: [pluginEntry("BP1015")] },
    },
  };
  expect(resolveDiagnosticHelp({ source: "kobrixa.basic-plus", code: "BP1015" }, shadowed)).toEqual(
    {
      kind: "builtin",
      help: getDiagnosticHelp("BP1015"),
    },
  );
  expect(
    resolveDiagnosticHelp({ source: "kobrixa.basic-plus", code: "BP9999" }, shadowed),
  ).toBeUndefined();
  expect(
    resolveDiagnosticHelp({ source: "kobrixa.ev3", code: "BP1015" }, shadowed),
  ).toBeUndefined();
});

it("resolves plugin entries within their own source and never falls back across sources", () => {
  const own = resolveDiagnosticHelp({ source: "acme.x", code: "BP1015" }, catalog);
  expect(own).toMatchObject({
    kind: "plugin",
    source: "acme.x",
    entry: { title: { en: "T BP1015" } },
  });
  expect(resolveDiagnosticHelp({ source: "acme.y", code: "BP1015" }, catalog)).toBeUndefined();
  expect(resolveDiagnosticHelp({ source: "acme.x", code: "BP9999" }, catalog)).toBeUndefined();
});

it("prefers the helpKey variant and falls back to the code within the same source", () => {
  const exact = resolveDiagnosticHelp({ source: "acme.x", code: "ACME1", helpKey: "k" }, catalog);
  expect(exact).toMatchObject({ entry: { helpKey: "k" } });
  const fallback = resolveDiagnosticHelp(
    { source: "acme.x", code: "BP1015", helpKey: "zzz" },
    catalog,
  );
  expect(fallback).toMatchObject({ entry: { code: "BP1015" } });
  const variantOnly: PluginHelpCatalogView = {
    revision: 4,
    plugins: { "acme.x": { entries: [pluginEntry("ACME1", "k")] } },
  };
  expect(resolveDiagnosticHelp({ source: "acme.x", code: "ACME1" }, variantOnly)).toBeUndefined();
  expect(
    resolveDiagnosticHelp({ source: "acme.x", code: "ACME1", helpKey: "other" }, variantOnly),
  ).toBeUndefined();
});

it("localizes plugin text with an English fallback", () => {
  const resolved = resolveDiagnosticHelp({ source: "acme.x", code: "BP1015" }, catalog)!;
  expect(localizeHelp(resolved, "zh-TW")).toMatchObject({
    title: "T BP1015",
    cause: "原因",
    steps: ["S"],
  });
  expect(localizeHelp(resolved, "en")).toEqual({ title: "T BP1015", cause: "C", steps: ["S"] });
});

it("labels sources for markers", () => {
  expect(diagnosticSourceLabel("kobrixa.core", catalog, "en")).toBe("Kobrixa");
  expect(diagnosticSourceLabel("acme.x", catalog, "zh-TW")).toBe("愛克米 (acme.x)");
  expect(diagnosticSourceLabel("acme.x", catalog, "en")).toBe("Acme (acme.x)");
  expect(diagnosticSourceLabel("acme.z", catalog, "en")).toBe("acme.z");
  const names: PluginHelpCatalogView = {
    revision: 4,
    plugins: {
      "kobrixa.core": { displayName: "Override", entries: [] },
      "kobrixa.basic-plus": { displayName: "Basic Plus", entries: [] },
      "kobrixa.ev3": { displayName: "EV3", entries: [] },
      "acme.en": { displayName: { en: "English only" }, entries: [] },
      "acme.unnamed": { entries: [] },
    },
  };
  expect(diagnosticSourceLabel("kobrixa.core", names, "zh-TW")).toBe("Kobrixa");
  expect(diagnosticSourceLabel("kobrixa.basic-plus", names, "zh-TW")).toBe("Basic Plus");
  expect(diagnosticSourceLabel("kobrixa.ev3", names, "en")).toBe("EV3");
  expect(diagnosticSourceLabel("acme.en", names, "zh-TW")).toBe("English only (acme.en)");
  expect(diagnosticSourceLabel("acme.unnamed", names, "en")).toBe("acme.unnamed");
  expect(diagnosticSourceLabel("acme.x", undefined, "zh-TW")).toBe("acme.x");
});

it.each(["Kobrixa", "Basic Plus", "EV3"])(
  "identifies a plugin whose display name impersonates %s",
  (displayName) => {
    const impersonator: PluginHelpCatalogView = {
      revision: 1,
      plugins: { "acme.fake": { displayName, entries: [] } },
    };
    expect(diagnosticSourceLabel("acme.fake", impersonator, "en")).toBe(
      `${displayName} (acme.fake)`,
    );
  },
);

it("includes the source in the diagnostic identity", () => {
  const base = {
    code: "BP1015",
    severity: "error" as const,
    file: "a.bp",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "m",
  };
  expect(diagnosticIdentity({ ...base, source: "kobrixa.basic-plus" })).toBe(
    diagnosticIdentity({ ...base, source: "kobrixa.basic-plus" }),
  );
  expect(diagnosticIdentity({ ...base, source: "kobrixa.basic-plus" })).not.toBe(
    diagnosticIdentity({ ...base, source: "acme.x" }),
  );
  const published: PublishedDiagnostic = { ...base, source: "kobrixa.basic-plus" };
  const changes: Partial<PublishedDiagnostic>[] = [
    { code: "BP1013" },
    { helpKey: "specific" },
    { severity: "warning" },
    { file: "b.bp" },
    { message: "other" },
    ...(["startLine", "startColumn", "endLine", "endColumn"] as const).map((field) => ({
      range: { ...base.range, [field]: 2 },
    })),
  ];
  for (const change of changes) {
    expect(diagnosticIdentity({ ...published, ...change })).not.toBe(diagnosticIdentity(published));
  }
});

it("handles an unavailable catalog and ignores inherited plugin sources", () => {
  expect(resolveDiagnosticHelp({ source: "acme.x", code: "BP1015" }, undefined)).toBeUndefined();
  expect(
    resolveDiagnosticHelp({ source: "kobrixa.basic-plus", code: "BP1015" }, undefined),
  ).toEqual({
    kind: "builtin",
    help: getDiagnosticHelp("BP1015"),
  });
  const inherited: PluginHelpCatalogView = { revision: 4, plugins: {} };
  Object.setPrototypeOf(inherited.plugins, catalog.plugins);
  expect(resolveDiagnosticHelp({ source: "acme.x", code: "BP1015" }, inherited)).toBeUndefined();
  expect(diagnosticSourceLabel("acme.x", inherited, "en")).toBe("acme.x");
});

it.each(["en", "zh-TW"] as const)(
  "localizes built-in explanations and examples in %s",
  (locale) => {
    const resolved = resolveDiagnosticHelp(
      { source: "kobrixa.basic-plus", code: "BP1013" },
      catalog,
    )!;
    const help = getDiagnosticHelp("BP1013")!;
    expect(localizeHelp(resolved, locale)).toEqual({
      title: help.title[locale],
      cause: help.cause[locale],
      steps: help.steps[locale],
      example: { before: help.example!.before, after: help.example!.after },
    });
  },
);

it("keeps plugin examples and uses available Chinese titles and steps", () => {
  const entry: PluginDiagnosticHelpEntry = {
    ...pluginEntry("ACME1"),
    title: { en: "Title", "zh-TW": "標題" },
    steps: { en: ["Step"], "zh-TW": ["步驟"] },
    example: { before: "before", after: "after" },
  };
  expect(localizeHelp({ kind: "plugin", source: "acme.x", entry }, "zh-TW")).toEqual({
    title: "標題",
    cause: "原因",
    steps: ["步驟"],
    example: entry.example,
  });
});

it("merges same-source duplicates and keeps different sources apart", () => {
  const base = {
    code: "BP1015",
    severity: "error" as const,
    file: "a.bp",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "m",
  };
  const live = { ...base, source: "kobrixa.basic-plus" };
  const build = { ...base, source: "kobrixa.basic-plus" };
  const other = { ...base, source: "acme.x" };
  const unique = new Map([live, build, other].map((item) => [diagnosticIdentity(item), item]));
  expect([...unique.values()]).toEqual([live, other]);
});
