import { expect, it } from "vitest";
import { documentationUrl } from "./documentation.js";
import { quickFixRequestSchema } from "../language/quick-fix-request.js";

it("opens only authored diagnostic and related documentation with the selected locale", () => {
  expect(documentationUrl({ code: "BP2006", helpKey: "break-outside-loop", locale: "zh-TW" })).toBe(
    "https://kobrixa.com/docs/diagnostics/BP2006?lang=zh-TW#break-outside-loop",
  );
  const related = new URL(documentationUrl({ code: "BP1043", locale: "en", relatedIndex: 0 }));
  expect(related.origin).toBe("https://kobrixa.com");
  expect(related.pathname).toMatch(/^\/docs\//);
  expect(related.searchParams.get("lang")).toBe("en");
  for (const request of [
    { code: "https://example.com", locale: "en" },
    { code: "BP1043", locale: "en", relatedIndex: 900 },
    { code: "BP1043", locale: "en", url: "https://example.com" },
    { code: "BP1043", locale: "invalid" },
  ])
    expect(() => documentationUrl(request)).toThrow();
});

it("validates bounded quick-fix requests without accepting source edits from the renderer", () => {
  const query = {
    requestId: "request-1",
    session: "test",
    revision: 1,
    analysisVersion: 2,
    file: "main.bp",
    diagnostic: {
      code: "BP1043",
      range: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 4 },
    },
  };
  expect(quickFixRequestSchema.parse(query)).toEqual(query);
  for (const invalid of [
    { ...query, revision: 0 },
    { ...query, file: "main\0.bp" },
    { ...query, edits: [{ text: "anything" }] },
    {
      ...query,
      diagnostic: { ...query.diagnostic, range: { ...query.diagnostic.range, endColumn: 1 } },
    },
  ])
    expect(quickFixRequestSchema.safeParse(invalid).success).toBe(false);
});
