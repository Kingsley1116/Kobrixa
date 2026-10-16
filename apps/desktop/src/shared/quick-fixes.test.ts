import { expect, expectTypeOf, it } from "vitest";
import { sameDiagnostic, type QuickFix } from "./quick-fixes.js";

const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
it("treats diagnostics from different sources as different", () => {
  const a = { source: "kobrixa.basic-plus", code: "BP1015", range };
  expect(sameDiagnostic(a, { ...a })).toBe(true);
  expect(sameDiagnostic(a, { ...a, source: "acme.x" })).toBe(false);
});

it("carries localized fix text without a Basic Plus title key", () => {
  expectTypeOf<QuickFix>().not.toHaveProperty("titleKey");
});
