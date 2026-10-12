import { describe, expect, it } from "vitest";
import { documents } from "./docs-content.js";
import { headingsFor, toSlug } from "./docs-toc.js";

describe("headingsFor", () => {
  it("collects h2 and h3 headings with renderer-compatible slugs", () => {
    const headings = headingsFor(
      ["# Title", "", "## Getting `started`", "text", "### **Bold** step", "#### Too deep"].join(
        "\n",
      ),
    );
    expect(headings).toEqual([
      { level: 2, text: "Getting started", id: "getting-started" },
      { level: 3, text: "Bold step", id: "bold-step" },
    ]);
  });

  it("keeps CJK headings readable in slugs", () => {
    expect(headingsFor("## 設備控制權")).toEqual([
      { level: 2, text: "設備控制權", id: "設備控制權" },
    ]);
    expect(toSlug("  Room & Roles!  ")).toBe("room-roles");
  });

  it("ignores headings inside fenced code blocks", () => {
    const content = [
      "## Before",
      "```sh",
      "## not a heading",
      "```",
      "~~~~md",
      "### also not a heading",
      "~~~",
      "### still inside the tilde fence",
      "~~~~",
      "   ```",
      "## indented fence content",
      "   ```",
      "### After",
    ].join("\n");
    expect(headingsFor(content).map((heading) => heading.text)).toEqual(["Before", "After"]);
  });

  it("does not close a fence on a marker with an info string", () => {
    const content = ["```", "```js", "## inside", "```", "## outside"].join("\n");
    expect(headingsFor(content).map((heading) => heading.text)).toEqual(["outside"]);
  });

  it("finds headings in every shipped document", () => {
    for (const document of documents) {
      for (const content of Object.values(document.content)) {
        for (const heading of headingsFor(content)) {
          expect(heading.id).not.toBe("");
          expect(heading.text).not.toMatch(/^#/);
        }
      }
    }
  });
});
