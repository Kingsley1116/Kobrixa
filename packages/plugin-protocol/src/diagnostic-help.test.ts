import { expect, it } from "vitest";
import {
  DIAGNOSTIC_HELP_LIMITS as L,
  PLUGIN_API_VERSION,
  diagnosticCodeSchema,
  diagnosticHelpKeySchema,
  diagnosticHelpProblems,
  pluginDiagnosticHelpFileSchema,
  pluginManifestSchema,
} from "./index.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  code: "ACME100",
  title: { en: "Thing failed", "zh-TW": "動作失敗" },
  cause: { en: "Because.\nReally." },
  steps: { en: ["Do it again."] },
  links: [{ url: "https://example.com/help", label: { en: "Docs" } }],
  ...overrides,
});
const parse = (entries: unknown[]) => pluginDiagnosticHelpFileSchema.safeParse({ entries });

it("is API 1.4.0", () => expect(PLUGIN_API_VERSION).toBe("1.4.0"));
it("accepts a minimal English entry and a helpKey variant", () => {
  expect(parse([entry(), entry({ helpKey: "missing-paren" })]).success).toBe(true);
});
it("rejects source, HTML-style extra fields and unknown keys", () => {
  expect(parse([entry({ source: "acme.x" })]).success).toBe(false);
  expect(parse([entry({ html: "<b>" })]).success).toBe(false);
});
it("rejects non-https and malformed links", () => {
  for (const url of [
    "http://example.com",
    "javascript:alert(1)",
    "https://",
    "file:///etc/passwd",
  ]) {
    const file = parse([entry({ links: [{ url, label: { en: "x" } }] })]);
    expect(file.success && diagnosticHelpProblems(file.data).length === 0).toBe(false);
  }
});
it("enforces every per-field limit at and over the bound", () => {
  const line = (n: number) => "a".repeat(n);
  expect(parse([entry({ title: { en: line(L.lineLength) } })]).success).toBe(true);
  expect(parse([entry({ title: { en: line(L.lineLength + 1) } })]).success).toBe(false);
  expect(parse([entry({ cause: { en: line(L.blockLength) } })]).success).toBe(true);
  expect(parse([entry({ cause: { en: line(L.blockLength + 1) } })]).success).toBe(false);
  expect(parse([entry({ steps: { en: Array(L.stepsPerLocale).fill("s") } })]).success).toBe(true);
  expect(parse([entry({ steps: { en: Array(L.stepsPerLocale + 1).fill("s") } })]).success).toBe(
    false,
  );
  const link = { url: "https://example.com", label: { en: "x" } };
  expect(parse([entry({ links: Array(L.linksPerEntry).fill(link) })]).success).toBe(true);
  expect(parse([entry({ links: Array(L.linksPerEntry + 1).fill(link) })]).success).toBe(false);
  const url = `https://example.com/${"a".repeat(L.urlLength - 20)}`;
  expect(parse([entry({ links: [{ url, label: { en: "x" } }] })]).success).toBe(true);
  expect(parse([entry({ links: [{ url: url + "a", label: { en: "x" } }] })]).success).toBe(false);
  const many = Array.from({ length: L.entriesPerPlugin }, (_, i) => entry({ code: `ACME${i}` }));
  expect(parse(many).success).toBe(true);
  expect(parse([...many, entry({ code: "ACMEX" })]).success).toBe(false);
});
it("rejects single-line fields with newlines", () => {
  expect(parse([entry({ title: { en: "a\nb" } })]).success).toBe(false);
});
it("reports duplicate keys and oversized entries semantically", () => {
  const dup = parse([entry(), entry()]);
  expect(dup.success && diagnosticHelpProblems(dup.data)).toEqual([
    expect.stringMatching(/ACME100.*more than once/),
  ]);
  const big = parse([
    entry({
      cause: { en: "a".repeat(L.blockLength), "zh-TW": "a".repeat(L.blockLength) },
      steps: {
        en: Array(16).fill("a".repeat(L.lineLength)),
        "zh-TW": Array(16).fill("a".repeat(L.lineLength)),
      },
    }),
  ]);
  expect(big.success && diagnosticHelpProblems(big.data)).toEqual([
    expect.stringMatching(/larger than 16 KiB/),
  ]);
});
it("declares help with a contained relative json path", () => {
  const base = {
    id: "acme.x",
    version: "1.0.0",
    apiVersion: "^1.2.0",
    runtime: { kind: "node", entry: "main.js" },
  };
  const ok = (path: string) =>
    pluginManifestSchema.safeParse({
      ...base,
      contributes: { diagnosticHelp: { version: 1, path } },
    }).success;
  expect(ok("help.json")).toBe(true);
  expect(ok("diagnostics/help.json")).toBe(true);
  for (const bad of [
    "../help.json",
    "/help.json",
    "a/../help.json",
    "help.txt",
    "./help.json",
    "a\\help.json",
  ])
    expect(ok(bad)).toBe(false);
});

it("accepts English-only entries and optional examples without links", () => {
  const file = parse([
    entry({
      title: { en: "Failed" },
      example: { before: "old\ncode", after: "new\tcode" },
      links: undefined,
    }),
  ]);
  expect(file.success).toBe(true);
  expect(file.success && diagnosticHelpProblems(file.data)).toEqual([]);
});

