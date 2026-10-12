/**
 * Zero-dependency syntax highlighter for documentation code fences.
 *
 * `tokenize` is a pure function: concatenating the returned token texts always
 * reproduces the input exactly, and plain text is returned as `type: null`.
 * The Basic Plus keyword table mirrors `BASIC_PLUS_KEYWORDS` in
 * `frontends/basic-plus/src/language.ts`; the web app cannot import that package
 * without adding a workspace dependency, so the list is kept in sync by test.
 */

export type CodeTokenType =
  | "keyword"
  | "literal"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "property"
  | "variable"
  | "parameter"
  | "operator"
  | "punctuation";

export type CodeToken = { type: CodeTokenType | null; text: string };

export type CodeLanguage = "bp" | "ts" | "sh" | "json" | "powershell";

type LanguageInfo = { id: CodeLanguage | null; label: string | null };

const languageAliases: Record<string, LanguageInfo> = {
  bp: { id: "bp", label: "Basic Plus" },
  bpm: { id: "bp", label: "Basic Plus" },
  basicplus: { id: "bp", label: "Basic Plus" },
  "basic-plus": { id: "bp", label: "Basic Plus" },
  ts: { id: "ts", label: "TypeScript" },
  tsx: { id: "ts", label: "TypeScript" },
  typescript: { id: "ts", label: "TypeScript" },
  js: { id: "ts", label: "JavaScript" },
  javascript: { id: "ts", label: "JavaScript" },
  sh: { id: "sh", label: "Shell" },
  bash: { id: "sh", label: "Bash" },
  zsh: { id: "sh", label: "Zsh" },
  shell: { id: "sh", label: "Shell" },
  console: { id: "sh", label: "Shell" },
  json: { id: "json", label: "JSON" },
  jsonc: { id: "json", label: "JSON" },
  powershell: { id: "powershell", label: "PowerShell" },
  ps1: { id: "powershell", label: "PowerShell" },
  pwsh: { id: "powershell", label: "PowerShell" },
  text: { id: null, label: null },
  txt: { id: null, label: null },
  plaintext: { id: null, label: null },
};

/** Resolves a fence's `language-*` class to a highlighter and a friendly label. */
export function resolveCodeLanguage(className: string | undefined): LanguageInfo {
  const raw = /(?:^|\s)language-([\w+#-]+)/.exec(className ?? "")?.[1];
  if (!raw) return { id: null, label: null };
  return languageAliases[raw.toLowerCase()] ?? { id: null, label: raw.toUpperCase() };
}

export const BASIC_PLUS_KEYWORDS = [
  "And",
  "Break",
  "Continue",
  "Dim",
  "Else",
  "ElseIf",
  "EndFor",
  "EndFunction",
  "EndIf",
  "EndModule",
  "EndRegion",
  "EndSub",
  "EndWhile",
  "False",
  "For",
  "Folder",
  "Function",
  "Goto",
  "If",
  "Include",
  "Import",
  "In",
  "Module",
  "Not",
  "Number",
  "Or",
  "Out",
  "Private",
  "Property",
  "Region",
  "Return",
  "Step",
  "String",
  "Sub",
  "Then",
  "To",
  "True",
  "While",
] as const;

const lower = (words: readonly string[]) => new Set(words.map((word) => word.toLowerCase()));
const bpKeywords = lower(
  BASIC_PLUS_KEYWORDS.filter((word) => !/^(True|False|Number|String)$/.test(word)),
);
const bpLiterals = lower(["True", "False"]);
const bpTypes = lower(["Number", "String"]);
const bpDeclarations = lower(["Sub", "Function"]);

const tsKeywords = new Set(
  (
    "abstract as async await break case catch class const continue declare default delete do else enum " +
    "export extends finally for from function get if implements import in infer instanceof interface is " +
    "keyof let namespace new of private protected public readonly return satisfies set static switch " +
    "throw try type typeof var while with yield"
  ).split(" "),
);
const tsLiterals = new Set(["true", "false", "null", "undefined", "this"]);
const tsTypes = new Set(
  "any bigint boolean never number object string symbol unknown void".split(" "),
);
const psKeywords = lower(
  (
    "begin break catch continue do else elseif end exit filter finally for foreach function if in " +
    "param process return switch throw trap try until while"
  ).split(" "),
);

type Rule = { type: CodeTokenType | null | "word"; pattern: RegExp };
type Context = { source: string; tokens: CodeToken[]; end: number };
type Grammar = { rules: Rule[]; word: (text: string, context: Context) => CodeTokenType | null };

const sticky = (pattern: RegExp) =>
  new RegExp(pattern.source, `${pattern.flags.replace("g", "")}y`);

function nextChar(source: string, from: number): string {
  const match = /[^ \t]/.exec(source.slice(from));
  return match?.[0] ?? "";
}

/** Returns the last `count` non-whitespace tokens, most recent first. */
function significant(tokens: CodeToken[], count = 1): CodeToken[] {
  const found: CodeToken[] = [];
  for (let index = tokens.length - 1; index >= 0 && found.length < count; index -= 1) {
    const token = tokens[index]!;
    if (token.type !== null || token.text.trim()) found.push(token);
  }
  return found;
}

function previousSignificant(tokens: CodeToken[]): CodeToken | undefined {
  return significant(tokens)[0];
}

function lineHasKeyword(tokens: CodeToken[], keyword: string): boolean {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token.type === "keyword" && token.text.toLowerCase() === keyword) return true;
    if (token.text.includes("\n")) return false;
  }
  return false;
}

