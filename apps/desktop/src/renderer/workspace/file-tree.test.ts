import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  expandAncestors,
  flattenFileTree,
  remapTreePaths,
  selectionAfterRemoval,
  treeListNavigation,
} from "./file-tree.js";

describe("project file tree", () => {
  const entries = [
    { path: "z.bp", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/main.bp", kind: "file" as const },
    { path: "src/lib/math.bpm", kind: "file" as const },
    { path: "kobrixa.json", kind: "file" as const },
  ];

  it("builds folders before files and sorts names", () => {
    const root = buildFileTree("robot", entries);
    expect(root.children.map((node) => node.path)).toEqual(["src", "kobrixa.json", "z.bp"]);
    expect(root.children[0]?.children.map((node) => node.path)).toEqual(["src/lib", "src/main.bp"]);
  });

  it("flattens only expanded branches", () => {
    const root = buildFileTree("robot", entries);
    expect(flattenFileTree(root, new Set([""])).map((node) => node.path)).toEqual([
      "",
      "src",
      "kobrixa.json",
      "z.bp",
    ]);
    expect(flattenFileTree(root, new Set(["", "src"])).map((node) => node.path)).toContain(
      "src/main.bp",
    );
  });

  it("expands ancestors and remaps session paths", () => {
    expect([...expandAncestors(new Set(), "src/lib/math.bpm")]).toEqual(["", "src/lib", "src"]);
    expect([
      ...remapTreePaths(new Set(["", "src", "src/lib"]), {
        src: "source",
        "src/lib": "source/lib",
      }),
    ]).toEqual(["", "source", "source/lib"]);
  });

  it("selects the next visible item after removal", () => {
    expect(
      selectionAfterRemoval(["", "src", "src/a.bp", "z.bp"], "src", new Set(["src", "src/a.bp"])),
    ).toBe("z.bp");
  });

  it("moves keyboard selection through visible rows", () => {
    const paths = ["", "src", "src/main.bp", "kobrixa.json"];
    expect(treeListNavigation(paths, "src", "ArrowDown")).toBe("src/main.bp");
    expect(treeListNavigation(paths, "src", "ArrowUp")).toBe("");
    expect(treeListNavigation(paths, "src", "End")).toBe("kobrixa.json");
    expect(treeListNavigation(paths, "src", "Home")).toBe("");
  });
});
