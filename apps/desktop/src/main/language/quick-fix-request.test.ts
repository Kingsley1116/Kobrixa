import { expect, it } from "vitest";
import { quickFixRequestSchema } from "./quick-fix-request.js";

const request = (diagnostic: Record<string, unknown>) => ({
  requestId: "r1",
  session: "s",
  revision: 1,
  analysisVersion: 1,
  file: "main.bp",
  diagnostic: { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, ...diagnostic },
});
it("requires a source and accepts plugin code formats", () => {
  expect(quickFixRequestSchema.safeParse(request({ code: "BP1015" })).success).toBe(false);
  expect(
    quickFixRequestSchema.safeParse(request({ code: "BP1015", source: "kobrixa.basic-plus" }))
      .success,
  ).toBe(true);
  expect(
    quickFixRequestSchema.safeParse(request({ code: "ACME.e-1", source: "acme.x" })).success,
  ).toBe(true);
  expect(quickFixRequestSchema.safeParse(request({ code: "1BAD", source: "acme.x" })).success).toBe(
    false,
  );
  expect(
    quickFixRequestSchema.safeParse(request({ code: "BP1015", source: "Not An Id" })).success,
  ).toBe(false);
});