const bp: Grammar = {
  rules: [
    { type: "comment", pattern: /'[^\n]*/ },
    { type: "string", pattern: /"(?:[^"\n]|"")*"?/ },
    { type: "number", pattern: /(?:\d+(?:\.\d+)?|\.\d+)/ },
    { type: "word", pattern: /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/ },
    { type: "operator", pattern: /<=|>=|<>|!=|\+=|-=|\*=|\/=|\+\+|--|[+\-*/%=<>]/ },
    { type: "punctuation", pattern: /[(),:[\]@]/ },
  ],
  word(text, { source, tokens, end }) {
    const key = text.toLowerCase();
    if (bpLiterals.has(key)) return "literal";
    if (bpTypes.has(key)) return "type";
    // `Step` is only reserved inside `For … To … Step`; elsewhere it is a common variable name.
    if (key === "step") return lineHasKeyword(tokens, "to") ? "keyword" : null;
    if (bpKeywords.has(key)) return "keyword";
    const previous = previousSignificant(tokens);
    if (previous?.type === "keyword" && bpDeclarations.has(previous.text.toLowerCase()))
      return "function";
    return nextChar(source, end) === "(" ? "function" : null;
  },
};

const ts: Grammar = {
  rules: [
    { type: "comment", pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/ },
    {
      type: "string",
      pattern: /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\[\s\S]|[^`\\])*`?/,
    },
    { type: "number", pattern: /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b/ },
    { type: "word", pattern: /[A-Za-z_$][\w$]*/ },
    { type: "operator", pattern: /=>|\.\.\.|[=!]==?|[<>]=?|&&|\|\||\?\?|\?\.|[+\-*/%&|^~!?]=?|=/ },
    { type: "punctuation", pattern: /[{}()[\];,.:]/ },
  ],
  word(text, { source, tokens, end }) {
    const previous = previousSignificant(tokens);
    if (previous?.text === "." || previous?.text === "?.")
      return nextChar(source, end) === "(" ? "function" : "property";
    if (tsLiterals.has(text)) return "literal";
    if (tsKeywords.has(text)) return "keyword";
    if (tsTypes.has(text)) return "type";
    const after = nextChar(source, end);
    if (after === "(") return "function";
    if (/^[A-Z]/.test(text)) return "type";
    if (after === ":" || (after === "?" && source.slice(end).trimStart().startsWith("?:")))
      return "property";
    return null;
  },
};

const json: Grammar = {
  rules: [
    { type: "word", pattern: /"(?:\\.|[^"\\\n])*"?/ },
    { type: "number", pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ },
    { type: "word", pattern: /[A-Za-z_]\w*/ },
    { type: "punctuation", pattern: /[{}[\],:]/ },
  ],
  word(text, { source, end }) {
    if (text.startsWith('"')) return nextChar(source, end) === ":" ? "property" : "string";
    return text === "true" || text === "false" || text === "null" ? "literal" : null;
  },
};

