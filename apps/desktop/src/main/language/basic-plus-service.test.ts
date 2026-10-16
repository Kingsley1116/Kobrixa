import { expect, it } from "vitest";
import { BasicPlusProjectAnalyzer } from "@kobrixa/basic-plus";
import type { SourceProject } from "@kobrixa/compiler";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import { basicPlusLanguageService } from "./basic-plus-service.js";
import { offersBasicPlusQuickFix } from "./basic-plus-quick-fixes.js";
const signal = new AbortController().signal;
const project: SourceProject = {
  root: "/project",
  manifest: {
    schemaVersion: 1,
    name: "test",
    language: "bp",
    entry: "main.bp",
    target: "ev3-native",
    outputDir: "out",
    assets: [],
  },
  assets: [],
  sources: [
    { path: "main.bp", content: 'Include "config"\nImport "helper"\nresult = Double(shared)\n' },
    { path: "config.bpi", content: "shared = 2\n" },
    {
      path: "helper.bpm",
      content: "Function Double(in number value)\nReturn value * 2\nEndFunction\n",
    },
  ],
};
it("preserves native diagnostics, tokens and source snapshots with generic display symbols", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  const raw = new BasicPlusProjectAnalyzer().analyze(project, signal);
  const result = provider.analyze(project, 1, signal);
  expect(result.diagnostics).toEqual(raw.diagnostics);
  expect(result.tokensByFile).toEqual(raw.tokensByFile);
  expect(result.index.sources).toEqual(raw.index.sources);
  const double = Object.values(result.index.symbols).find((s) => s.name === "Double")!;
  expect(double).toMatchObject({
    kind: "function",
    signature: "Double(in number value): number",
    shadowKey: "call:double",
  });
  expect(double).not.toHaveProperty("parameters");
  expect(double).not.toHaveProperty("scope");
  expect(
    provider.query(1, { kind: "definition", file: "main.bp", line: 3, column: 10 }, signal),
  ).toMatchObject({
    kind: "definition",
    locations: [{ file: "helper.bpm" }],
  });
  expect([...basicPlusLanguageService.capabilities]).toEqual([...LANGUAGE_CAPABILITIES]);
  provider.dispose();
  expect(() => provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toThrow(
    "Analysis expired",
  );
});
it("keeps two raw analyses and returns localized, single-file fixes", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  const broken = { ...project, sources: [{ path: "main.bp", content: "LCD.Clear(\n" }] };
  const one = provider.analyze(broken, 1, signal);
  const diagnostic = one.diagnostics.find((d) => d.code === "BP1043")!;
  const fixes = provider.quickFixes(
    1,
    "main.bp",
    { ...diagnostic, source: "kobrixa.basic-plus" },
    signal,
  );
  expect(fixes[0]?.title).toEqual({ en: "Insert closing parenthesis )", "zh-TW": "補上右括號 )" });
  provider.analyze(project, 2, signal);
  provider.analyze(project, 3, signal);
  expect(() => provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toThrow(
    "Analysis expired",
  );
  provider.dispose();
});

it("only offers Basic Plus fixes for Basic Plus diagnostics", () => {
  expect(offersBasicPlusQuickFix({ source: "kobrixa.basic-plus", code: "BP1015" })).toBe(true);
  expect(offersBasicPlusQuickFix({ source: "acme.x", code: "BP1015" })).toBe(false);
  expect(offersBasicPlusQuickFix({ source: "kobrixa.basic-plus", code: "BP9999" })).toBe(false);
});
