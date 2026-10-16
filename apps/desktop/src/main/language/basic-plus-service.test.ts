import { expect, it } from "vitest";
import { BasicPlusProjectAnalyzer } from "@kobrixa/basic-plus";
import type { SourceProject } from "@kobrixa/compiler";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import { basicPlusLanguageService } from "./basic-plus-service.js";
import { offersBasicPlusQuickFix } from "./basic-plus-quick-fixes.js";
const signal = new AbortController().signal;
const project: SourceProject = {
  root: "/project",
  manifest: {
    schemaVersion: 1,
    name: "test",
    language: "bp",
    entry: "main.bp",
    target: "ev3-native",
    outputDir: "out",
    assets: [],
  },
  assets: [],
  sources: [
    { path: "main.bp", content: 'Include "config"\nImport "helper"\nresult = Double(shared)\n' },
    { path: "config.bpi", content: "shared = 2\n" },
    {
      path: "helper.bpm",
      content: "Function Double(in number value)\nReturn value * 2\nEndFunction\n",
    },
  ],
};
it("preserves native diagnostics, tokens and source snapshots with generic display symbols", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  const raw = new BasicPlusProjectAnalyzer().analyze(project, signal);
  const result = provider.analyze(project, 1, signal);
  expect(result.diagnostics).toEqual(raw.diagnostics);
  expect(result.tokensByFile).toEqual(raw.tokensByFile);
  expect(result.index.sources).toEqual(raw.index.sources);
  const double = Object.values(result.index.symbols).find((s) => s.name === "Double")!;
  expect(double).toMatchObject({
    kind: "function",
    signature: "Double(in number value): number",
    shadowKey: "call:double",
  });
  expect(double).not.toHaveProperty("parameters");
  expect(double).not.toHaveProperty("scope");
  expect(
    provider.query(1, { kind: "definition", file: "main.bp", line: 3, column: 10 }, signal),
  ).toMatchObject({
    kind: "definition",
    locations: [{ file: "helper.bpm" }],
  });
  expect([...basicPlusLanguageService.capabilities]).toEqual([...LANGUAGE_CAPABILITIES]);
  provider.dispose();
  expect(() => provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toThrow(
    "Analysis expired",
  );
});
it("keeps two raw analyses and returns localized, single-file fixes", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  const broken = { ...project, sources: [{ path: "main.bp", content: "LCD.Clear(\n" }] };
  const one = provider.analyze(broken, 1, signal);
  const diagnostic = one.diagnostics.find((d) => d.code === "BP1043")!;
  const fixes = provider.quickFixes(
    1,
    "main.bp",
    { ...diagnostic, source: "kobrixa.basic-plus" },
    signal,
  );
  expect(fixes[0]?.title).toEqual({ en: "Insert closing parenthesis )", "zh-TW": "補上右括號 )" });
  provider.analyze(project, 2, signal);
  provider.analyze(project, 3, signal);
  expect(() => provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toThrow(
    "Analysis expired",
  );
  provider.dispose();
});

it("only offers Basic Plus fixes for Basic Plus diagnostics", () => {
  expect(offersBasicPlusQuickFix({ source: "kobrixa.basic-plus", code: "BP1015" })).toBe(true);
  expect(offersBasicPlusQuickFix({ source: "acme.x", code: "BP1015" })).toBe(false);
  expect(offersBasicPlusQuickFix({ source: "kobrixa.basic-plus", code: "BP9999" })).toBe(false);
});

it("publishes document symbols with Sub detail and nested local variables", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  try {
    provider.analyze(
      {
        ...project,
        sources: project.sources.map((source) =>
          source.path === "helper.bpm"
            ? { ...source, content: source.content + "Sub Blink()\nlocalValue = 1\nEndSub\n" }
            : source,
        ),
      },
      1,
      signal,
    );
    expect(provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toMatchObject({
      kind: "documentSymbols",
      symbols: [{ name: "result", kind: "variable", children: [] }],
    });
    expect(
      provider.query(1, { kind: "documentSymbols", file: "helper.bpm" }, signal),
    ).toMatchObject({
      kind: "documentSymbols",
      symbols: [
        { name: "Double", kind: "function", detail: "", children: [] },
        {
          name: "Blink",
          kind: "function",
          detail: "Sub",
          range: { startLine: 4, endLine: 6 },
          selectionRange: { startLine: 4, startColumn: 5, endLine: 4, endColumn: 10 },
          children: [{ name: "localValue", kind: "variable", children: [] }],
        },
      ],
    });
  } finally {
    provider.dispose();
  }
});

