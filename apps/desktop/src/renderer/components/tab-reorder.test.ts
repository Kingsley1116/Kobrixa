import { expect, it } from "vitest";
import { dropIndex, keyboardMoveIndex, moveItem } from "./tab-reorder.js";

it("moves items forward and backward and ignores out-of-range moves", () => {
  expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
});

it("converts drop targets into final indexes", () => {
  expect(dropIndex(0, 2, false)).toBe(1);
  expect(dropIndex(0, 2, true)).toBe(2);
  expect(dropIndex(3, 1, false)).toBe(1);
  expect(dropIndex(3, 1, true)).toBe(2);
  expect(dropIndex(1, 1, true)).toBe(1);
});

it("maps Alt+Shift navigation keys to clamped indexes", () => {
  const key = (k: string, extra = {}) => ({
    key: k,
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    ...extra,
  });
  expect(keyboardMoveIndex(key("ArrowRight"), 1, 4)).toBe(2);
  expect(keyboardMoveIndex(key("ArrowLeft"), 0, 4)).toBe(0);
  expect(keyboardMoveIndex(key("End"), 1, 4)).toBe(3);
  expect(keyboardMoveIndex(key("Home"), 2, 4)).toBe(0);
  expect(keyboardMoveIndex(key("ArrowRight", { shiftKey: false }), 1, 4)).toBeUndefined();
  expect(keyboardMoveIndex(key("KeyA"), 1, 4)).toBeUndefined();
});
