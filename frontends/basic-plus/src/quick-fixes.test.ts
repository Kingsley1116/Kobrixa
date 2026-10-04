import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@kobrixa/compiler";
import { parse } from "./parser.js";
import { getBasicPlusQuickFixes, type BasicPlusQuickFix } from "./quick-fixes.js";

const file = "main.bp";

function diagnostic(source: string, code: string): Diagnostic {
  const result = parse(file, source).diagnostics.find((entry) => entry.code === code);
  expect(result, `${code} in ${JSON.stringify(source)}`).toBeDefined();
  return result!;
}

function apply(source: string, fix: BasicPlusQuickFix): string {
  for (const edit of [...fix.edits].reverse()) {
    const lines = source.split("\n");
    const offset =
      lines.slice(0, edit.range.startLine - 1).reduce((total, line) => total + line.length + 1, 0) +
      edit.range.startColumn -
      1;
    expect(edit.range.endLine).toBe(edit.range.startLine);
    expect(edit.range.endColumn).toBe(edit.range.startColumn);
    source = source.slice(0, offset) + edit.newText + source.slice(offset);
  }
  return source;
}

function fixed(source: string, code: string, titleKey: BasicPlusQuickFix["titleKey"]): string {
  const fixes = getBasicPlusQuickFixes(file, source, diagnostic(source, code));
  expect(fixes).toHaveLength(1);
  expect(fixes[0]!.titleKey).toBe(titleKey);
  const changed = apply(source, fixes[0]!);
  expect(parse(file, changed).diagnostics).toEqual([]);
  return changed;
}

