import { describe, expect, it } from "vitest";
import {
  activeFileAfterClose,
  activeFileAfterRemoval,
  clamp,
  nextDiagnosticIndex,
  readStoredBoolean,
  readStoredNumber,
  tabCloseDisposition,
} from "./workbench-state.js";

function storage(values: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (key) => values[key] ?? null };
}

describe("editor workspace state", () => {
  it("selects the tab to the right, then the tab to the left", () => {
    expect(activeFileAfterClose(["a.bp", "b.bp", "c.bp"], "b.bp", "b.bp")).toBe("c.bp");
    expect(activeFileAfterClose(["a.bp", "b.bp"], "b.bp", "b.bp")).toBe("a.bp");
    expect(activeFileAfterClose(["a.bp", "b.bp"], "a.bp", "b.bp")).toBe("b.bp");
  });

  it("selects the nearest remaining tab after removing a subtree", () => {
    expect(
      activeFileAfterRemoval(
        ["a.bp", "src/b.bp", "src/c.bp", "z.bp"],
        "src/b.bp",
        new Set(["src/b.bp", "src/c.bp"]),
      ),
    ).toBe("z.bp");
    expect(activeFileAfterRemoval(["a.bp", "src/b.bp"], "src/b.bp", new Set(["src/b.bp"]))).toBe(
      "a.bp",
    );
  });

  it("requires an explicit save, discard, or cancel decision for dirty tabs", () => {
    expect(tabCloseDisposition(false)).toBe("close");
    expect(tabCloseDisposition(true)).toBe("prompt");
    expect(tabCloseDisposition(true, "save")).toBe("save");
    expect(tabCloseDisposition(true, "discard")).toBe("discard");
    expect(tabCloseDisposition(true, "cancel")).toBe("cancel");
  });

  it("wraps diagnostic navigation in both directions", () => {
    expect(nextDiagnosticIndex(3, -1, 1)).toBe(0);
    expect(nextDiagnosticIndex(3, 2, 1)).toBe(0);
    expect(nextDiagnosticIndex(3, 0, -1)).toBe(2);
    expect(nextDiagnosticIndex(0, 0, 1)).toBe(-1);
  });

  it("clamps dimensions and rejects invalid stored preferences", () => {
    expect(clamp(90, 112, 360)).toBe(112);
    expect(clamp(500, 112, 360)).toBe(360);
    expect(readStoredNumber(storage({ width: "240" }), "width", 220, 176, 360)).toBe(240);
    expect(readStoredNumber(storage({ width: "900" }), "width", 220, 176, 360)).toBe(220);
    expect(readStoredNumber(storage({ width: "oops" }), "width", 220, 176, 360)).toBe(220);
    expect(readStoredBoolean(storage({ open: "false" }), "open", true)).toBe(false);
    expect(readStoredBoolean(storage({ open: "maybe" }), "open", true)).toBe(true);
  });
});