it("returns signature parameter ranges for user functions and API calls", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  try {
    provider.analyze(
      {
        ...project,
        sources: project.sources.map((source) =>
          source.path === "main.bp"
            ? { ...source, content: source.content + 'LCD.Text(1, 0, 0, 1, "Hi")\n' }
            : source,
        ),
      },
      1,
      signal,
    );
    expect(
      provider.query(
        1,
        {
          kind: "signatureHelp",
          file: "main.bp",
          line: 3,
          column: 17,
        },
        signal,
      ),
    ).toEqual({
      kind: "signatureHelp",
      value: {
        label: "Double(in number value): number",
        parameters: [[7, 22]],
        activeParameter: 0,
      },
    });
    const api = provider.query(
      1,
      {
        kind: "signatureHelp",
        file: "main.bp",
        line: 4,
        column: 13,
      },
      signal,
    );
    if (api.kind !== "signatureHelp" || !api.value) throw new Error("Expected API signature");
    expect(api.value.activeParameter).toBe(1);
    expect(api.value.parameters).toEqual([
      [9, 16],
      [18, 25],
      [27, 34],
      [36, 43],
      [45, 70],
    ]);
    expect(api.value.parameters.map(([start, end]) => api.value!.label.slice(start, end))).toEqual([
      "integer",
      "integer",
      "integer",
      "integer",
      "string | integer | number",
    ]);
    expect(api.value.documentation).toEqual(expect.any(String));
  } finally {
    provider.dispose();
  }
});

it("returns hover, references and rename edits for an imported function", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  try {
    provider.analyze(project, 1, signal);
    const position = { file: "main.bp", line: 3, column: 10 };
    const call = {
      file: "main.bp",
      range: {
        startLine: 3,
        startColumn: 10,
        endLine: 3,
        endColumn: 16,
      },
    };
    const declaration = {
      file: "helper.bpm",
      range: {
        startLine: 1,
        startColumn: 10,
        endLine: 1,
        endColumn: 16,
      },
    };
    expect(provider.query(1, { kind: "hover", ...position }, signal)).toEqual({
      kind: "hover",
      value: {
        range: call.range,
        contents: ["```basic-plus\nDouble(in number value): number\n```"],
      },
    });
    expect(
      provider.query(
        1,
        {
          kind: "references",
          ...position,
          includeDeclaration: false,
        },
        signal,
      ),
    ).toMatchObject({ kind: "references", locations: [call] });
    const references = provider.query(
      1,
      {
        kind: "references",
        ...position,
        includeDeclaration: true,
      },
      signal,
    );
    expect(references).toEqual({
      kind: "references",
      locations: expect.arrayContaining([
        expect.objectContaining(declaration),
        expect.objectContaining(call),
      ]),
    });
    if (references.kind !== "references") throw new Error("Expected references");
    expect(references.locations).toHaveLength(2);
    expect(provider.query(1, { kind: "renameLocation", ...position }, signal)).toEqual({
      kind: "renameLocation",
      range: call.range,
      text: "Double",
    });
    const rename = provider.query(1, { kind: "rename", ...position, newName: "Twice" }, signal);
    expect(rename).toEqual({
      kind: "rename",
      edits: expect.arrayContaining([
        { ...call, text: "Twice", expected: "Double" },
        { ...declaration, text: "Twice", expected: "Double" },
      ]),
    });
    if (rename.kind !== "rename") throw new Error("Expected rename");
    expect(rename.edits).toHaveLength(2);
  } finally {
    provider.dispose();
  }
});

it("matches fresh analysis after incremental dependency and UTF-16 edits", () => {
  const incremental = basicPlusLanguageService.createAnalysis();
  try {
    let version = 0;
    for (const text of [
      'Include "config"\nImport "helper"\nresult = Double(shared)\n',
      '\uFEFF\' 中文😀\r\nInclude "config"\r\nresult = shared\r\n',
      'Include "config"\nshared = 7\nLCD.Clear(\n',
    ]) {
      const next = {
        ...project,
        sources: project.sources.map((source) =>
          source.path === "main.bp" ? { ...source, content: text } : source,
        ),
      };
      const fresh = basicPlusLanguageService.createAnalysis();
      try {
        expect(incremental.analyze(next, ++version, signal)).toEqual(
          fresh.analyze(next, version, signal),
        );
      } finally {
        fresh.dispose();
      }
    }
  } finally {
    incremental.dispose();
  }
});
