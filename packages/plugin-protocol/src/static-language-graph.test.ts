import { expect, it } from "vitest";
import { inspectStaticLanguageGraph } from "./static-language-graph.js";
import type { Rule, StaticLanguageTokenizerV1 } from "./static-languages.js";

const leaf: Rule = { regex: { pattern: ".", flags: "" }, action: { token: "" } };
const grammar = (states: StaticLanguageTokenizerV1["states"]): StaticLanguageTokenizerV1 => ({
  ignoreCase: false,
  states,
});
const chain = (edges: number) =>
  grammar(
    Array.from({ length: edges + 1 }, (_, i) => ({
      name: i === 0 ? "root" : `s${i}`,
      rules: i < edges ? [{ include: `@s${i + 1}` }] : [leaf],
    })),
  );

it("checks missing references and direct, indirect and unreachable cycles", () => {
  expect(
    inspectStaticLanguageGraph(grammar([{ name: "root", rules: [{ include: "@missing" }] }])),
  ).toMatchObject({ ok: false, fieldPath: "states[0].rules[0].include" });
  for (const states of [
    [{ name: "root", rules: [{ include: "@root" }] }],
    [
      { name: "root", rules: [{ include: "@a" }] },
      { name: "a", rules: [{ include: "@root" }] },
    ],
    [
      { name: "root", rules: [leaf] },
      { name: "a", rules: [{ include: "@b" }] },
      { name: "b", rules: [{ include: "@a" }] },
    ],
  ]) {
    const result = inspectStaticLanguageGraph(grammar(states));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/root -> root|root -> a -> root|a -> b -> a/);
  }
});

it("boundary include depth independently of DFS visitation order", () => {
  for (const edges of [0, 1, 15, 16])
    expect(inspectStaticLanguageGraph(chain(edges))).toEqual({
      ok: true,
      expandedRules: edges + 1,
    });
  expect(inspectStaticLanguageGraph(chain(17))).toMatchObject({
    ok: false,
    limit: "STATIC_LANGUAGE_LIMITS_V1.includeDepth",
    allowed: 16,
    actual: 17,
  });
  const value = chain(17);
  value.states[0]!.rules.unshift({ include: "@s17" });
  // The short edge visits the shared leaf first; the longer path must still fail.
  expect(inspectStaticLanguageGraph(value)).toMatchObject({ ok: false, actual: 17 });
  value.states.reverse();
  expect(inspectStaticLanguageGraph(value)).toMatchObject({ ok: false, actual: 17 });
});

it("boundary expanded rules with bounded raw entries", () => {
  for (const total of [0, 1, 8191, 8192, 8193]) {
    const states: StaticLanguageTokenizerV1["states"] =
      total < 2
        ? [{ name: "root", rules: Array.from({ length: total }, () => leaf) }]
        : [
            { name: "root", rules: Array.from({ length: 128 }, () => leaf) },
            ...Array.from({ length: 62 }, (_, i) => ({
              name: `s${i}`,
              rules: [{ include: "@root" }],
            })),
            { name: "tail", rules: Array.from({ length: total - 8064 }, () => leaf) },
          ];
    const result = inspectStaticLanguageGraph(grammar(states));
    if (total <= 8192) expect(result).toEqual({ ok: true, expandedRules: total });
    else expect(result).toMatchObject({ ok: false, actual: 8193 });
  }
});

it("counts repeated includes for every state before any materialization", () => {
  const rules: Rule[] = Array.from({ length: 128 }, () => leaf);
  const states = Array.from({ length: 64 }, (_, i) => ({
    name: i === 0 ? "root" : `s${i}`,
    rules: i === 0 ? rules : [{ include: "@root" }],
  }));
  expect(inspectStaticLanguageGraph(grammar(states))).toEqual({ ok: true, expandedRules: 8192 });
  states[1]!.rules.push(leaf);
  expect(inspectStaticLanguageGraph(grammar(states))).toMatchObject({
    ok: false,
    limit: "STATIC_LANGUAGE_LIMITS_V1.expandedRulesPerLanguage",
    actual: 8193,
  });
  const exponential = chain(16);
  for (const state of exponential.states.slice(0, -1)) state.rules.push(...state.rules);
  expect(inspectStaticLanguageGraph(exponential)).toMatchObject({ ok: false, actual: 8193 });
});

it("does not mistake legal next transitions for include edges", () => {
  expect(
    inspectStaticLanguageGraph(
      grammar([
        {
          name: "root",
          rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next: "@a" } }],
        },
        {
          name: "a",
          rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next: "@root" } }],
        },
      ]),
    ),
  ).toEqual({ ok: true, expandedRules: 2 });
});
