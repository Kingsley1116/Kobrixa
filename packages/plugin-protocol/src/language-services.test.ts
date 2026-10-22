import { expect, it } from "vitest";
import {
  LANGUAGE_CAPABILITIES,
  PLUGIN_API_VERSION,
  pluginManifestSchema,
  languageServiceDeclarationProblems,
} from "./index.js";

const front = {
  language: "bp",
  entryExtensions: ["bp"],
  sourceExtensions: ["bp", "bpi", "bpm"],
  ir: { min: 1, max: 1 },
};
const service = { language: "bp", extensions: front.sourceExtensions, capabilities: ["analysis"] };
const value = (languageServices: unknown, frontends: unknown = [front]) => ({
  id: "test.language",
  version: "1.0.0",
  apiVersion: "^1.3.0",
  runtime: { kind: "builtin" },
  contributes: { frontends, languageServices },
});
it("exports API 1.7.0 and exactly twelve capabilities", () => {
  expect(PLUGIN_API_VERSION).toBe("1.7.0");
  expect(LANGUAGE_CAPABILITIES).toEqual([
    "analysis",
    "completion",
    "quickFixes",
    "semanticTokens",
    "hover",
    "signatureHelp",
    "definition",
    "references",
    "rename",
    "documentSymbols",
    "documentFormatting",
    "rangeFormatting",
  ]);
});
it("accepts eight declarations and rejects nine, empty fields and unknown fields", () => {
  expect(pluginManifestSchema.safeParse(value(Array(8).fill(service))).success).toBe(true);
  for (const declarations of [
    Array(9).fill(service),
    [{ ...service, extensions: [] }],
    [{ ...service, capabilities: [] }],
    [{ ...service, capabilities: ["compile"] }],
    [{ ...service, language: "BP" }],
    [{ ...service, extensions: [".bp"] }],
    [{ ...service, implementation: "service.js" }],
  ])
    expect(pluginManifestSchema.safeParse(value(declarations)).success).toBe(false);
});
it("checks unique values, analysis and exact frontend ownership after structural parsing", () => {
  const check = (services: unknown, fronts: unknown = [front]) =>
    languageServiceDeclarationProblems(pluginManifestSchema.parse(value(services, fronts)));
  expect(check([{ ...service, extensions: ["bpm", "bp", "bpi"] }])).toEqual([]);
  for (const services of [
    [service, service],
    [{ ...service, capabilities: ["completion"] }],
    [{ ...service, capabilities: ["analysis", "analysis"] }],
    [{ ...service, extensions: ["bp", "bpi", "bpm", "bp"] }],
    [{ ...service, extensions: ["bp"] }],
  ])
    expect(check(services)).not.toEqual([]);
  expect(check([service], [])).not.toEqual([]);
  expect(check([service], [{ ...front, language: "other" }])).not.toEqual([]);
});
