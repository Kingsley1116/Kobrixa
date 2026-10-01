import { EV3_OPERATION_CATALOG, type EV3ParameterKind, type IRPrimitiveType } from "@kobrixa/ir";

export const BASIC_PLUS_KEYWORDS = [
  "And",
  "Break",
  "Continue",
  "Dim",
  "Else",
  "ElseIf",
  "EndFor",
  "EndFunction",
  "EndIf",
  "EndModule",
  "EndRegion",
  "EndSub",
  "EndWhile",
  "False",
  "For",
  "Folder",
  "Function",
  "Goto",
  "If",
  "Include",
  "Import",
  "In",
  "Module",
  "Not",
  "Number",
  "Or",
  "Out",
  "Private",
  "Property",
  "Region",
  "Return",
  "Step",
  "String",
  "Sub",
  "Then",
  "To",
  "True",
  "While",
] as const;

export interface BasicPlusApiCompletion {
  label: string;
  category: string;
  signature: string;
  insertText: string;
  documentation: string;
}

const placeholderByType: Record<IRPrimitiveType, string> = {
  boolean: "True",
  integer: "0",
  number: "0",
  string: "",
  void: "",
};

function argumentSnippet(type: EV3ParameterKind, tabstop: number): string {
  if (type === "array") return `\${${tabstop}:array}`;
  return type === "string" ? `"\${${tabstop}}"` : `\${${tabstop}:${placeholderByType[type]}}`;
}

export const BASIC_PLUS_API_COMPLETIONS: readonly BasicPlusApiCompletion[] = [
  ...EV3_OPERATION_CATALOG.values(),
]
  .map((operation) => {
    const parameters = operation.parameters
      .map((type) => (typeof type === "string" ? type : type.join(" | ")))
      .join(", ");
    const returnType =
      typeof operation.returns === "string" ? operation.returns : `${operation.returns.element}[]`;
    const signature = `${operation.name}(${parameters})${returnType === "void" ? "" : `: ${returnType}`}`;
    const argumentsSnippet = operation.parameters
      .map((type, index) => argumentSnippet(typeof type === "string" ? type : type[0]!, index + 1))
      .join(", ");
    return {
      label: operation.name,
      category: operation.category,
      signature,
      insertText: `${operation.name}(${argumentsSnippet})`,
      documentation: `EV3 ${operation.category} API. ${
        returnType === "void" ? "Does not return a value." : `Returns ${returnType}.`
      }`,
    };
  })
  .sort((left, right) => left.label.localeCompare(right.label));

export const BASIC_PLUS_COMPLETIONS = [
  ...BASIC_PLUS_KEYWORDS,
  ...BASIC_PLUS_API_COMPLETIONS.map((completion) => completion.label),
].sort((left, right) => left.localeCompare(right));

export function formatBasicPlus(source: string, options: { indentSize?: 2 | 4 } = {}): string {
  const indentation = " ".repeat(options.indentSize ?? 2);
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let indent = 0;
  return `${lines
    .map((raw) => {
      const line = raw.trim();
      const lower = line.toLocaleLowerCase("en-US");
      if (
        /^(else|elseif\b|endif\b|endwhile\b|endfor\b|endsub\b|endfunction\b|endmodule\b)/.test(
          lower,
        )
      ) {
        indent = Math.max(0, indent - 1);
      }
      const formatted = line ? `${indentation.repeat(indent)}${line}` : "";
      if (
        /^(if\b.*\bthen\s*$|else\s*$|elseif\b.*\bthen\s*$|while\b|for\b|sub\b|function\b|module\b)/.test(
          lower,
        )
      ) {
        indent += 1;
      }
      return formatted;
    })
    .join("\n")
    .trimEnd()}\n`;
}
