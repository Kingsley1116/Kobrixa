import { expect, it } from "vitest";
import {
  CORE_DIAGNOSTIC_SOURCE,
  isPublishedDiagnostic,
  requirePublished,
  stampDiagnostics,
} from "./diagnostic-source.js";
import { diagnostic, diagnosticFromSpan } from "./diagnostics.js";
import { BuildError } from "./build-error.js";

const raw = {
  code: "BP1015",
  severity: "error" as const,
  file: "main.bp",
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
  message: "x",
};

it("stamps the trusted source on every diagnostic", () => {
  expect(stampDiagnostics([raw], "kobrixa.basic-plus")).toEqual([
    { ...raw, source: "kobrixa.basic-plus" },
  ]);
});
it("rejects producer-supplied sources with BUILD1007", () => {
  const forged = { ...raw, source: "kobrixa.ev3" };
  expect(() => stampDiagnostics([raw, forged], "kobrixa.basic-plus")).toThrow(BuildError);
  try {
    stampDiagnostics([forged], "kobrixa.basic-plus");
  } catch (error) {
    expect((error as BuildError).code).toBe("BUILD1007");
  }
});
it("marks host diagnostics as core", () => {
  expect(diagnostic("MAN1001", "bad").source).toBe(CORE_DIAGNOSTIC_SOURCE);
  expect(diagnosticFromSpan("IR1001", "bad").source).toBe(CORE_DIAGNOSTIC_SOURCE);
});
it("requires a source before publication", () => {
  expect(isPublishedDiagnostic(raw)).toBe(false);
  expect(() => requirePublished([raw])).toThrow(/without a source/);
  const published = { ...raw, source: "kobrixa.basic-plus" };
  expect(requirePublished([published])).toEqual([published]);
});

it.each(["kobrixa.core", "kobrixa.basic-plus", "acme.plugin-1", "acme.tools.plugin", "a.b"])(
  "publishes a valid namespaced source: %s",
  (source) => {
    const published = { ...raw, source };
    expect(isPublishedDiagnostic(published)).toBe(true);
    expect(requirePublished([published])).toEqual([published]);
  },
);

it.each([
  "",
  " ",
  "acme",
  "Acme.plugin",
  "acme.plugin_name",
  "acme..plugin",
  "acme.-plugin",
  "acme.plugin-",
  "acme.plugin\n",
  `acme.${"a".repeat(124)}`,
])("rejects an empty or malformed source: %j", (source) => {
  const invalid = { ...raw, source };
  expect(isPublishedDiagnostic(invalid)).toBe(false);
  expect(() => requirePublished([{ ...raw, source: "kobrixa.core" }, invalid])).toThrow();
});
