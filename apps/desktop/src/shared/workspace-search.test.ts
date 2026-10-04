import { describe, expect, it } from "vitest";
import {
  findSearchMatches,
  isSearchableFile,
  replaceSearchMatches,
  type WorkspaceSearchOptions,
} from "./workspace-search.js";

const options: WorkspaceSearchOptions = { query: "motor", caseSensitive: false, wholeWord: false };

describe("workspace literal search", () => {
  it("finds literal punctuation and non-overlapping occurrences", () => {
    expect(
      findSearchMatches("$& [x].* $&", { ...options, query: "$&" }).map((item) => item.start),
    ).toEqual([0, 9]);
    expect(findSearchMatches("$& [x].* $&", { ...options, query: "[x].*" })).toHaveLength(1);
    expect(
      findSearchMatches("aaaa", { ...options, query: "aa" }).map((item) => item.start),
    ).toEqual([0, 2]);
    expect(findSearchMatches("motor", { ...options, query: "" })).toEqual([]);
    expect(findSearchMatches("motor", options, 0)).toEqual([]);
  });

  it("handles case folding without shifting Unicode offsets", () => {
    const content = "İ MOTOR motor K k";
    expect(findSearchMatches(content, options).map((item) => item.start)).toEqual([2, 8]);
    expect(
      findSearchMatches(content, { ...options, caseSensitive: true }).map((item) => item.start),
    ).toEqual([8]);
    expect(
      findSearchMatches(content, { ...options, query: "k" }).map((item) => item.start),
    ).toEqual([14, 16]);
  });

  it("uses Unicode letters, numbers, combining marks and underscores for whole words", () => {
    const content =
      "motor MOTOR motor_speed motors xmotor motor2 馬motor motor\u0301 𐐀motor (motor)";
    expect(
      findSearchMatches(content, { ...options, wholeWord: true }).map((item) =>
        content.slice(item.start, item.end),
      ),
    ).toEqual(["motor", "MOTOR", "motor"]);
  });

  it("returns exact UTF-16 offsets and raw source ranges across BOM, CRLF, CR and astral text", () => {
    const content = "\uFEFF😀motor\r\n馬motor\rmotor";
    expect(findSearchMatches(content, options)).toEqual([
      {
        start: 3,
        end: 8,
        startLine: 1,
        startColumn: 4,
        endLine: 1,
        endColumn: 9,
        lineText: "\uFEFF😀motor",
      },
      {
        start: 11,
        end: 16,
        startLine: 2,
        startColumn: 2,
        endLine: 2,
        endColumn: 7,
        lineText: "馬motor",
      },
      {
        start: 17,
        end: 22,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 6,
        lineText: "motor",
      },
    ]);
    expect(findSearchMatches(content, { ...options, query: "motor\r\n馬" })[0]).toMatchObject({
      start: 3,
      end: 11,
      startLine: 1,
      startColumn: 4,
      endLine: 2,
      endColumn: 2,
    });
  });

  it("caps matches and line previews while preserving exact source ranges", () => {
    const content = `${"x".repeat(1000)}motor ${"motor ".repeat(1000)}`;
    const matches = findSearchMatches(content, options, 3);
    expect(matches).toHaveLength(3);
    expect(matches[0]).toMatchObject({ start: 1000, startColumn: 1001 });
    expect(matches.every((item) => item.lineText.length <= 502)).toBe(true);
    expect(matches[0]!.lineText).toMatch(/^….*…$/);
  });

  it("replaces exact source spans literally and preserves all other bytes", () => {
    const content = "\uFEFFmotor\r\n😀motor\r\n";
    const file = {
      path: "main.bp",
      content,
      revision: null,
      matches: findSearchMatches(content, options),
    };
    expect(replaceSearchMatches(file, "$&$1\\n")).toBe("\uFEFF$&$1\\n\r\n😀$&$1\\n\r\n");
    expect(replaceSearchMatches({ ...file, matches: [] }, "unused")).toBe(content);
    expect(() =>
      replaceSearchMatches({ ...file, matches: [...file.matches].reverse() }, "x"),
    ).toThrow("valid source range");
  });

  it("recognizes only editable project source and JSON extensions", () => {
    for (const file of ["main.bp", "LIBRARY.BPI", "src/module.bpm", "kobrixa.json"])
      expect(isSearchableFile(file)).toBe(true);
    for (const file of ["main.bp.tmp", "photo.rgf", "sound.rsf", "README.md"])
      expect(isSearchableFile(file)).toBe(false);
  });
});
