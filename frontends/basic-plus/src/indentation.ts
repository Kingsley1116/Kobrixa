// Only a leading, complete keyword affects block indentation. Basic+ identifiers
// include dots, and If/ElseIf accept an optional Then in the parser. Looking at
// the first keyword also keeps strings and trailing comments out of the rules.
export const BASIC_PLUS_INDENTATION_RULES = {
  increaseIndentPattern:
    /^[\t ]*(?:If|ElseIf|Else|While|For|Sub|Function|Module)(?![A-Za-z0-9_.])/i,
  decreaseIndentPattern:
    /^[\t ]*(?:ElseIf|Else|EndIf|EndWhile|EndFor|EndSub|EndFunction|EndModule)(?![A-Za-z0-9_.])/i,
};

/** Depth for this line and the following line, including unfinished programs. */
export function basicPlusLineIndentation(
  line: string,
  depth: number,
): { indent: number; nextIndent: number } {
  const indent = Math.max(
    0,
    depth - (BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(line) ? 1 : 0),
  );
  return {
    indent,
    nextIndent: indent + (BASIC_PLUS_INDENTATION_RULES.increaseIndentPattern.test(line) ? 1 : 0),
  };
}
