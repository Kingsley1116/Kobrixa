import { describe, expect, it } from "vitest";
import { parseQuickOpenQuery, quickOpenMatches } from "./quick-open-matcher.js";

describe("quick open matching", () => {
  it("prioritizes exact names, stems and prefixes before substrings and fuzzy paths", () => {
    const files = [
      "src/xmain.bp",
      "src/motor-aim-input.bp",
      "main/helper.bp",
      "src/main-loop.bp",
      "src/main.bp",
    ];
    expect(quickOpenMatches(files, "MAIN").matches.map((match) => match.file)).toEqual([
      "src/main.bp",
      "src/main-loop.bp",
      "main/helper.bp",
      "src/xmain.bp",
      "src/motor-aim-input.bp",
    ]);
    expect(quickOpenMatches(files, "main.bp").matches[0]?.file).toBe("src/main.bp");
  });

  it("matches ordered abbreviations and path fragments and records highlight positions", () => {
    const files = ["src/motor-control.bp", "lib/motor-control.bp", "src/other.bp"];
    const result = quickOpenMatches(files, "SRC/MC");
    expect(result.matches.map((match) => match.file)).toEqual(["src/motor-control.bp"]);
    const match = result.matches[0]!;
    expect(match.positions.map((position) => match.file[position]).join("")).toBe("src/mc");
    expect(quickOpenMatches(files, "src\\motor").matches[0]?.file).toBe("src/motor-control.bp");
    expect(quickOpenMatches(files, "zz").total).toBe(0);
    expect(quickOpenMatches(["範例/馬達.bp"], "馬達").total).toBe(1);
  });

  it("keeps the current and recent files first for an empty query without stale or duplicate entries", () => {
    const result = quickOpenMatches(
      [
        "a.bp",
        "b.bp",
        "c.bp",
        "a.bp",
        "media.rgf",
        "sound.rsf",
        "settings.JSON",
        "lib.bpi",
        "mod.bpm",
      ],
      "  ",
      { activeFile: "c.bp", recentFiles: ["gone.bp", "b.bp", "c.bp", "b.bp"] },
    );
    expect(result.matches.map((match) => match.file)).toEqual([
      "c.bp",
      "b.bp",
      "a.bp",
      "lib.bpi",
      "mod.bpm",
      "settings.JSON",
    ]);
  });

  it("reports the full count while limiting rows, with deterministic ordering", () => {
    const files = Array.from({ length: 125 }, (_, index) => `file-${index}.bp`).reverse();
    const result = quickOpenMatches(files, "");
    expect(result.total).toBe(125);
    expect(result.matches).toHaveLength(100);
    expect(result.matches[0]?.file).toBe("file-0.bp");
    expect(result.matches.at(-1)?.file).toBe("file-99.bp");
    expect(quickOpenMatches(files, "file", { limit: 5 }).matches).toHaveLength(5);
  });

  it("parses only valid positive line and column suffixes without losing the file query", () => {
    expect(parseQuickOpenQuery(" src/main:12:3 ")).toEqual({
      query: "src/main",
      position: { line: 12, column: 3 },
    });
    expect(parseQuickOpenQuery("main:7")).toEqual({
      query: "main",
      position: { line: 7, column: 1 },
    });
    expect(quickOpenMatches(["a.bp", "b.bp"], ":4", { activeFile: "b.bp" })).toMatchObject({
      matches: [{ file: "b.bp" }, { file: "a.bp" }],
      position: { line: 4, column: 1 },
    });
    for (const query of ["main:0", "main:1:0", "main:-1", "main:9007199254740992", "main:"])
      expect(parseQuickOpenQuery(query)).toEqual({ query });
  });
});
