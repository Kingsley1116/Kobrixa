import { describe, expect, it } from "vitest";
import {
  BASIC_PLUS_INDENTATION_RULES,
  basicPlusLineIndentation,
  formatBasicPlus,
} from "./language.js";
import { lex } from "./lexer.js";

describe("Basic+ block indentation", () => {
  it.each([2, 4] as const)("formats all blocks and branches with %i spaces", (indentSize) => {
    const lines: [number, string][] = [
      [0, "Private"],
      [0, "Module Helpers"],
      [1, "Region Utilities"],
      [1, "Function Check(in number value)"],
      [2, "iF value > 0 Then ' condition"],
      [3, "For i = 1 To value"],
      [4, "While True ' loop"],
      [5, 'caption = "ElseIf ""Then"" EndIf \' text"'],
      [5, "' EndWhile EndFor EndIf"],
      [4, "EndWhile"],
      [3, "EndFor"],
      [2, "ElseIf value = 0 Then ' zero"],
      [3, "Return 0"],
      [2, "ElseIf value = -1 ' optional Then"],
      [3, "Return 1"],
      [2, "Else ' fallback"],
      [3, "If True ' optional Then"],
      [4, "Return 2"],
      [3, "EndIf ' inner"],
      [2, "EndIf"],
      [1, "EndFunction"],
      [1, "Sub Clear()"],
      [2, "LCD.Clear()"],
      [1, "EndSub"],
      [1, "EndRegion"],
      [0, "EndModule"],
    ];
    const source = lines.map(([, line], index) => `${index % 2 ? "\t" : "    "}${line}`).join("\n");
    const expected =
      lines.map(([depth, line]) => `${" ".repeat(depth * indentSize)}${line}`).join("\n") + "\n";
    const formatted = formatBasicPlus(source, { indentSize });
    expect(formatted).toBe(expected);
    expect(formatBasicPlus(formatted, { indentSize })).toBe(formatted);
    const tokens = (text: string) =>
      lex("main.bp", text).tokens.map(({ kind, text }) => [kind, text]);
    expect(tokens(formatted)).toEqual(tokens(`${source}\n`));
  });

  it.each([
    "Elsewhere = 1",
    "ElseIfValue = 1",
    "EndIfValue = 1",
    "If_ready = 1",
    "ForEach()",
    "WhileLoop()",
    "Subroutine()",
    "FunctionName()",
    "ModuleName()",
    "If.Check()",
    "Else.Check()",
    "EndIf.Check()",
    "While.Check()",
    "For.Check()",
    "Sub.Check()",
    "Function.Check()",
    "Module.Check()",
    "Private",
    "Region Test",
    "EndRegion",
    "' If True Then",
    'caption = "If True Then"',
    '"ElseIf"',
    "",
    "   ",
  ])("does not treat %s as a block boundary", (line) => {
    expect(basicPlusLineIndentation(`  ${line}`, 2)).toEqual({ indent: 2, nextIndent: 2 });
    expect(BASIC_PLUS_INDENTATION_RULES.increaseIndentPattern.test(line)).toBe(false);
    expect(BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(line)).toBe(false);
  });

  it("tolerates partial programs and unmatched endings without negative indentation", () => {
    expect(formatBasicPlus("EndIf\nEndFor\nIf True\nWhile\nLCD.Clear()")).toBe(
      "EndIf\nEndFor\nIf True\n  While\n    LCD.Clear()\n",
    );
    expect(formatBasicPlus("Else\nLCD.Clear()\nEndIf\nEndIf\n")).toBe(
      "Else\n  LCD.Clear()\nEndIf\nEndIf\n",
    );
  });

  it("retains the whole-document newline and trailing whitespace conventions", () => {
    expect(formatBasicPlus("If True Then  \r\n\tLCD.Clear()  \r\n\t \r\nEndIf\r\n\r\n")).toBe(
      "If True Then\n  LCD.Clear()\n\nEndIf\n",
    );
    expect(formatBasicPlus("")).toBe("\n");
  });
});