describe("deterministic BASIC Plus quick fixes", () => {
  it.each([
    ["number[ values\n", "BP1024", "number[] values\n"],
    ["string[ labels\r\n", "BP1024", "string[] labels\r\n"],
    ["Sub Read(in number[ values)\nEndSub\n", "BP1015", "Sub Read(in number[] values)\nEndSub\n"],
  ])("closes a type bracket without replacing the name: %s", (source, code, expected) => {
    expect(fixed(source, code, "insert-type-bracket")).toBe(expected);
  });

  it.each([
    ["LCD.Clear(\nLCD.Update()\n", "BP1043", "LCD.Clear()\nLCD.Update()\n"],
    ["x = (1 + 2\ny = 3\n", "BP1040", "x = (1 + 2)\ny = 3\n"],
    ["Sub Worker(in number value\nEndSub\n", "BP1013", "Sub Worker(in number value)\nEndSub\n"],
    ["LCD.Clear( ' comment containing )\r\n", "BP1043", "LCD.Clear() ' comment containing )\r\n"],
    ["x = (1 + 2   ' note", "BP1040", "x = (1 + 2)   ' note"],
    ["LCD.Clear(\r\n", "BP1043", "LCD.Clear()\r\n"],
    ["LCD.Clear(", "BP1043", "LCD.Clear()"],
    ["x = ((1 + 2\n", "BP1040", "x = ((1 + 2))\n"],
    ["x = Math.Abs((1\n", "BP1043", "x = Math.Abs((1))\n"],
    [
      '\ufefftext = Text.Append("中文😀", "say ""hi"""\r\n',
      "BP1043",
      '\ufefftext = Text.Append("中文😀", "say ""hi""")\r\n',
    ],
  ])(
    "closes EOL/EOF parentheses without consuming the next statement: %s",
    (source, code, expected) => {
      expect(fixed(source, code, "insert-parenthesis")).toBe(expected);
    },
  );

  it.each([
    ["For i 1 To 5\nEndFor\n", "BP1033", "insert-for-equals", "For i = 1 To 5\nEndFor\n"],
    [
      "For i -1 To 5 Step 2\nEndFor\n",
      "BP1033",
      "insert-for-equals",
      "For i = -1 To 5 Step 2\nEndFor\n",
    ],
    ["For i = 1 5\nEndFor\n", "BP1034", "insert-for-to", "For i = 1 To 5\nEndFor\n"],
    [
      "For i = first last Step -1 ' note\r\nEndFor\r\n",
      "BP1034",
      "insert-for-to",
      "For i = first To last Step -1 ' note\r\nEndFor\r\n",
    ],
    ["For i = 1 endValue\nEndFor\n", "BP1034", "insert-for-to", "For i = 1 To endValue\nEndFor\n"],
  ] as const)("repairs a complete For header: %s", (source, code, titleKey, expected) => {
    expect(fixed(source, code, titleKey)).toBe(expected);
  });

  it.each([
    ["If True Then\n  x = 1\n", "BP1030", "If True Then\n  x = 1\nEndIf\n"],
    ["While True\n  x = 1", "BP1031", "While True\n  x = 1\nEndWhile"],
    [
      "For i = 1 To 5\n  x = 1 ' final comment",
      "BP1035",
      "For i = 1 To 5\n  x = 1 ' final comment\nEndFor",
    ],
    ["Function Value()\n  Return 1\n", "BP1014", "Function Value()\n  Return 1\nEndFunction\n"],
    [
      "\ufeffSub Worker()\r\n\tIf True Then\r\n\t\tWhile True\r\n\t\t\tx = 1\r\n",
      "BP1014",
      "\ufeffSub Worker()\r\n\tIf True Then\r\n\t\tWhile True\r\n\t\t\tx = 1\r\n\t\tEndWhile\r\n\tEndIf\r\nEndSub\r\n",
    ],
  ])(
    "groups EOF endings from inside out and preserves indentation: %s",
    (source, code, expected) => {
      expect(fixed(source, code, "close-blocks")).toBe(expected);
    },
  );

  it("offers the same grouped EOF edit for each missing ending", () => {
    const source = "If True Then\n  While True\n    x = 1\n";
    const edits = parse(file, source).diagnostics.map(
      (entry) => getBasicPlusQuickFixes(file, source, entry)[0]!.edits,
    );
    expect(edits[0]).toEqual(edits[1]);
  });

  it.each([
    ["values[1 = 3\n", "BP1027"],
    ['text = "unfinished\n', "BP1003"],
    ['LCD.Text("unfinished\n', "BP1043"],
    ["LCD.Clear(,\n", "BP1043"],
    ["LCD.Text(1,\n", "BP1043"],
    ["LCD.Text(1, ' another argument is missing\r\n", "BP1043"],
    ['\ufeffLCD.Text("😀",', "BP1043"],
    ["Sub Read(number value,\nEndSub\n", "BP1013"],
    ["Function Read(number value, ' another parameter\r\nEndFunction\r\n", "BP1013"],
    ["x = (1 +\n", "BP1040"],
    ["LCD.Clear( 1 other = 2\n", "BP1043"],
    ["For i = 1 Step 2\nEndFor\n", "BP1034"],
    ["For i = 1 EndFor\nEndFor\n", "BP1034"],
    ["For i = To 5\nEndFor\n", "BP1034"],
    ["For i = sTeP 5\nEndFor\n", "BP1034"],
    ["For i = -To 5\nEndFor\n", "BP1034"],
    ["For i = (To) 5\nEndFor\n", "BP1034"],
    ["For i To 5\nEndFor\n", "BP1033"],
    ["For i 1 To 5 Step To\nEndFor\n", "BP1033"],
    ["For i 1 To 5 Step -To\nEndFor\n", "BP1033"],
    ["For i 1 To\nEndFor\n", "BP1033"],
    ["For i = 1\nEndFor\n", "BP1034"],
    ["If True Then\n  While True\nEndIf\n", "BP1031"],
    ['If True Then\n  text = "unfinished\n', "BP1030"],
  ])("refuses an ambiguous or incomplete repair: %s", (source, code) => {
    expect(getBasicPlusQuickFixes(file, source, diagnostic(source, code))).toEqual([]);
  });

  it("preserves unrelated syntax errors and only validates the selected fix", () => {
    const source = "LCD.Clear(\nunknown\n";
    const fixes = getBasicPlusQuickFixes(file, source, diagnostic(source, "BP1043"));
    expect(fixes).toHaveLength(1);
    expect(parse(file, apply(source, fixes[0]!)).diagnostics.map((entry) => entry.code)).toEqual([
      "BP1022",
    ]);
  });

  it("rejects unknown, absent and outdated diagnostic coordinates", () => {
    const source = "LCD.Clear(\n";
    const original = diagnostic(source, "BP1043");
    expect(getBasicPlusQuickFixes(file, source, { ...original, code: "BP9999" })).toEqual([]);
    expect(getBasicPlusQuickFixes(file, "LCD.Clear()\n", original)).toEqual([]);
    expect(getBasicPlusQuickFixes(file, source, { ...original, helpKey: "unrelated" })).toEqual([]);
    expect(
      getBasicPlusQuickFixes(file, source, {
        ...original,
        range: { ...original.range, startColumn: 1 },
      }),
    ).toEqual([]);
  });

  it("uses the supplied abort signal and bounds very large source snapshots", () => {
    const source = "LCD.Clear(\n";
    const original = diagnostic(source, "BP1043");
    const controller = new AbortController();
    controller.abort();
    expect(() => getBasicPlusQuickFixes(file, source, original, controller.signal)).toThrow();
    expect(getBasicPlusQuickFixes(file, source + " ".repeat(1_000_001), original)).toEqual([]);
  });

  it("provides structured help keys for Folder argument failures", () => {
    expect(
      parse(file, "Folder\n")
        .diagnostics.filter((entry) => entry.code === "BP1050")
        .map((entry) => entry.helpKey),
    ).toEqual(["folder-storage", "folder-directory"]);
  });
});
