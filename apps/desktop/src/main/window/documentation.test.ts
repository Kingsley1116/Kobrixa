import { expect, it } from "vitest";
import { documentationUrl } from "./documentation.js";
import { quickFixRequestSchema } from "../language/quick-fix-request.js";

const entry = {
  code: "BP1015",
  title: { en: "t" },
  cause: { en: "c" },
  steps: { en: ["s"] },
  links: [{ url: "https://acme.example/help", label: { en: "Acme" } }],
};
const lookup = (source: string, code: string) =>
  source === "acme.x" && code === "BP1015" ? entry : undefined;

it("opens only authored diagnostic and related documentation with the selected locale", () => {
  expect(
    documentationUrl(
      {
        source: "kobrixa.basic-plus",
        code: "BP2006",
        helpKey: "break-outside-loop",
        locale: "zh-TW",
      },
      lookup,
    ),
  ).toBe("https://kobrixa.com/docs/diagnostics/BP2006?lang=zh-TW#break-outside-loop");
  const related = new URL(
    documentationUrl(
      { source: "kobrixa.basic-plus", code: "BP1043", locale: "en", relatedIndex: 0 },
      lookup,
    ),
  );
  expect(related.origin).toBe("https://kobrixa.com");
  expect(related.pathname).toMatch(/^\/docs\//);
  expect(related.searchParams.get("lang")).toBe("en");
  for (const request of [
    { code: "https://example.com", locale: "en" },
    { code: "BP1043", locale: "en", relatedIndex: 900 },
    { code: "BP1043", locale: "en", url: "https://example.com" },
    { code: "BP1043", locale: "invalid" },
  ])
    expect(() => documentationUrl({ source: "kobrixa.basic-plus", ...request }, lookup)).toThrow();
});

it("opens official documentation only for the owning built-in source", () => {
  expect(
    documentationUrl({ source: "kobrixa.basic-plus", code: "BP1015", locale: "en" }, lookup),
  ).toBe("https://kobrixa.com/docs/diagnostics/BP1015?lang=en");
  expect(() =>
    documentationUrl({ source: "kobrixa.ev3", code: "BP1015", locale: "en" }, lookup),
  ).toThrow();
});
it("rejects official documentation for plugin sources", () => {
  expect(() =>
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en" }, lookup),
  ).toThrow();
  expect(() =>
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en", relatedIndex: 0 }, lookup),
  ).toThrow();
});
it("opens a plugin's own https link by index only", () => {
  expect(
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en", linkIndex: 0 }, lookup),
  ).toBe("https://acme.example/help");
  expect(() =>
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en", linkIndex: 1 }, lookup),
  ).toThrow();
  expect(() =>
    documentationUrl({ source: "acme.y", code: "BP1015", locale: "en", linkIndex: 0 }, lookup),
  ).toThrow();
  expect(() =>
    documentationUrl(
      { source: "kobrixa.basic-plus", code: "BP1015", locale: "en", linkIndex: 0 },
      lookup,
    ),
  ).toThrow();
  expect(() =>
    documentationUrl(
      { source: "acme.x", code: "BP1015", locale: "en", url: "https://evil" },
      lookup,
    ),
  ).toThrow();
});

it("rejects non-https catalog links and ambiguous link requests", () => {
  const request = { source: "acme.x", code: "BP1015", locale: "en", linkIndex: 0 };
  for (const url of ["http://acme.example/help", "javascript:alert(1)", "not a URL"])
    expect(() =>
      documentationUrl(request, () => ({ ...entry, links: [{ url, label: { en: "Unsafe" } }] })),
    ).toThrow();
  for (const invalid of [
    { ...request, relatedIndex: 0 },
    { ...request, linkIndex: -1 },
    { ...request, linkIndex: 0.5 },
    { ...request, source: "invalid" },
    { ...request, helpKey: "INVALID" },
    { ...request, url: "https://evil" },
  ])
    expect(() => documentationUrl(invalid, lookup)).toThrow();
});

it("validates bounded quick-fix requests without accepting source edits from the renderer", () => {
  const query = {
    requestId: "request-1",
    session: "test",
    revision: 1,
    analysisVersion: 2,
    file: "main.bp",
    diagnostic: {
      source: "kobrixa.basic-plus",
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
