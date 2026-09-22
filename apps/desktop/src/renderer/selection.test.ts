import { describe, expect, it } from "vitest";
import { selectVisible, updateSelection } from "./selection.js";

describe("shared picker selection", () => {
  const options = [
    { value: "" },
    { value: "a" },
    { value: "root", disabled: true },
    { value: "b" },
    { value: "c" },
  ];
  it("supports an empty-string root value without treating it as a placeholder", () => {
    expect(updateSelection(options, ["a"], "", "single")).toEqual([""]);
  });
  it("toggles rows without replacing existing or filtered selections", () => {
    expect(updateSelection(options, ["hidden", "a"], "b", "toggle")).toEqual(["hidden", "a", "b"]);
    expect(updateSelection(options, ["hidden", "a"], "a", "toggle")).toEqual(["hidden"]);
  });
  it("adds forward and reverse ranges, excluding disabled items", () => {
    expect(updateSelection(options, ["hidden", ""], "b", "range", "a")).toEqual([
      "hidden",
      "",
      "a",
      "b",
    ]);
    expect(updateSelection(options, ["hidden"], "a", "range", "c")).toEqual([
      "hidden",
      "a",
      "b",
      "c",
    ]);
  });
  it("does not select unrelated items when a range anchor is filtered out", () => {
    expect(updateSelection(options, ["hidden"], "c", "range", "hidden")).toEqual(["hidden", "c"]);
  });
  it("ignores unknown and disabled targets without mutating input", () => {
    const selected = Object.freeze(["a"]);
    expect(updateSelection(options, selected, "missing", "range", "a")).toEqual(["a"]);
    expect(updateSelection(options, selected, "root", "single")).toEqual(["a"]);
  });
  it("selects or clears only visible enabled values and keeps hidden selections", () => {
    expect(selectVisible(options, ["hidden", "a"], true)).toEqual(["hidden", "a", "", "b", "c"]);
    expect(selectVisible(options, ["hidden", "a", "b"], false)).toEqual(["hidden"]);
  });
  it("supports numeric settings without coercion", () => {
    expect(updateSelection([{ value: 100 }, { value: 125 }], [100], 125, "single")).toEqual([125]);
  });
});
