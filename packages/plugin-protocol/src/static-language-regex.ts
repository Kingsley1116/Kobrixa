import { RegExpParser, type AST } from "@eslint-community/regexpp";
import { STATIC_LANGUAGE_LIMITS_V1 as L } from "./static-language-limits.js";
import type { RegexData } from "./static-language-schemas.js";

export type StaticRegexProblem = {
  field: "pattern" | "flags";
  message: string;
  limit?: string;
  allowed?: number | readonly string[];
  actual?: number | string;
};
const parser = new RegExpParser({ ecmaVersion: 2022 });

// Saturating at one preserves exactly the proof this validator needs.
// Every child is visited, including lookahead bodies and zero-repeat operands.
function minimum(ast: AST.Node): number {
  switch (ast.type) {
    case "Pattern":
    case "CapturingGroup":
      return Math.min(...ast.alternatives.map(minimum));
    case "Group":
      if (ast.modifiers) throw new Error("Inline modifiers are unsupported.");
      return Math.min(...ast.alternatives.map(minimum));
    case "Alternative":
      return Math.min(
        1,
        ast.elements.map(minimum).reduce((sum, value) => sum + value, 0),
      );
    case "Quantifier": {
      const child = minimum(ast.element);
      return ast.min > 0 ? child : 0;
    }
    case "Assertion":
      if (ast.kind === "lookbehind") throw new Error("Lookbehind is unsupported.");
      if (ast.kind === "lookahead") ast.alternatives.forEach(minimum);
      return 0;
    case "Character":
      return 1;
    case "CharacterSet":
      if (ast.kind === "property") throw new Error("Unicode property sets are unsupported.");
      return 1;
    case "CharacterClass":
      if (ast.unicodeSets) throw new Error("Unicode sets are unsupported.");
      ast.elements.forEach(minimum);
      return 1;
    case "CharacterClassRange":
      minimum(ast.min);
      minimum(ast.max);
      return 1;
    case "Backreference":
      throw new Error("Backreferences are unsupported.");
    default:
      throw new Error(`Unsupported regex AST kind: ${ast.type}.`);
  }
}

export function checkStaticRegex(
  regex: RegexData,
  usage: "tokenizer" | "configuration",
  ignoreCase: boolean,
): StaticRegexProblem | undefined {
  const size = (source: string, limit: "patternLength" | "compiledPatternLength") => {
    const actual = [...source].length;
    if (actual < 1 || actual > L[limit])
      return {
        field: "pattern" as const,
        message: `STATIC_LANGUAGE_LIMITS_V1.${limit} exceeded or empty source.`,
        limit: `STATIC_LANGUAGE_LIMITS_V1.${limit}`,
        allowed: L[limit],
        actual,
      };
    return undefined;
  };
  const rawSize = size(regex.pattern, "patternLength");
  if (rawSize) return rawSize;
  const allowed = usage === "tokenizer" ? [ignoreCase ? "i" : ""] : [...L.regexFlags];
  if (!allowed.includes(regex.flags))
    return {
      field: "flags",
      message: "Regex flags do not match the declared usage.",
      limit: "STATIC_LANGUAGE_LIMITS_V1.regexFlags",
      allowed,
      actual: regex.flags,
    };
  if (/\$[Ss][0-9]/.test(regex.pattern))
    return {
      field: "pattern",
      message: "State substitution is forbidden, including escaped forms.",
    };
  try {
    const raw = parser.parsePattern(regex.pattern, 0, regex.pattern.length, false);
    const consumed = minimum(raw);
    if (usage === "tokenizer" && consumed < 1)
      return {
        field: "pattern",
        message: "Tokenizer regex must provably consume at least one unit.",
      };
    // Native compilation is syntax/source normalization only; never test/exec author regexes.
    const normalized = new RegExp(regex.pattern, regex.flags).source;
    const escaped = usage === "tokenizer" ? normalized.replace(/@/g, "@@") : normalized;
    // Monaco 0.57.0 Rule.setRegex strips one leading ^ before wrapping.
    const compiled =
      usage === "tokenizer"
        ? `^(?:${escaped.startsWith("^") ? escaped.slice(1) : escaped})`
        : escaped;
    const compiledSize = size(compiled, "compiledPatternLength");
    if (compiledSize) return compiledSize;
    if (/\$[Ss][0-9]/.test(compiled))
      return { field: "pattern", message: "State substitution is forbidden after normalization." };
    minimum(parser.parsePattern(compiled, 0, compiled.length, false));
  } catch (error) {
    return { field: "pattern", message: error instanceof Error ? error.message : "Invalid regex." };
  }
  return undefined;
}
