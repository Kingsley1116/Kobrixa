import { describe, expect, it } from "vitest";
import { analyzeBasicPlusProject } from "./analysis.js";
import {
  editingContext,
  occurrenceAt,
  prepareSymbolRename,
  symbolReferences,
  symbolSignature,
  visibleSymbols,
} from "./intelligence.js";

function analyze(sources: Record<string, string>) {
  return analyzeBasicPlusProject(
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
      sources: Object.entries(sources).map(([path, content]) => ({ path, content })),
      assets: [],
    },
    new AbortController().signal,
  );
}
function fixture() {
  return analyze({
    "main.bp":
      'Include "config"\nImport "math"\nanswer = math.Double(shared)\nThread.Run = Blink\n',
    "config.bpi": "shared = 2\n",
    "math.bpm":
      "Function Double(in number shared)\nlocalValue = shared * 2\nReturn localValue\nEndFunction\nSub Blink()\nLCD.Clear()\nEndSub\n",
    "other.bp": 'Import "math"\nDouble(3)\n',
  });
}

describe("shared symbol index", () => {
  it("links qualified calls, thread references, declarations and other importing programs", () => {
    const result = fixture();
    expect(result.diagnostics).toEqual([]);
    const { index } = result;
    const occurrence = occurrenceAt(index, "main.bp", 3, 16)!;
    const symbol = index.symbols[occurrence.symbolId]!;
    expect(symbol).toMatchObject({
      name: "Double",
      kind: "function",
      type: "number",
      declaration: { file: "math.bpm", range: { startLine: 1, startColumn: 10, endColumn: 16 } },
    });
    expect(symbolSignature(symbol)).toBe("Double(in number shared): number");
    expect(
      symbolReferences(index, symbol).map((item) => [item.file, item.range.startLine]),
    ).toEqual(
      expect.arrayContaining([
        ["main.bp", 3],
        ["math.bpm", 1],
        ["other.bp", 2],
      ]),
    );
    expect(symbolReferences(index, symbol, false)).toHaveLength(2);
    expect(index.symbols[occurrenceAt(index, "main.bp", 4, 15)!.symbolId]!.name).toBe("Blink");
  });

  it("keeps stable identities when declarations move and gives shadows distinct identities", () => {
    const first = analyze({
      "main.bp": "value = 1\nFunction Copy(in number value)\nReturn @value\nEndFunction\n",
    });
    const second = analyze({
      "main.bp":
        "' moved\n\nvalue = 1\nFunction Copy(in number value)\nReturn @value\nEndFunction\n",
    });
    expect(Object.keys(first.index.symbols).sort()).toEqual(
      Object.keys(second.index.symbols).sort(),
    );
    const global = occurrenceAt(first.index, "main.bp", 1, 2)!;
    const local = occurrenceAt(first.index, "main.bp", 3, 10)!;
    expect(global.symbolId).not.toBe(local.symbolId);
    expect(first.index.symbols[local.symbolId]!.kind).toBe("parameter");
    expect(symbolReferences(first.index, first.index.symbols[local.symbolId]!)).toHaveLength(2);
  });

  it("offers only the current dependency context and scope, with local precedence", () => {
    const { index } = fixture();
    const inside = visibleSymbols(index, "math.bpm", 3, 4);
    expect(inside.filter((s) => s.name === "shared").map((s) => s.kind)).toEqual(["parameter"]);
    expect(inside.find((s) => s.name === "localValue")?.type).toBe("number");
    expect(visibleSymbols(index, "main.bp", 3, 4).some((s) => s.name === "localValue")).toBe(false);
    expect(visibleSymbols(index, "other.bp", 2, 4).some((s) => s.name === "answer")).toBe(false);
  });

  it("indexes arrays, output parameters, labels, and zero-argument API references", () => {
    const result = analyze({
      "main.bp":
        "number[] data\nnow = Time.Get1\nCopy(now, output)\nGoto done\ndone:\nFunction Copy(in number input, out number output)\noutput = input\nReturn\nEndFunction\n",
    });
    expect(result.diagnostics).toEqual([]);
    const symbols = Object.values(result.index.symbols);
    expect(symbols.find((s) => s.name === "data")?.type).toBe("number[]");
    expect(symbols.find((s) => s.name === "Copy")?.parameters?.[1]).toEqual({
      name: "output",
      type: "number",
      direction: "out",
    });
    expect(symbols.find((s) => s.name === "Time.Get1")).toMatchObject({
      scope: "builtin",
      kind: "method",
      type: "number",
    });
    expect(
      symbolReferences(
        result.index,
        symbols.find((s) => s.name === "done")!,
      ),
    ).toHaveLength(2);
  });

  it("retains exact UTF-16 ranges and reliable nodes in unfinished syntax", () => {
    const source =
      '\ufefftext = "中文😀" + Text.Append("x", "y")\r\nvalue = 1\r\nvalue++\r\n\' value\r\ntext = "value"\r\n';
    const result = analyze({ "main.bp": source });
    const value = result.index.symbols[occurrenceAt(result.index, "main.bp", 2, 2)!.symbolId]!;
    expect(symbolReferences(result.index, value)).toHaveLength(2);
    expect(occurrenceAt(result.index, "main.bp", 1, 12)).toBeUndefined();
    const builtin = occurrenceAt(result.index, "main.bp", 1, 27)!;
    expect(source.slice(builtin.range.startColumn - 1, builtin.range.endColumn - 1)).toBe("Append");
    const incomplete = analyze({
      "main.bp": "Function Add(in number input)\nReturn input +\nEndFunction\n",
    });
    expect(incomplete.diagnostics.length).toBeGreaterThan(0);
    expect(
      incomplete.index.symbols[occurrenceAt(incomplete.index, "main.bp", 2, 9)!.symbolId]!.kind,
    ).toBe("parameter");
  });
});

