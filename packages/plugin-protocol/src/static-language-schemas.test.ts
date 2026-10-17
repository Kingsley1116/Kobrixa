import { expect, it } from "vitest";
import {
  staticLanguageTokenizerV1Schema as tokenizer,
  staticLanguageConfigurationV1Schema as configuration,
} from "./static-languages.js";

const rule = { regex: { pattern: ".", flags: "" }, action: { token: "identifier" } };
const grammar = { ignoreCase: false, states: [{ name: "root", rules: [rule] }] };

it("exports strict, ordered resource shapes with no executable Monarch shortcuts", () => {
  expect(tokenizer.parse(grammar)).toEqual(grammar);
  expect(configuration.parse({})).toEqual({});
  for (const value of [
    { ...grammar, start: "other" },
    { ...grammar, unicode: true },
    { ...grammar, version: 1 },
    { ...grammar, states: [{ name: "root", rules: [[".", "identifier"]] }] },
    { ...grammar, states: [{ name: "root", rules: [{ ...rule, extra: 1 }] }] },
    {
      ...grammar,
      states: [{ name: "root", rules: [{ ...rule, action: { token: "x", goBack: 1 } }] }],
    },
    { ...grammar, states: [{ name: "root", rules: [{ ...rule, action: [{ token: "x" }] }] }] },
    {
      ...grammar,
      states: [
        {
          name: "root",
          rules: [{ ...rule, action: { cases: [{ when: "@default", action: { cases: [] } }] } }],
        },
      ],
    },
  ])
    expect(tokenizer.safeParse(value).success).toBe(false);
  for (const flags of [undefined, "g", "y", "d", "m", "s", "u", "v", "ii", "ig"])
    expect(configuration.safeParse({ wordPattern: { pattern: "x", flags } }).success).toBe(false);
  for (const value of [
    { extra: true },
    { comments: { extra: true } },
    { brackets: [{ open: "(", close: ")", extra: true }] },
    { onEnterRules: [{ beforeText: { pattern: "^", flags: "" }, action: { indentAction: 1 } }] },
  ])
    expect(configuration.safeParse(value).success).toBe(false);
});

it("bounds code points, tables, rules, states, words, cases and Enter actions", () => {
  for (const count of [16, 17])
    expect(configuration.safeParse({ comments: { lineComment: "😀".repeat(count) } }).success).toBe(
      count === 16,
    );
  for (const count of [256, 257])
    expect(
      configuration.safeParse({
        onEnterRules: [
          {
            beforeText: { pattern: "^", flags: "" },
            action: { indentAction: "indent", appendText: "😀".repeat(count), removeText: count },
          },
        ],
      }).success,
    ).toBe(count === 256);
  for (const removeText of [-1, 0.5, 257])
    expect(
      configuration.safeParse({
        onEnterRules: [
          { beforeText: { pattern: "^", flags: "" }, action: { indentAction: "none", removeText } },
        ],
      }).success,
    ).toBe(false);
  for (const [count, ok] of [
    [32, true],
    [33, false],
  ] as const)
    expect(
      configuration.safeParse({ brackets: Array(count).fill({ open: "(", close: ")" }) }).success,
    ).toBe(ok);
  for (const [count, ok] of [
    [64, true],
    [65, false],
  ] as const)
    expect(
      tokenizer.safeParse({ ...grammar, states: Array(count).fill(grammar.states[0]) }).success,
    ).toBe(ok);
  for (const pattern of ["", "x".repeat(2049), "\t", "\u0085"])
    expect(configuration.safeParse({ wordPattern: { pattern, flags: "" } }).success).toBe(false);
  expect(configuration.safeParse({ wordPattern: { pattern: "\\t", flags: "i" } }).success).toBe(
    true,
  );
  expect(
    tokenizer.safeParse({ ...grammar, lists: [{ name: "words", words: ["😀".repeat(64)] }] })
      .success,
  ).toBe(true);
  expect(
    tokenizer.safeParse({ ...grammar, lists: [{ name: "words", words: ["😀".repeat(65)] }] })
      .success,
  ).toBe(false);
  for (const token of ["@rematch", "$1", "A", "x".repeat(81)])
    expect(tokenizer.safeParse({ ...grammar, defaultToken: token }).success).toBe(false);
});

it("pins every remaining structural collection boundary at limit and limit plus one", () => {
  const enter = { beforeText: { pattern: "^", flags: "" }, action: { indentAction: "none" } };
  for (const count of [32, 33]) {
    expect(
      tokenizer.safeParse({
        ...grammar,
        lists: Array.from({ length: count }, (_, i) => ({ name: `l${i}`, words: [] })),
      }).success,
    ).toBe(count === 32);
    expect(
      tokenizer.safeParse({
        ...grammar,
        brackets: Array(count).fill({ open: "(", close: ")", token: "" }),
      }).success,
    ).toBe(count === 32);
    expect(configuration.safeParse({ onEnterRules: Array(count).fill(enter) }).success).toBe(
      count === 32,
    );
    for (const key of ["autoClosingPairs", "surroundingPairs"])
      expect(
        configuration.safeParse({ [key]: Array(count).fill({ open: "(", close: ")" }) }).success,
      ).toBe(count === 32);
    expect(
      tokenizer.safeParse({
        ...grammar,
        states: [
          {
            name: "root",
            rules: [
              {
                ...rule,
                action: { cases: Array(count).fill({ when: "@default", action: { token: "" } }) },
              },
            ],
          },
        ],
      }).success,
    ).toBe(count === 32);
  }
  for (const count of [1024, 1025])
    expect(
      tokenizer.safeParse({
        ...grammar,
        states: [{ name: "root", rules: Array(count).fill(rule) }],
      }).success,
    ).toBe(count === 1024);
  for (const count of [4096, 4097])
    expect(
      tokenizer.safeParse({
        ...grammar,
        lists: [{ name: "words", words: Array(count).fill("word") }],
      }).success,
    ).toBe(count === 4096);
  for (const count of [32, 33])
    expect(
      tokenizer.safeParse({ ...grammar, states: [{ name: "a".repeat(count), rules: [] }] }).success,
    ).toBe(count === 32);
  for (const count of [80, 81]) {
    expect(tokenizer.safeParse({ ...grammar, defaultToken: "a".repeat(count) }).success).toBe(
      count === 80,
    );
    expect(
      tokenizer.safeParse({ ...grammar, tokenPostfix: "." + "a".repeat(count - 1) }).success,
    ).toBe(count === 80);
  }
  for (const notIn of [
    ["string", "comment", "regex"],
    ["string", "comment", "regex", "string"],
  ])
    expect(
      configuration.safeParse({ autoClosingPairs: [{ open: "(", close: ")", notIn }] }).success,
    ).toBe(notIn.length === 3);
  expect(tokenizer.safeParse({ ...grammar, states: [] }).success).toBe(false);
});
