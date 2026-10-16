import {
  BasicPlusProjectAnalyzer,
  BasicPlusCompletionAnalyzer,
  getBasicPlusQuickFixes,
  type BasicPlusProjectAnalysis,
} from "@kobrixa/basic-plus";
import {
  occurrenceAt,
  prepareSymbolRename,
  symbolReferences,
  symbolSignature,
  visibleSymbols,
  editingContext,
} from "@kobrixa/basic-plus/intelligence";
import { BASIC_PLUS_API_COMPLETIONS } from "@kobrixa/basic-plus/language";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import type { LanguageServiceFactory } from "./language-provider.js";
import type { LanguageFeatureQuery, LanguageFeatureResult } from "../../shared/language-query.js";
import { basicPlusAnalysis, basicPlusCompletion } from "./basic-plus-results.js";
import { basicPlusFixTitle, offersBasicPlusQuickFix } from "./basic-plus-quick-fixes.js";
import { basicPlusOutline } from "./basic-plus-outline.js";

function queryBasicPlus(
  raw: BasicPlusProjectAnalysis,
  query: LanguageFeatureQuery,
): LanguageFeatureResult {
  const source = raw.index.sources[query.file] ?? "";
  if (query.kind === "documentSymbols")
    return { kind: query.kind, symbols: basicPlusOutline(raw.index, query.file) };
  const occurrence = occurrenceAt(raw.index, query.file, query.line, query.column);
  const symbol = occurrence && raw.index.symbols[occurrence.symbolId];
  switch (query.kind) {
    case "hover":
      return {
        kind: query.kind,
        value:
          symbol && occurrence
            ? {
                range: occurrence.range,
                contents: [
                  `\`\`\`basic-plus\n${symbolSignature(symbol)}\n\`\`\``,
                  ...(symbol.documentation ? [symbol.documentation] : []),
                ],
              }
            : null,
      };
    case "definition":
      return { kind: query.kind, locations: symbol?.declaration ? [symbol.declaration] : [] };
    case "references":
      return {
        kind: query.kind,
        locations: symbol ? symbolReferences(raw.index, symbol, query.includeDeclaration) : [],
      };
    case "renameLocation":
      return symbol?.declaration && occurrence
        ? {
            kind: query.kind,
            range: occurrence.range,
            text: source
              .split("\n")
              [query.line - 1]!.slice(
                occurrence.range.startColumn - 1,
                occurrence.range.endColumn - 1,
              ),
          }
        : {
            kind: query.kind,
            text: "",
            rejectReason: "A current, editable user-defined symbol is required.",
          };
    case "rename": {
      const result = prepareSymbolRename(raw, query.file, query.line, query.column, query.newName);
      return result.rejectReason
        ? { kind: query.kind, edits: [], rejectReason: result.rejectReason }
        : { kind: query.kind, edits: result.edits ?? [] };
    }
    case "signatureHelp": {
      const call = editingContext(
        (source.split("\n")[query.line - 1] ?? "").slice(0, query.column - 1),
      ).call;
      if (!call) return { kind: query.kind, value: null };
      const callable = visibleSymbols(raw.index, query.file, query.line, query.column).find(
        (s) => s.parameters && s.aliases.some((a) => a.toLowerCase() === call.name.toLowerCase()),
      );
      const api = BASIC_PLUS_API_COMPLETIONS.find(
        (a) => a.label.toLowerCase() === call.name.toLowerCase(),
      );
      if (!callable && !api) return { kind: query.kind, value: null };
      const label = api?.signature ?? symbolSignature(callable!, call.name);
      const texts = api
        ? label
            .slice(label.indexOf("(") + 1, label.lastIndexOf(")"))
            .split(", ")
            .filter(Boolean)
        : callable!.parameters!.map((p) => `${p.direction} ${p.type} ${p.name}`);
      let start = label.indexOf("(") + 1;
      const parameters = texts.map((text): [number, number] => {
        const range: [number, number] = [start, start + text.length];
        start += text.length + 2;
        return range;
      });
      return {
        kind: query.kind,
        value: {
          label,
          parameters,
          activeParameter: Math.min(call.argument, Math.max(0, parameters.length - 1)),
          ...(api ? { documentation: api.documentation } : {}),
        },
      };
    }
  }
}
export const basicPlusLanguageService: LanguageServiceFactory = {
  capabilities: LANGUAGE_CAPABILITIES,
  createAnalysis() {
    const analyzer = new BasicPlusProjectAnalyzer();
    const history = new Map<number, BasicPlusProjectAnalysis>();
    const get = (version: number) => {
      const raw = history.get(version);
      if (!raw) throw new Error("Analysis expired.");
      return raw;
    };
    return {
      analyze(project, version, signal) {
        const raw = analyzer.analyze(project, signal);
        history.set(version, raw);
        while (history.size > 2) history.delete(history.keys().next().value!);
        return basicPlusAnalysis(raw);
      },
      query(version, query, signal) {
        signal.throwIfAborted();
        const result = queryBasicPlus(get(version), query);
        signal.throwIfAborted();
        return result;
      },
      quickFixes(version, file, diagnostic, signal) {
        if (!offersBasicPlusQuickFix(diagnostic)) return [];
        const source = get(version).index.sources[file];
        if (source === undefined) return [];
        return getBasicPlusQuickFixes(file, source, diagnostic, signal).map(
          ({ id, titleKey, edits }) => ({ id, title: basicPlusFixTitle(titleKey), edits }),
        );
      },
      dispose() {
        history.clear();
      },
    };
  },
  createCompletion() {
    let analyzer: BasicPlusCompletionAnalyzer | undefined = new BasicPlusCompletionAnalyzer();
    return {
      analyze(project, signal) {
        if (!analyzer) throw new Error("Completion session disposed.");
        return basicPlusCompletion(analyzer.analyze(project, signal));
      },
      dispose() {
        analyzer = undefined;
      },
    };
  },
};