it("requires English and rejects unknown keys throughout the resource", () => {
  expect(pluginDiagnosticHelpFileSchema.safeParse({ entries: [], source: "acme.x" }).success).toBe(
    false,
  );
  for (const overrides of [
    { title: { "zh-TW": "失敗" } },
    { cause: { "zh-TW": "原因" } },
    { steps: { "zh-TW": ["重試"] } },
    { title: { en: "Failed", fr: "Erreur" } },
    { cause: { en: "Because", html: "<b>" } },
    { steps: { en: ["Retry"], fr: ["Réessayer"] } },
    { example: { before: "a", after: "b", html: "<b>" } },
    { links: [{ url: "https://example.com", label: { "zh-TW": "文件" } }] },
    { links: [{ url: "https://example.com", label: { en: "Docs", fr: "Docs" } }] },
    { links: [{ url: "https://example.com", label: { en: "Docs" }, html: "<b>" }] },
  ])
    expect(parse([entry(overrides)]).success).toBe(false);
});

it("bounds each localized line, block and example field", () => {
  for (const locale of ["en", "zh-TW"]) {
    for (const length of [0, L.lineLength, L.lineLength + 1]) {
      const value = { en: "x", [locale]: "a".repeat(length) };
      for (const overrides of [
        { title: value },
        { steps: { en: ["x"], [locale]: [value[locale]] } },
        { links: [{ url: "https://example.com", label: value }] },
      ])
        expect(parse([entry(overrides)]).success).toBe(length === L.lineLength);
    }
    for (const length of [0, L.blockLength, L.blockLength + 1])
      expect(parse([entry({ cause: { en: "x", [locale]: "a".repeat(length) } })]).success).toBe(
        length === L.blockLength,
      );
    for (const count of [0, L.stepsPerLocale, L.stepsPerLocale + 1])
      expect(
        parse([entry({ steps: { en: ["x"], [locale]: Array(count).fill("s") } })]).success,
      ).toBe(count === L.stepsPerLocale);
  }
  for (const field of ["before", "after"])
    for (const length of [0, L.blockLength, L.blockLength + 1])
      expect(
        parse([entry({ example: { before: "a", after: "b", [field]: "a".repeat(length) } })])
          .success,
      ).toBe(length === L.blockLength);
});

it("rejects controls in blocks and newlines in all single-line fields", () => {
  for (const locale of ["en", "zh-TW"]) {
    const value = { en: "x", [locale]: "a\nb" };
    for (const overrides of [
      { title: value },
      { steps: { en: ["x"], [locale]: [value[locale]] } },
      { links: [{ url: "https://example.com", label: value }] },
      { cause: { en: "x", [locale]: "a\u0000b" } },
    ])
      expect(parse([entry(overrides)]).success).toBe(false);
  }
  expect(parse([entry({ example: { before: "a\u007fb", after: "ok" } })]).success).toBe(false);
});

it("enforces the diagnostic code and helpKey formats and lengths", () => {
  for (const code of ["A", "a_B.c-0", "A".repeat(64)])
    expect(diagnosticCodeSchema.safeParse(code).success).toBe(true);
  for (const code of ["", "0A", "A/B", "A:B", "A".repeat(65)])
    expect(diagnosticCodeSchema.safeParse(code).success).toBe(false);
  for (const helpKey of ["a", "missing-paren", "0".repeat(100)])
    expect(diagnosticHelpKeySchema.safeParse(helpKey).success).toBe(true);
  for (const helpKey of ["", "Upper", "a_b", "a.b", "a".repeat(101)])
    expect(diagnosticHelpKeySchema.safeParse(helpKey).success).toBe(false);
});

it("uses both code and helpKey when checking duplicate entries", () => {
  const variants = parse([entry(), entry({ helpKey: "variant" }), entry({ code: "ACME101" })]);
  expect(variants.success && diagnosticHelpProblems(variants.data)).toEqual([]);
  const duplicate = parse([entry({ helpKey: "variant" }), entry({ helpKey: "variant" })]);
  expect(duplicate.success && diagnosticHelpProblems(duplicate.data)).toEqual([
    "Diagnostic help for ACME100#variant is declared more than once.",
  ]);
});

it("accepts exactly 16 KiB of serialized UTF-8 and rejects one byte more", () => {
  const steps = [...Array<string>(8).fill("s".repeat(L.lineLength)), ""];
  const sized = entry({ cause: { en: "界".repeat(L.blockLength) }, steps: { en: steps } });
  const encoder = new TextEncoder();
  steps[8] = "a".repeat(L.entryBytes - encoder.encode(JSON.stringify(sized)).length);
  expect(encoder.encode(JSON.stringify(sized)).length).toBe(L.entryBytes);
  const atLimit = parse([sized]);
  expect(atLimit.success).toBe(true);
  expect(atLimit.success && diagnosticHelpProblems(atLimit.data)).toEqual([]);

  steps[8] += "a";
  expect(encoder.encode(JSON.stringify(sized)).length).toBe(L.entryBytes + 1);
  const overLimit = parse([sized]);
  expect(overLimit.success).toBe(true);
  expect(overLimit.success && diagnosticHelpProblems(overLimit.data)).toEqual([
    "Diagnostic help for ACME100 is larger than 16 KiB.",
  ]);
});

it("rejects malformed hosts semantically after a successful structural parse", () => {
  for (const url of [
    "https://?query",
    "https://#fragment",
    "https://[bad]",
    "https://example.com:bad",
  ]) {
    const file = parse([entry({ links: [{ url, label: { en: "Docs" } }] })]);
    expect(file.success).toBe(true);
    expect(file.success && diagnosticHelpProblems(file.data)).toEqual([
      "Diagnostic help for ACME100 has an invalid https link.",
    ]);
  }
  for (const url of ["https://example.com/a b", "https://example.com/\u0000"])
    expect(parse([entry({ links: [{ url, label: { en: "Docs" } }] })]).success).toBe(false);
});
