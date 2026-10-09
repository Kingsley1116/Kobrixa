import { describe, expect, it } from "vitest";
import { scalarOperation } from "./scalar-operations.js";

describe("minimum and maximum", () => {
  it.each([
    [16777216, 1],
    [-16777216, -1],
    [3e38, 3e38],
    [-3e38, 3e38],
    [Infinity, Infinity],
    [-Infinity, -Infinity],
    [NaN, 1],
    [1, NaN],
  ])("selects an existing operand without arithmetic overflow: %s, %s", (left, right) => {
    const values = [left, right].map(Math.fround);
    expect(scalarOperation("Math.Min", values, () => 0)).toBe(Math.min(...values));
    expect(scalarOperation("Math.Max", values, () => 0)).toBe(Math.max(...values));
  });
});
