import { describe, expect, it } from "vitest";
import { documentationIndex, searchDocumentation, searchExcerpt } from "./docs-search.js";

describe("documentation search", () => {
  it("finds API names and diagnostic codes before incidental mentions", () => {
    expect(searchDocumentation("lcd.text", "en")[0]?.path).toBe(
      "/docs/reference/basic-plus/api/lcd.text",
    );
    expect(searchDocumentation("ＢＰ１０１３", "zh-TW")[0]?.path).toBe("/docs/diagnostics/BP1013");
  });
  it("searches translated tutorials and full guide bodies with all query terms", () => {
    expect(
      searchDocumentation("第一個程式", "zh-TW").some(
        (entry) => entry.path === "/docs/tutorial/first-program",
      ),
    ).toBe(true);
    expect(
      searchDocumentation("SHA256SUMS AppImage", "en").some(
        (entry) => entry.path === "/docs/reference/installation",
      ),
    ).toBe(true);
    expect(searchDocumentation("SHA256SUMS nonexistent-kobrixa-term", "en")).toEqual([]);
    expect(searchDocumentation("   ", "en")).toEqual([]);
  });
  it("covers each documentation family with unique local links and short readable excerpts", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      const entries = documentationIndex(locale);
      expect(new Set(entries.map((entry) => entry.kind))).toEqual(
        new Set(["tutorial", "document", "api", "syntax", "diagnostic"]),
      );
      expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
      expect(
        entries.every((entry) => entry.path.startsWith("/docs/") && entry.title && entry.body),
      ).toBe(true);
      const guide = entries.find((entry) => entry.path === "/docs/reference/installation")!;
      const excerpt = searchExcerpt(guide, "SHA256SUMS");
      expect(excerpt).toContain("SHA256SUMS");
      expect(excerpt.length).toBeLessThanOrEqual(182);
    }
  });
});
