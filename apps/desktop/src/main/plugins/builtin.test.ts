import { readFile } from "node:fs/promises";
import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import { BASIC_PLUS_KEYWORDS, BASIC_PLUS_INDENTATION_RULES } from "@kobrixa/basic-plus/language";
import type {
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "@kobrixa/plugin-protocol";

import { expect, it } from "vitest";
import { loadPlugins, resolveCompilerProviders } from "@kobrixa/plugin-runtime";
import { BuildError, failedBuild } from "@kobrixa/compiler";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import { BUILTIN_PLUGIN_SOURCES } from "./builtin.js";
import { createBuiltinCompilers } from "../workspace/builtin-compilers.js";

it("registers separate Basic Plus and EV3 providers in safe mode", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: true,
  });
  expect(plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
    ["kobrixa.ev3", "enabled"],
  ]);
  const snapshot = resolveCompilerProviders(plugins, "bp", "ev3-native");
  if (!snapshot.ok) throw new Error(snapshot.message);
  const { frontend, backend } = createBuiltinCompilers(snapshot);
  expect(frontend).toBeInstanceOf(BasicPlusFrontend);
  const project = {
    root: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      name: "demo",
      language: "bp",
      target: "ev3-native",
      entry: "main.bp",
      outputDir: "build",
      assets: [],
    },
    sources: [{ path: "main.bp", content: "LCD.Clear()\n" }],
    assets: [],
  };
  const signal = new AbortController().signal;
  const compiled = await frontend.compile(project, signal);
  const raw = await new EV3Backend().compile(compiled.ir!, signal);
  const adapted = await backend.compile(compiled.ir!, signal);
  expect(adapted).toEqual({
    artifacts: [
      { slot: "program", data: raw.rbf },
      { slot: "listing", data: new TextEncoder().encode(raw.listing) },
    ],
    diagnostics: raw.diagnostics,
  });
  expect(backend.declaration.capabilities.deploy).toBe("ev3");
  expect(backend.irVersion).toBe(1);
  expect(() =>
    createBuiltinCompilers({
      ...snapshot,
      backend: { ...snapshot.backend, pluginId: "test.missing" },
    }),
  ).toThrow("BUILD1001");
});

it("uses the package BuildError identity for missing built-in factories", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: false,
  });
  const snapshot = resolveCompilerProviders(plugins, "bp", "ev3-native");
  if (!snapshot.ok) throw new Error(snapshot.message);
  const error = (() => {
    try {
      createBuiltinCompilers({
        ...snapshot,
        backend: { ...snapshot.backend, pluginId: "test.missing" },
      });
    } catch (caught) {
      return caught;
    }
    throw new Error("Expected a missing factory error.");
  })();
  expect(error).toBeInstanceOf(BuildError);
  expect(failedBuild("missing-factory", "ev3-native", error, "main.bp")).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD1001" })],
  });
});

const repository = new URL("../../../../../", import.meta.url);
const readRepository = (file: string) => readFile(new URL(file, repository), "utf8");

it("declares bp without changing the builtin frontend or language service", () => {
  const source = BUILTIN_PLUGIN_SOURCES[0]!;
  expect(source.kind).toBe("builtin");
  if (source.kind !== "builtin") throw new Error("Expected bundled Basic Plus.");
  const manifest = pluginManifestSchema.parse(source.manifest);
  expect(manifest.id).toBe("kobrixa.basic-plus");
  expect(manifest.apiVersion).toBe("^1.4.0");
  expect(manifest.runtime).toEqual({ kind: "builtin" });
  expect(manifest.contributes?.languages).toEqual([
    {
      id: "bp",
      extensions: ["bp", "bpi", "bpm"],
      aliases: ["Basic Plus", "Basic+"],
      tokenizer: { version: 1, path: "language/tokenizer.json" },
      configuration: { version: 1, path: "language/configuration.json" },
    },
  ]);
  expect(manifest.contributes?.frontends).toEqual([
    {
      language: "bp",
      entryExtensions: ["bp"],
      sourceExtensions: ["bp", "bpi", "bpm"],
      ir: { min: 1, max: 1 },
    },
  ]);
  expect(manifest.contributes?.languageServices).toEqual([
    {
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: [
        "analysis",
        "completion",
        "quickFixes",
        "semanticTokens",
        "hover",
        "signatureHelp",
        "definition",
        "references",
        "rename",
        "documentSymbols",
        "documentFormatting",
        "rangeFormatting",
      ],
    },
  ]);
});

