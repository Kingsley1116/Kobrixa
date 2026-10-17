import { expect, it, vi } from "vitest";
import { checkStaticRegex } from "./static-language-regex.js";

const tokenizer = (pattern: string) => checkStaticRegex({ pattern, flags: "" }, "tokenizer", false);

it("proves consumption through alternatives, groups, assertions and minimum repetitions", () => {
  for (const pattern of [
    ".",
    "a+",
    "(?:a|bc)",
    "(?:a?b)",
    "a{1,3}",
    "(?=a)a",
    "(?!b)a",
    "^[A-Za-z]+",
    "[0-9]",
    "\\t",
    '"(?:[^"\\\\]|\\\\.)*"',
  ])
    expect(tokenizer(pattern), pattern).toBeUndefined();
  for (const pattern of [
    "^",
    "$",
    "\\b",
    "a*",
    "a?",
    "a{0,3}",
    "(?:a|)",
    "(?=a)",
    "(?:a?)(?:b*)",
    "(?:x|(?=y))",
  ])
    expect(tokenizer(pattern)?.message, pattern).toContain("consume");
  expect(checkStaticRegex({ pattern: "^", flags: "i" }, "configuration", false)).toBeUndefined();
});

it("rejects unsupported constructs even inside an assertion or zero-repeat group", () => {
  for (const pattern of [
    "(",
    "[z-a]",
    "(a)\\1",
    "(?<n>a)\\k<n>",
    "(?<=x)a",
    "(?<!x)a",
    "(?=(a)\\1)a",
    "(?:(a)\\1){0}a",
    "(?i:a)",
  ])
    expect(tokenizer(pattern), pattern).toBeDefined();
  expect(checkStaticRegex({ pattern: "(?<=x)", flags: "" }, "configuration", false)).toBeDefined();
});

it("boundary raw and compiled regex sources", () => {
  for (const pattern of ["@", "@@", "@name", "\\@", "\\$"])
    expect(tokenizer(pattern), pattern).toBeUndefined();
  for (const pattern of ["$S1", "$s2", "\\$S1", "\\$s2"])
    expect(tokenizer(pattern)?.message).toContain("substitution");
  expect(tokenizer("")).toMatchObject({ actual: 0 });
  for (const count of [1, 2047, 2048]) expect(tokenizer("a".repeat(count))).toBeUndefined();
  for (const count of [4095, 4096, 4097]) {
    const pattern = "@".repeat(2045) + "a".repeat(count - 4095);
    expect([...`^(?:${pattern.replaceAll("@", "@@")})`]).toHaveLength(count);
    expect(tokenizer(pattern) === undefined).toBe(count <= 4096);
    // Configuration normalization expands each literal U+2028 to six source characters.
    const configuration = "\u2028".repeat(682) + "a".repeat(count - 4092);
    expect([...new RegExp(configuration).source]).toHaveLength(count);
    expect(
      checkStaticRegex({ pattern: configuration, flags: "" }, "configuration", false) === undefined,
    ).toBe(count <= 4096);
  }
  expect(tokenizer("a".repeat(2049))).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.patternLength",
    allowed: 2048,
    actual: 2049,
  });
  expect(tokenizer("@".repeat(2045) + "a")).toBeUndefined();
  expect(tokenizer("@".repeat(2046))).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.compiledPatternLength",
    allowed: 4096,
    actual: 4097,
  });
  expect(tokenizer("😀".repeat(2048))).toBeUndefined();
  expect(tokenizer("\u2028".repeat(683))).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.compiledPatternLength",
  });
});

it("enforces tokenizer flags but permits independent configuration flags", () => {
  expect(checkStaticRegex({ pattern: "x", flags: "i" }, "tokenizer", false)).toMatchObject({
    field: "flags",
    allowed: [""],
    actual: "i",
  });
  expect(checkStaticRegex({ pattern: "x", flags: "" }, "tokenizer", true)).toMatchObject({
    field: "flags",
    allowed: ["i"],
    actual: "",
  });
  expect(checkStaticRegex({ pattern: "x", flags: "i" }, "configuration", false)).toBeUndefined();
});

it("does not execute author patterns while checking syntax and minimum consumption", () => {
  const pattern = "(a+)+$";
  const original = RegExp.prototype.exec;
  const executed = vi.fn();
  const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
    this: RegExp,
    text: string,
  ) {
    if (this.source === pattern || this.source === `^(?:${pattern})`) executed();
    return original.call(this, text);
  });
  try {
    expect(tokenizer(pattern)).toBeUndefined();
    expect(executed).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
