import type { SourceProject, SourceRange } from "@kobrixa/compiler";
import type { PluginManifest } from "@kobrixa/plugin-protocol";
import type { LanguageBinding } from "../../../shared/language-services.js";
import type { LanguageFeatureResult } from "../../../shared/language-query.js";
import { emptyLanguageIndex, type SemanticLegend } from "../../../shared/language-types.js";
import type { LanguageServiceFactory, ProviderAnalysis } from "../language-provider.js";
export const SECOND_LEGEND: SemanticLegend = {
  tokenTypes: ["caseIdentifier"],
  tokenModifiers: ["mutable"],
};
export const SECOND_MANIFEST: PluginManifest = {
  id: "test.case",
  version: "1.0.0",
  apiVersion: "^1.3.0",
  runtime: { kind: "builtin" },
  contributes: {
    frontends: [
      {
        language: "case",
        entryExtensions: ["csx"],
        sourceExtensions: ["csx", "csi"],
        ir: { min: 1, max: 1 },
      },
    ],
    languageServices: [
      {
        language: "case",
        extensions: ["csx", "csi"],
        capabilities: [
          "analysis",
          "completion",
          "quickFixes",
          "semanticTokens",
          "hover",
          "definition",
          "references",
          "documentSymbols",
        ],
      },
    ],
  },
};
export function secondBinding(epoch: number): LanguageBinding {
  const declaration = SECOND_MANIFEST.contributes!.languageServices![0]!;
  return {
    epoch,
    pluginId: SECOND_MANIFEST.id,
    sourceKey: "builtin:test.case",
    language: "case",
    extensions: [...declaration.extensions],
    capabilities: [...declaration.capabilities],
    frontend: structuredClone(SECOND_MANIFEST.contributes!.frontends![0]!),
  };
}
function analyze(project: SourceProject): ProviderAnalysis {
  const result: ProviderAnalysis = {
    diagnostics: [],
    index: emptyLanguageIndex(),
    tokensByFile: {},
  };
  for (const source of project.sources) {
    result.index.sources[source.path] = source.content;
    result.index.fileContexts[source.path] = source.path;
    result.index.contextFiles[source.path] = [source.path];
    result.tokensByFile[source.path] = [];
    result.index.occurrencesByFile[source.path] = [];
    source.content.split("\n").forEach((line, offset) => {
      const range = (start: number, length: number): SourceRange => ({
        startLine: offset + 1,
        endLine: offset + 1,
        startColumn: start + 1,
        endColumn: start + length + 1,
      });
      for (const match of line.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
        const name = match[0],
          id = `${source.path}:${name}`,
          at = range(match.index, name.length);
        const declaration = !Object.hasOwn(result.index.symbols, id);
        result.index.symbols[id] ??= {
          id,
          name,
          kind: "variable",
          signature: `case ${name}`,
          group: source.path,
          shadowKey: name,
          labels: [{ text: name, detail: `case ${name}` }],
          location: { file: source.path, range: at },
        };
        result.tokensByFile[source.path]!.push({
          range: at,
          type: "caseIdentifier",
          modifiers: ["mutable"],
        });
        result.index.occurrencesByFile[source.path]!.push({
          file: source.path,
          range: at,
          symbolId: id,
          context: source.path,
          declaration,
        });
      }
      const bang = line.indexOf("!");
      if (bang >= 0)
        result.diagnostics.push({
          code: "BP1043",
          severity: "error",
          file: source.path,
          message: "Exclamation marks are forbidden in Case.",
          range: range(bang, 1),
        });
    });
  }
  return result;
}
export const secondLanguageService: LanguageServiceFactory = {
  capabilities: SECOND_MANIFEST.contributes!.languageServices![0]!.capabilities,
  createAnalysis() {
    const history = new Map<number, ProviderAnalysis>();
    const get = (version: number) => {
      const result = history.get(version);
      if (!result) throw new Error("Analysis expired.");
      return result;
    };
    return {
      analyze(project, version, signal) {
        signal.throwIfAborted();
        const result = analyze(project);
        history.set(version, result);
        while (history.size > 2) history.delete(history.keys().next().value!);
        return result;
      },
      query(version, query, signal): LanguageFeatureResult {
        signal.throwIfAborted();
        const result = get(version);
        const occurrence =
          "line" in query
            ? result.index.occurrencesByFile[query.file]?.find(
                (o) =>
                  o.range.startLine === query.line &&
                  o.range.startColumn <= query.column &&
                  query.column < o.range.endColumn,
              )
            : undefined;
        const symbol = occurrence && result.index.symbols[occurrence.symbolId];
        switch (query.kind) {
          case "hover":
            return {
              kind: query.kind,
              value:
                symbol && occurrence
                  ? { range: occurrence.range, contents: [symbol.signature] }
                  : null,
            };
          case "definition":
            return { kind: query.kind, locations: symbol?.location ? [symbol.location] : [] };
          case "references":
            return {
              kind: query.kind,
              locations: Object.values(result.index.occurrencesByFile)
                .flat()
                .filter(
                  (o) => o.symbolId === symbol?.id && (query.includeDeclaration || !o.declaration),
                ),
            };
          case "documentSymbols":
            return {
              kind: query.kind,
              symbols: Object.values(result.index.symbols)
                .filter((s) => s.location?.file === query.file)
                .map((s) => ({
                  name: s.name,
                  detail: s.signature,
                  kind: s.kind,
                  range: s.location!.range,
                  selectionRange: s.location!.range,
                  children: [],
                })),
            };
          case "signatureHelp":
            return { kind: query.kind, value: null };
          case "renameLocation":
            return {
              kind: query.kind,
              text: "",
              rejectReason: "Case fixture does not support rename.",
            };
          case "rename":
            return {
              kind: query.kind,
              edits: [],
              rejectReason: "Case fixture does not support rename.",
            };
        }
      },
      quickFixes(version, file, diagnostic, signal) {
        signal.throwIfAborted();
        get(version);
        if (diagnostic.code !== "BP1043" || diagnostic.file !== file) return [];
        return [
          {
            id: "case.remove-bang",
            title: { en: "Remove !", "zh-TW": "移除 !" },
            edits: [{ range: diagnostic.range, newText: "" }],
          },
        ];
      },
      dispose() {
        history.clear();
      },
    };
  },
  createCompletion() {
    return {
      analyze(project, signal) {
        signal.throwIfAborted();
        const { index } = analyze(project);
        return {
          symbols: index.symbols,
          scopes: index.scopes,
          fileContexts: index.fileContexts,
          contextFiles: index.contextFiles,
          guardsByFile: {},
        };
      },
      dispose() {},
    };
  },
};
