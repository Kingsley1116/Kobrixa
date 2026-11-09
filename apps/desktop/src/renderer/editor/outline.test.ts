import { analyzeBasicPlusProject } from "@kobrixa/basic-plus";
import { expect, it } from "vitest";
import { outlinePath } from "./outline.js";
import { basicPlusOutline } from "../../main/language/basic-plus-outline.js";

const source = [
  "number speed",
  "speed = 50",
  "Drive()",
  "start:",
  "Sub Drive",
  "  turns = 3",
  '  Motor.Move("BC", speed, turns, "True")',
  "EndSub",
  "Function Half(in number value)",
  "  Half = value / 2",
  "EndFunction",
].join("\n");

function outline() {
  const analysis = analyzeBasicPlusProject(
    {
      root: "/project",
      manifest: {
        schemaVersion: 1,
        name: "test",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "out",
      },
      sources: [{ path: "main.bp", content: source }],
      assets: [],
    },
    new AbortController().signal,
  );
  return basicPlusOutline(analysis.index, "main.bp");
}

it("lists globals, labels and callables with their locals in source order", () => {
  const items = outline();
  const shape = (list: typeof items): unknown =>
    list.map((item) => [item.kind, item.name, shape(item.children)]);
  expect(shape(items)).toEqual([
    ["variable", "speed", []],
    ["label", "start", []],
    ["function", "Drive", [["variable", "turns", []]]],
    ["function", "Half", []],
  ]);
  const drive = items.find((item) => item.name === "Drive")!;
  expect(drive.range).toMatchObject({ startLine: 5, endLine: 8 });
  expect(drive.selectionRange.startLine).toBe(5);
  expect(drive.detail).toBe("Sub");
});

it("finds the callable containing a position", () => {
  const items = outline();
  expect(outlinePath(items, 6, 3).map((item) => item.name)).toEqual(["Drive"]);
  expect(outlinePath(items, 2, 1)).toEqual([]);
});
