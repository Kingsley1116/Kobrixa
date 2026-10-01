import { describe, expect, it } from "vitest";
import type { SourceProject } from "@kobrixa/compiler";
import {
  analyzeBasicPlusProject,
  BasicPlusProjectAnalyzer,
  BasicPlusCompletionAnalyzer,
  type BasicPlusProjectAnalysis,
} from "./analysis.js";
import { BasicPlusFrontend } from "./frontend.js";

function project(files: Record<string, string>): SourceProject {
  return {
    root: "/project",
    manifest: {
      schemaVersion: 1,
      name: "test",
      language: "bp",
      entry: "main.bp",
      target: "ev3-native",
      assets: [],
      outputDir: "out",
    },
    sources: Object.entries(files).map(([path, content]) => ({ path, content })),
    assets: [],
  };
}
function analyze(files: Record<string, string>) {
  const result = analyzeBasicPlusProject(project(files), new AbortController().signal);
  const tokens = (file = "main.bp") =>
    (result.tokensByFile[file] ?? []).map((token) => ({
      text: files[file]!.split("\n")[token.range.startLine - 1]!.slice(
        token.range.startColumn - 1,
        token.range.endColumn - 1,
      ),
      line: token.range.startLine,
      type: token.type,
      modifiers: token.modifiers,
    }));
  return { result, tokens };
}

describe("project semantic analysis", () => {
  it("resolves nested and case-insensitive imports, aliases and unsaved sources with compiler diagnostics", async () => {
    const files = {
      "main.bp":
        'Include "PARTS/settings"\nImport "lib/message"\nanswer = message.Twice(shared)\nThread.Run = Blink\n',
      "parts/settings.bpi": "shared = 2\n",
      "lib/message.bpm":
        'Import "../parts/blink"\nFunction Twice(in number value)\nReturn value * 2\nEndFunction\n',
      "parts/blink.bpm": 'Import "../lib/message"\nSub Blink()\nLCD.Clear()\nEndSub\n',
    };
    const { result, tokens } = analyze(files);
    expect(result.diagnostics).toEqual(
      (await new BasicPlusFrontend().compile(project(files), new AbortController().signal))
        .diagnostics,
    );
    expect(result.diagnostics).toEqual([]);
    expect(tokens()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "message", type: "namespace", modifiers: [] }),
        expect.objectContaining({ text: "Twice", type: "function" }),
        expect.objectContaining({ text: "shared", type: "variable", modifiers: ["global"] }),
        expect.objectContaining({
          text: "Thread",
          type: "namespace",
          modifiers: ["defaultLibrary"],
        }),
        expect.objectContaining({ text: "Run", type: "method", modifiers: ["defaultLibrary"] }),
        expect.objectContaining({ text: "Blink", type: "function" }),
      ]),
    );
    expect(tokens("lib/message.bpm").filter((t) => t.text === "value")).toEqual([
      { text: "value", line: 2, type: "parameter", modifiers: ["declaration"] },
      { text: "value", line: 3, type: "parameter", modifiers: [] },
    ]);
  });

  it("preserves implicit bindings, parameter precedence, @, arrays and output arguments", () => {
    const { tokens, result } = analyze({
      "main.bp": [
        "shared = 1",
        "number[] data",
        "data[0] = shared",
        "Copy(shared, output)",
        "Function Copy(in number shared, out number output)",
        "@shared += 1",
        "localValue = @outside",
        "output = localValue",
        "Return",
        "EndFunction",
      ].join("\n"),
    });
    expect(result.diagnostics).toEqual([]);
    expect(tokens()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "shared",
          line: 1,
          type: "variable",
          modifiers: ["declaration", "global"],
        }),
        expect.objectContaining({ text: "data", line: 3, modifiers: ["global"] }),
        expect.objectContaining({ text: "shared", line: 6, type: "parameter", modifiers: [] }),
        expect.objectContaining({ text: "outside", line: 7, modifiers: ["declaration", "global"] }),
        expect.objectContaining({
          text: "localValue",
          line: 7,
          modifiers: ["declaration", "local"],
        }),
        expect.objectContaining({ text: "output", line: 8, type: "parameter" }),
      ]),
    );
  });

  it("colors zero-argument APIs and resolved labels without inventing built-in namespaces", () => {
    const { tokens } = analyze({
      "main.bp": "now = Time.Get1\nLCD = 1\nLCD.Unknown()\nGoto finish\nfinish:\n",
    });
    expect(tokens()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Time", type: "namespace", modifiers: ["defaultLibrary"] }),
        expect.objectContaining({ text: "Get1", type: "method", modifiers: ["defaultLibrary"] }),
        expect.objectContaining({ text: "LCD", line: 2, type: "variable" }),
        expect.objectContaining({ text: "finish", line: 4, type: "label", modifiers: [] }),
        expect.objectContaining({
          text: "finish",
          line: 5,
          type: "label",
          modifiers: ["declaration"],
        }),
      ]),
    );
    expect(tokens().filter((t) => t.line === 3)).toEqual([]);
  });

  it("isolates files outside the entry graph but resolves their own dependencies", () => {
    const { tokens } = analyze({
      "main.bp": "Hidden()\nvalue = 1\n",
      "unused.bp": 'Import "hidden"\nHidden()\n',
      "hidden.bpm": "Sub Hidden()\nvalue = 2\nEndSub\n",
    });
    expect(tokens().some((t) => t.text === "Hidden")).toBe(false);
    expect(tokens("unused.bp")).toContainEqual({
      text: "Hidden",
      line: 2,
      type: "function",
      modifiers: [],
    });
    expect(tokens("hidden.bpm")).toContainEqual({
      text: "value",
      line: 2,
      type: "variable",
      modifiers: ["declaration", "local"],
    });
  });

  it("retains reliable tokens with broken syntax, missing imports and unknown expressions", () => {
    const { result, tokens } = analyze({
      "main.bp":
        'Import "missing"\nvalue = 1\nFunction Half(in number input)\nReturn input +\nEndFunction\nLCD.Clear()\n',
      "other.bp": 'text = "unfinished\nnumber data\n',
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["BP1100", "BP1041", "BP1003"]),
    );
    expect(tokens()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Half", type: "function" }),
        expect.objectContaining({ text: "input", line: 4, type: "parameter" }),
        expect.objectContaining({ text: "Clear", type: "method" }),
      ]),
    );
    expect(tokens("other.bp")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "data", type: "variable" })]),
    );
    const unresolved = analyze({ "main.bp": "value = Unknown()\nLCD.Clear()\n" });
    expect(unresolved.tokens()).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Clear", type: "method" })]),
    );
  });

  it("uses exact UTF-16 source ranges, never emitting comments, literal text or duplicate synthetic references", () => {
    const files = {
      "main.bp":
        '\ufeffcaption = "中文😀" + Text.Append("x", "y")\r\n\' LCD.Clear()\r\ncaption = "say ""hello"""\r\ncount = 0\r\ncount++\r\n',
    };
    const { result, tokens } = analyze(files);
    expect(
      tokens()
        .filter((t) => t.line === 1)
        .map((t) => t.text),
    ).toEqual(["caption", "Text", "Append"]);
    expect(tokens().some((t) => t.line === 2)).toBe(false);
    expect(tokens().filter((t) => t.line === 5)).toHaveLength(1);
    assertRanges(result, files);
  });

  it("honors cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      analyzeBasicPlusProject(project({ "main.bp": "LCD.Clear()" }), controller.signal),
    ).toThrow();
  });
});