const commandBreak = /^(?:\||\|\||&&|;|\(|&)$/;
const sh: Grammar = {
  rules: [
    { type: "comment", pattern: /(?<=^|[ \t])#[^\n]*/m },
    { type: "string", pattern: /"(?:\\.|[^"\\])*"?|'[^']*'?/ },
    { type: "variable", pattern: /\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[0-9@#?*!$-]/ },
    { type: "parameter", pattern: /(?<=^|[ \t])--?[A-Za-z][\w-]*/m },
    { type: "operator", pattern: /\|\||&&|[|;&]|[<>]{1,2}|=/ },
    { type: "word", pattern: /[^\s"'$|;&<>=()#]+/ },
    { type: "punctuation", pattern: /[()]/ },
  ],
  word(text, { source, tokens, end }) {
    const [previous, beforeValue, assigned] = significant(tokens, 3);
    const gap = tokens.at(-1)?.text ?? "";
    const lineStart = tokens.length === 0 || /\n[ \t]*$/.test(gap);
    // `NAME=value command` runs `command` with an environment override.
    const afterAssignment =
      beforeValue?.text === "=" && assigned?.type === "variable" && /[ \t]$/.test(gap);
    const atCommand = lineStart || !previous || commandBreak.test(previous.text) || afterAssignment;
    if (atCommand && source[end] === "=") return "variable";
    if (atCommand) return "function";
    return /^\d+(?:\.\d+)?$/.test(text) ? "number" : null;
  },
};

const powershell: Grammar = {
  rules: [
    { type: "comment", pattern: /<#[\s\S]*?(?:#>|$)|#[^\n]*/ },
    { type: "string", pattern: /"(?:`.|[^"`])*"?|'(?:''|[^'])*'?/ },
    { type: "variable", pattern: /\$(?:\{[^}\n]*\}?|[\w:]+)/ },
    { type: "parameter", pattern: /(?<=^|[ \t])-[A-Za-z][\w]*/m },
    { type: "number", pattern: /\b\d+(?:\.\d+)?\b/ },
    { type: "word", pattern: /[A-Za-z_][\w]*(?:-[A-Za-z][\w]*)?/ },
    { type: "operator", pattern: /[|=+*/%!<>]|-(?=\s)/ },
    { type: "punctuation", pattern: /[{}()[\];,.]/ },
  ],
  word(text) {
    if (psKeywords.has(text.toLowerCase())) return "keyword";
    if (/^[A-Za-z]+-[A-Za-z]+$/.test(text)) return "function";
    return null;
  },
};

const grammars: Record<CodeLanguage, Grammar> = { bp, ts, sh, json, powershell };
const compiled = new Map<CodeLanguage, { type: Rule["type"]; pattern: RegExp }[]>();

function rulesFor(language: CodeLanguage) {
  let rules = compiled.get(language);
  if (!rules) {
    rules = grammars[language].rules.map((rule) => ({ ...rule, pattern: sticky(rule.pattern) }));
    compiled.set(language, rules);
  }
  return rules;
}

function push(tokens: CodeToken[], type: CodeTokenType | null, text: string) {
  const last = tokens.at(-1);
  // Only plain runs merge; keeping symbols separate lets grammars inspect the previous one.
  if (last && type === null && last.type === null) last.text += text;
  else tokens.push({ type, text });
}

/** Splits Basic Plus dotted names (`Speaker.Tone`) into namespace, dot and member tokens. */
function pushBasicPlusWord(tokens: CodeToken[], text: string, type: CodeTokenType | null) {
  const dot = text.lastIndexOf(".");
  if (dot < 0 || type === "keyword" || type === "literal" || type === "type") {
    push(tokens, type, text);
    return;
  }
  push(tokens, "type", text.slice(0, dot));
  push(tokens, "punctuation", ".");
  push(tokens, type ?? "property", text.slice(dot + 1));
}

/**
 * Tokenizes `source` for `language`. Unknown or plain languages yield a single
 * uncoloured token so callers can render every fence the same way.
 */
export function tokenize(source: string, language: CodeLanguage | null): CodeToken[] {
  if (!language || !(language in grammars)) return source ? [{ type: null, text: source }] : [];
  const grammar = grammars[language];
  const rules = rulesFor(language);
  const tokens: CodeToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    let matched = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = offset;
      const match = rule.pattern.exec(source);
      if (!match || match[0].length === 0) continue;
      const text = match[0];
      const end = offset + text.length;
      if (rule.type === "word") {
        const type = grammar.word(text, { source, tokens, end });
        if (language === "bp") pushBasicPlusWord(tokens, text, type);
        else push(tokens, type, text);
      } else push(tokens, rule.type, text);
      offset = end;
      matched = true;
      break;
    }
    if (!matched) {
      push(tokens, null, source[offset]!);
      offset += 1;
    }
  }
  return tokens;
}
