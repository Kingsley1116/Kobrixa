import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASIC_PLUS_KEYWORDS,
  resolveCodeLanguage,
  tokenize,
  type CodeLanguage,
  type CodeToken,
  type CodeTokenType,
} from "./code-highlight.js";

const typed = (tokens: CodeToken[], type: CodeTokenType) =>
  tokens.filter((token) => token.type === type).map((token) => token.text);

const join = (tokens: CodeToken[]) => tokens.map((token) => token.text).join("");

describe("resolveCodeLanguage", () => {
  it("maps fence classes to highlighters and friendly labels", () => {
    expect(resolveCodeLanguage("language-bp")).toEqual({ id: "bp", label: "Basic Plus" });
    expect(resolveCodeLanguage("language-ts")).toEqual({ id: "ts", label: "TypeScript" });
    expect(resolveCodeLanguage("language-sh")).toEqual({ id: "sh", label: "Shell" });
    expect(resolveCodeLanguage("language-json")).toEqual({ id: "json", label: "JSON" });
    expect(resolveCodeLanguage("language-PowerShell")).toEqual({
      id: "powershell",
      label: "PowerShell",
    });
  });

  it("leaves plain text and missing languages unlabelled and uncoloured", () => {
    expect(resolveCodeLanguage("language-text")).toEqual({ id: null, label: null });
    expect(resolveCodeLanguage(undefined)).toEqual({ id: null, label: null });
    expect(resolveCodeLanguage("language-rust")).toEqual({ id: null, label: "RUST" });
  });
});