function assertRanges(result: BasicPlusProjectAnalysis, files: Record<string, string>) {
  for (const [file, tokens] of Object.entries(result.tokensByFile)) {
    let lastLine = 0,
      lastColumn = 0;
    for (const { range } of tokens) {
      expect(range.endLine).toBe(range.startLine);
      expect(range.endColumn).toBeGreaterThan(range.startColumn);
      expect(range.endColumn).toBeLessThanOrEqual(
        files[file]!.split("\n")[range.startLine - 1]!.length + 1,
      );
      expect(
        range.startLine > lastLine ||
          (range.startLine === lastLine && range.startColumn >= lastColumn),
      ).toBe(true);
      lastLine = range.endLine;
      lastColumn = range.endColumn;
    }
  }
}

describe("incremental project analysis", () => {
  it("reparses only edited files and rebinds only affected dependency contexts", () => {
    const analyzer = new BasicPlusProjectAnalyzer();
    const files = {
      "main.bp": 'Import "math"\nanswer = Double(2)\n',
      "math.bpm": "Function Double(in number value)\nReturn value * 2\nEndFunction\n",
      "other.bp": 'Import "helper"\nHelper()\n',
      "helper.bpm": "Sub Helper()\nLCD.Clear()\nEndSub\n",
    };
    const check = () => {
      const input = project(files);
      const result = analyzer.analyze(input, new AbortController().signal);
      expect(result).toEqual(analyzeBasicPlusProject(input, new AbortController().signal));
      return result;
    };
    const first = check();
    check();
    expect(analyzer.lastRun).toEqual({ parsedFiles: [], analyzedContexts: [] });
    files["math.bpm"] = files["math.bpm"].replace("value * 2", '"text"');
    check();
    expect(analyzer.lastRun).toEqual({ parsedFiles: ["math.bpm"], analyzedContexts: ["main.bp"] });
    files["helper.bpm"] += "' modified\n";
    check();
    expect(analyzer.lastRun).toEqual({
      parsedFiles: ["helper.bpm"],
      analyzedContexts: ["other.bp", "helper.bpm"],
    });
    // Later inference and sorting must never mutate an earlier cached response.
    expect(first.index.sources["math.bpm"]).toContain("value * 2");
    expect(Object.values(first.index.symbols).find((s) => s.name === "Double")?.type).toBe(
      "number",
    );
  });

  it("matches a fresh analysis through imports, cycles, rename, deletion, syntax recovery and entry switches", () => {
    const analyzer = new BasicPlusProjectAnalyzer();
    const files: Record<string, string> = {
      "main.bp": 'Import "LIB"\nCallMe()\n',
      "other.bp": "local = 1\n",
    };
    const check = (entry = "main.bp", root = "/project") => {
      const input = project(files);
      input.manifest.entry = entry;
      input.root = root;
      const result = analyzer.analyze(input, new AbortController().signal);
      expect(result).toEqual(analyzeBasicPlusProject(input, new AbortController().signal));
    };
    check();
    files["lib.bpm"] = 'Import "main.bp"\nSub CallMe()\nvalue = 1\nEndSub\n';
    check();
    files["main.bp"] += "value = 2\n";
    check();
    files["LIB.bpm"] = files["lib.bpm"]!;
    delete files["lib.bpm"];
    check();
    files["other.bp"] = 'text = "unfinished\n';
    check();
    files["other.bp"] = "local = 1\n";
    check();
    delete files["LIB.bpm"];
    check();
    check("other.bp");
    check("main.bp");
    check("main.bp", "/different-project");
    expect(analyzer.lastRun.parsedFiles).toEqual(Object.keys(files));
  });

  it("recovers after cancellation without retaining partial binding results", () => {
    const analyzer = new BasicPlusProjectAnalyzer();
    const input = project({ "main.bp": "value = 1\n".repeat(100), "other.bp": "other = 2\n" });
    const signal = new AbortController().signal;
    let checks = 0;
    signal.throwIfAborted = () => {
      if (++checks === 20) throw new Error("cancelled");
    };
    expect(() => analyzer.analyze(input, signal)).toThrow("cancelled");
    expect(analyzer.analyze(input, new AbortController().signal)).toEqual(
      analyzeBasicPlusProject(input, new AbortController().signal),
    );
  });
});

