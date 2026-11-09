import { STATIC_LANGUAGE_LIMITS_V1 as L } from "./static-language-limits.js";
import type { StaticLanguageTokenizerV1 } from "./static-language-schemas.js";

type GraphFailure = {
  ok: false;
  message: string;
  fieldPath: string;
  limit?: string;
  allowed?: number;
  actual?: number;
};
type GraphResult = { ok: true; expandedRules: number } | GraphFailure;

export function inspectStaticLanguageGraph(tokenizer: StaticLanguageTokenizerV1): GraphResult {
  const states = new Map(tokenizer.states.map((state, index) => [state.name, { state, index }]));
  const colors = new Map<string, "gray" | "black">();
  const order: string[] = [];
  const stack: string[] = [];
  const enteringEdges: string[] = [];
  const visit = (name: string): GraphFailure | undefined => {
    if (colors.get(name) === "black") return undefined;
    colors.set(name, "gray");
    stack.push(name);
    const { state, index } = states.get(name)!;
    for (const [ruleIndex, rule] of state.rules.entries()) {
      if (!("include" in rule)) continue;
      const target = rule.include.slice(1);
      const fieldPath = `states[${index}].rules[${ruleIndex}].include`;
      if (!states.has(target))
        return {
          ok: false,
          fieldPath,
          message: `Missing include state ${target}.`,
        };
      if (colors.get(target) === "gray")
        return {
          ok: false,
          fieldPath: enteringEdges[stack.indexOf(target)] ?? fieldPath,
          message: `Include cycle: ${[...stack.slice(stack.indexOf(target)), target].join(" -> ")}.`,
        };
      enteringEdges.push(fieldPath);
      const problem = visit(target);
      enteringEdges.pop();
      if (problem) return problem;
    }
    stack.pop();
    colors.set(name, "black");
    order.push(name);
    return undefined;
  };
  for (const name of states.keys()) {
    const problem = visit(name);
    if (problem) return problem;
  }
  // Postorder dynamic programming computes the longest suffix for every state.
  // A later, deeper incoming path cannot be hidden by the DFS black cache.
  const depth = new Map<string, number>();
  const count = new Map<string, number>();
  const saturatedAdd = (a: number, b: number) => Math.min(L.expandedRulesPerLanguage + 1, a + b);
  let expandedRules = 0;
  for (const name of order) {
    const { state, index } = states.get(name)!;
    let longest = 0;
    let expanded = 0;
    for (const [ruleIndex, rule] of state.rules.entries()) {
      if ("include" in rule) {
        const target = rule.include.slice(1);
        longest = Math.max(longest, 1 + depth.get(target)!);
        expanded = saturatedAdd(expanded, count.get(target)!);
        if (longest > L.includeDepth)
          return {
            ok: false,
            fieldPath: `states[${index}].rules[${ruleIndex}].include`,
            message: "Include depth exceeds the v1 edge limit.",
            limit: "STATIC_LANGUAGE_LIMITS_V1.includeDepth",
            allowed: L.includeDepth,
            actual: longest,
          };
      } else expanded = saturatedAdd(expanded, 1);
    }
    depth.set(name, longest);
    count.set(name, expanded);
    expandedRules = saturatedAdd(expandedRules, expanded);
  }
  if (expandedRules > L.expandedRulesPerLanguage)
    return {
      ok: false,
      fieldPath: "states",
      message: "Expanded rule budget exceeded.",
      limit: "STATIC_LANGUAGE_LIMITS_V1.expandedRulesPerLanguage",
      allowed: L.expandedRulesPerLanguage,
      actual: expandedRules,
    };
  return { ok: true, expandedRules };
}