it("bundles exact UTF-8 resource text under the manifest's relative keys", async () => {
  const source = BUILTIN_PLUGIN_SOURCES[0]!;
  if (source.kind !== "builtin") throw new Error("Expected bundled Basic Plus.");
  expect(Object.keys(source.resources).sort()).toEqual([
    "language/configuration.json",
    "language/tokenizer.json",
  ]);
  for (const name of ["tokenizer", "configuration"] as const) {
    const resourcePath = `language/${name}.json`;
    const raw = await readRepository(`plugins/basic-plus/${resourcePath}`);
    const fixture = await readRepository(
      `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/${name}.json`,
    );
    expect(source.resources[resourcePath]).toBe(raw);
    expect(Buffer.from(source.resources[resourcePath]!, "utf8")).toEqual(
      await readFile(new URL(`plugins/basic-plus/${resourcePath}`, repository)),
    );
    expect(JSON.parse(raw)).toEqual(JSON.parse(fixture));
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
  }
  const ev3 = BUILTIN_PLUGIN_SOURCES[1]!;
  if (ev3.kind !== "builtin") throw new Error("Expected bundled EV3.");
  expect(ev3.resources).toEqual({});
});

it("keeps all keyword lists, nine ordered rules and the original configuration", async () => {
  const tokenizer = JSON.parse(
    await readRepository("plugins/basic-plus/language/tokenizer.json"),
  ) as StaticLanguageTokenizerV1;
  const configuration = JSON.parse(
    await readRepository("plugins/basic-plus/language/configuration.json"),
  ) as StaticLanguageConfigurationV1;
  expect(tokenizer.ignoreCase).toBe(true);
  expect(tokenizer.defaultToken).toBe("invalid");
  expect(tokenizer.tokenPostfix).toBe(".basic-plus");
  expect(tokenizer.states.map((state) => state.name)).toEqual(["root"]);
  expect(tokenizer.states[0]!.rules).toHaveLength(9);
  expect(tokenizer.lists).toEqual([
    { name: "keywords", words: [...BASIC_PLUS_KEYWORDS] },
    {
      name: "control",
      words: [
        "If",
        "Then",
        "Else",
        "ElseIf",
        "EndIf",
        "For",
        "To",
        "Step",
        "EndFor",
        "While",
        "EndWhile",
        "Break",
        "Continue",
        "Return",
        "Goto",
      ],
    },
    { name: "types", words: ["Number", "String"] },
    { name: "booleans", words: ["True", "False"] },
    { name: "word_operators", words: ["And", "Or", "Not"] },
  ]);
  for (const list of tokenizer.lists!)
    expect(new Set(list.words.map((word) => word.toLowerCase())).size).toBe(list.words.length);
  for (const rule of tokenizer.states[0]!.rules) {
    if (!("regex" in rule)) throw new Error("Basic Plus has no includes.");
    expect(rule.regex.flags).toBe("i");
  }
  const identifier = tokenizer.states[0]!.rules[4]!;
  if (!("regex" in identifier) || !("cases" in identifier.action))
    throw new Error("Expected ordered identifier cases.");
  expect(identifier.action.cases.map((branch) => branch.when)).toEqual([
    "@types",
    "@booleans",
    "@word_operators",
    "@control",
    "@keywords",
    "@default",
  ]);
  expect(configuration).toEqual({
    comments: { lineComment: "'" },
    brackets: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    indentationRules: Object.fromEntries(
      Object.entries(BASIC_PLUS_INDENTATION_RULES).map(([name, regex]) => [
        name,
        { pattern: regex.source, flags: regex.flags },
      ]),
    ),
  });
  expect(configuration).not.toHaveProperty("wordPattern");
  expect(configuration).not.toHaveProperty("onEnterRules");
  for (const name of ["increaseIndentPattern", "decreaseIndentPattern"] as const) {
    const data = configuration.indentationRules![name];
    const regex = new RegExp(data.pattern, data.flags);
    for (const line of [
      "If True Then",
      "\tELSEIF ready",
      "Else",
      "While ready",
      "For i = 1 To 2",
      "Sub Main()",
      "Function Double()",
      "Module Math",
      "EndIf",
      "EndWhile",
      "EndFor",
      "EndSub",
      "EndFunction",
      "EndModule",
      "If.member = 1",
      "ElseIf.member = 2",
      "WhileLoop = 1",
      "' If True Then",
      'caption = "If"',
    ])
      expect(regex.test(line), `${name}: ${line}`).toBe(
        BASIC_PLUS_INDENTATION_RULES[name].test(line),
      );
    expect(regex.test("If.member = 1")).toBe(false);
    expect(regex.test("Else.member = 1")).toBe(false);
  }
});