it("builds compact completion indexes with the same binding rules and reuses unchanged parses", () => {
  const files = {
    "main.bp":
      'Include "CONFIG"\r\nImport "helper"\r\nnumber[] data\r\nCopy(shared, output)\r\nThread.Run = Blink\r\n',
    "config.bpi": "shared = 2\n",
    "helper.bpm":
      'Import "cycle"\nFunction Copy(in number shared, out number output)\n@shared += 1\nlocalValue = @outside\noutput = localValue\nnow = Time.Get1\nReturn output\nEndFunction\nSub Blink()\nEndSub\n',
    "cycle.bpm": 'Import "helper"\n',
    "isolated.bp": "hidden = 3\n",
  };
  const signal = new AbortController().signal;
  const fast = new BasicPlusCompletionAnalyzer();
  const result = fast.analyze(project(files), signal);
  const full = analyzeBasicPlusProject(project(files), signal).index;
  const names = (symbols: typeof full.symbols) =>
    Object.values(symbols)
      .filter((s) => s.scope !== "builtin")
      .map(({ id, name, kind, scope, scopeId, context, aliases, declaration }) => ({
        id,
        name,
        kind,
        scope,
        scopeId,
        context,
        aliases,
        declaration,
      }));
  expect(names(result.symbols)).toEqual(names(full.symbols));
  expect(result.fileContexts).toEqual(full.fileContexts);
  expect(result.scopes).toEqual(full.scopes);
  expect(result).not.toHaveProperty("occurrencesByFile");
  expect(result).not.toHaveProperty("sources");
  const next = fast.analyze(project({ ...files, "config.bpi": "newValue = 5\n" }), signal);
  expect(fast.lastRun.parsedFiles).toEqual(["config.bpi"]);
  expect(fast.lastRun.analyzedContexts).toEqual(["main.bp"]);
  expect(Object.values(next.symbols).some((s) => s.name === "newValue")).toBe(true);
  expect(next.guardsByFile["main.bp"]?.map((r) => r.startLine)).toEqual([1, 2]);
  const broken = fast.analyze(
    project({
      ...files,
      "helper.bpm": "Function Copy(in number shared)\nvalue = shared +\nEndFunction\n",
    }),
    signal,
  );
  expect(
    Object.values(broken.symbols).some((s) => s.kind === "parameter" && s.name === "shared"),
  ).toBe(true);
});