describe("tokenize", () => {
  it("returns a single plain token without a language", () => {
    const diagram = "Monaco ── renderer\n   │\n   ▼ main";
    expect(tokenize(diagram, null)).toEqual([{ type: null, text: diagram }]);
    expect(tokenize("", null)).toEqual([]);
  });

  it("highlights Basic Plus keywords, calls, literals and comments", () => {
    const source = [
      "Sub BeepSuccess()",
      "  For step = 1 To 4 Step 2",
      '    If step >= 3 Then Speaker.Tone(25, 660, 90) \' high "note"',
      "  endfor",
      'Motor.Move("AD", 35, 360, "True")',
      "Number[] readings",
      "Thread.Run = Blink",
      "done = True",
      "EndSub",
    ].join("\n");
    const tokens = tokenize(source, "bp");
    expect(typed(tokens, "keyword")).toEqual([
      "Sub",
      "For",
      "To",
      "Step",
      "If",
      "Then",
      "endfor",
      "EndSub",
    ]);
    expect(typed(tokens, "function")).toEqual(["BeepSuccess", "Tone", "Move"]);
    expect(typed(tokens, "type")).toEqual(["Speaker", "Motor", "Number", "Thread"]);
    expect(typed(tokens, "property")).toEqual(["Run"]);
    expect(typed(tokens, "string")).toEqual(['"AD"', '"True"']);
    expect(typed(tokens, "literal")).toEqual(["True"]);
    expect(typed(tokens, "comment")).toEqual(['\' high "note"']);
    expect(typed(tokens, "number")).toEqual(["1", "4", "2", "3", "25", "660", "90", "35", "360"]);
    expect(join(tokens)).toBe(source);
  });

  it("supports doubled quotes inside Basic Plus strings", () => {
    expect(tokenize('x = "say ""hi"""', "bp").at(-1)).toEqual({
      type: "string",
      text: '"say ""hi"""',
    });
  });

  it("keeps the keyword table in sync with the Basic Plus language package", () => {
    const language = readFileSync(
      new URL("../../../../../frontends/basic-plus/src/language.ts", import.meta.url),
      "utf8",
    );
    const table = /BASIC_PLUS_KEYWORDS = \[([\s\S]*?)\] as const/.exec(language)?.[1] ?? "";
    const upstream = [...table.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(upstream.length).toBeGreaterThan(0);
    expect([...BASIC_PLUS_KEYWORDS]).toEqual(upstream);
  });

  it("highlights TypeScript declarations", () => {
    const source = [
      "interface DeviceSession {",
      "  readonly descriptor: DeviceDescriptor;",
      "  compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult>;",
      '  kind: "rbf" | "ir"; // artifact',
      "  remotePath?: string;",
      "}",
    ].join("\n");
    const tokens = tokenize(source, "ts");
    expect(typed(tokens, "keyword")).toEqual(["interface", "readonly"]);
    expect(typed(tokens, "type")).toEqual([
      "DeviceSession",
      "DeviceDescriptor",
      "SourceProject",
      "AbortSignal",
      "Promise",
      "FrontendResult",
      "string",
    ]);
    expect(typed(tokens, "function")).toEqual(["compile"]);
    expect(typed(tokens, "property")).toEqual([
      "descriptor",
      "input",
      "signal",
      "kind",
      "remotePath",
    ]);
    expect(typed(tokens, "string")).toEqual(['"rbf"', '"ir"']);
    expect(typed(tokens, "comment")).toEqual(["// artifact"]);
    expect(join(tokens)).toBe(source);
  });

  it("colours TypeScript members after calls and index access", () => {
    const tokens = tokenize("foo().length + arr[0].name + obj.run()", "ts");
    expect(typed(tokens, "property")).toEqual(["length", "name"]);
    expect(typed(tokens, "function")).toEqual(["foo", "run"]);
  });

  it("separates JSON keys from values", () => {
    const source = '{\n  "schemaVersion": 1,\n  "assets": ["assets/**/*"],\n  "ok": true\n}';
    const tokens = tokenize(source, "json");
    expect(typed(tokens, "property")).toEqual(['"schemaVersion"', '"assets"', '"ok"']);
    expect(typed(tokens, "string")).toEqual(['"assets/**/*"']);
    expect(typed(tokens, "number")).toEqual(["1"]);
    expect(typed(tokens, "literal")).toEqual(["true"]);
    expect(join(tokens)).toBe(source);
  });

  it("finds shell commands, flags, variables and comments", () => {
    const source = [
      "cp apps/collab/.dev.vars.example apps/collab/.dev.vars   # then set COLLAB_SECRET",
      "KOBRIXA_COLLAB_URL=http://localhost:8787 pnpm dev",
      "grep -F '  Kobrixa-<version>-darwin-arm64.dmg' SHA256SUMS.txt | shasum -a 256 -c -",
      'echo "$HOME" && sha256sum --ignore-missing -c SHA256SUMS.txt',
    ].join("\n");
    const tokens = tokenize(source, "sh");
    expect(typed(tokens, "function")).toEqual([
      "cp",
      "pnpm",
      "grep",
      "shasum",
      "echo",
      "sha256sum",
    ]);
    expect(typed(tokens, "parameter")).toEqual(["-F", "-a", "-c", "--ignore-missing", "-c"]);
    expect(typed(tokens, "variable")).toEqual(["KOBRIXA_COLLAB_URL"]);
    expect(typed(tokens, "comment")).toEqual(["# then set COLLAB_SECRET"]);
    expect(typed(tokens, "string")).toEqual(["'  Kobrixa-<version>-darwin-arm64.dmg'", '"$HOME"']);
    expect(typed(tokens, "number")).toEqual(["256"]);
    expect(join(tokens)).toBe(source);
  });

  it("finds PowerShell cmdlets and parameters", () => {
    const source =
      "Get-FileHash -Algorithm SHA256 'Kobrixa-<version>-win32-x64-setup.exe'\n" +
      "foreach ($line in $lines) { Write-Output $line } # done";
    const tokens = tokenize(source, "powershell");
    expect(typed(tokens, "function")).toEqual(["Get-FileHash", "Write-Output"]);
    expect(typed(tokens, "parameter")).toEqual(["-Algorithm"]);
    expect(typed(tokens, "keyword")).toEqual(["foreach", "in"]);
    expect(typed(tokens, "variable")).toEqual(["$line", "$lines", "$line"]);
    expect(typed(tokens, "string")).toEqual(["'Kobrixa-<version>-win32-x64-setup.exe'"]);
    expect(typed(tokens, "comment")).toEqual(["# done"]);
    expect(join(tokens)).toBe(source);
  });

  it("round-trips arbitrary input for every language and merges plain runs", () => {
    const samples = ["", "@@ ~~  é 中文 ``` \t\n\r\n", 'unterminated "string\n/* open', "$"];
    const languages: CodeLanguage[] = ["bp", "ts", "sh", "json", "powershell"];
    for (const language of languages)
      for (const sample of samples) {
        const tokens = tokenize(sample, language);
        expect(join(tokens)).toBe(sample);
        for (let index = 1; index < tokens.length; index += 1)
          expect(tokens[index]!.type === null && tokens[index - 1]!.type === null).toBe(false);
      }
  });
});