describe("safe symbol rename", () => {
  it("renames the function suffix across importing programs without touching strings or comments", () => {
    const result = fixture();
    const plan = prepareSymbolRename(result, "main.bp", 3, 16, "Twice");
    expect(plan.rejectReason).toBeUndefined();
    expect(plan.edits).toHaveLength(3);
    expect(plan.edits?.map((e) => e.expected)).toEqual(["Double", "Double", "Double"]);
    expect(plan.edits?.find((e) => e.file === "main.bp")?.range.startColumn).toBe(15);
  });

  it("renames only the bound parameter, keeping @ and global symbols intact", () => {
    const result = analyze({
      "main.bp": "value = 1\nFunction Copy(in number value)\nReturn @VaLuE\nEndFunction\n",
    });
    const plan = prepareSymbolRename(result, "main.bp", 3, 10, "input");
    expect(plan.edits?.map((e) => [e.range.startLine, e.expected])).toEqual([
      [2, "value"],
      [3, "VaLuE"],
    ]);
    expect(plan.edits?.[1]?.range.startColumn).toBe(9);
  });

  it("rejects keywords, collisions, builtins, and incomplete projects without producing edits", () => {
    const result = fixture();
    for (const name of ["While", "Blink", "bad.name", "9name"])
      expect(prepareSymbolRename(result, "main.bp", 3, 16, name).rejectReason).toBeTruthy();
    expect(prepareSymbolRename(result, "math.bpm", 6, 6, "ClearScreen").rejectReason).toContain(
      "user-defined",
    );
    expect(prepareSymbolRename(result, "math.bpm", 2, 2, "shared").rejectReason).toContain(
      "conflicts",
    );
    const broken = analyze({ "main.bp": "count = 1\nUnknown()\n" });
    expect(prepareSymbolRename(broken, "main.bp", 1, 2, "total").rejectReason).toContain("errors");
  });

  it("rejects aliases that would become builtins even when the API was not used before", () => {
    const result = analyze({
      "main.bp": 'Import "LCD"\nLCD.Wipe()\n',
      "LCD.bpm": "Sub Wipe()\nEndSub\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(prepareSymbolRename(result, "LCD.bpm", 1, 6, "Clear").rejectReason).toContain(
      "built-in",
    );
  });

  it("rejects a physical occurrence bound differently in separate programs", () => {
    const result = analyze({
      "main.bp": 'shared = 1\nImport "lib"\n',
      "other.bp": 'Import "lib"\n',
      "lib.bpm": "Sub Work()\nshared = 2\nEndSub\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(prepareSymbolRename(result, "main.bp", 1, 2, "total").rejectReason).toContain(
      "differently",
    );
  });

  it("rejects semantic errors in isolated importing programs", () => {
    const result = analyze({
      "main.bp": 'Import "lib"\nWork()\n',
      "other.bp": 'Import "lib"\nWork(1)\n',
      "lib.bpm": "Sub Work()\nEndSub\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(prepareSymbolRename(result, "main.bp", 2, 2, "Task").rejectReason).toContain("errors");
  });
});

it("tracks signature arguments across nested calls, arrays, doubled quotes and comments", () => {
  expect(editingContext('Copy(Text.Append("a,b", "c"), data[1 + 2], ')).toEqual({
    inLiteral: false,
    call: { name: "Copy", argument: 2 },
  });
  expect(editingContext('Copy("say ""hello"", there')).toEqual({
    inLiteral: true,
    call: { name: "Copy", argument: 0 },
  });
  expect(editingContext("Copy(value) ' comment(")).toEqual({ inLiteral: true });
  expect(editingContext("Copy(Other(")).toEqual({
    inLiteral: false,
    call: { name: "Other", argument: 0 },
  });
});
