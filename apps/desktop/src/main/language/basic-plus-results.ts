import type {
  BasicPlusCompletionIndex,
  BasicPlusProjectAnalysis,
  BasicPlusSymbol,
} from "@kobrixa/basic-plus";
import { symbolSignature } from "@kobrixa/basic-plus/intelligence";
import type { CompletionIndex, LanguageSymbol } from "../../shared/language-types.js";
import type { ProviderAnalysis } from "./language-provider.js";
export function basicPlusSymbol(symbol: BasicPlusSymbol): LanguageSymbol {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind === "sub" ? "function" : symbol.kind,
    signature: symbolSignature(symbol),
    ...(symbol.documentation === undefined ? {} : { documentation: symbol.documentation }),
    ...(symbol.declaration ? { location: symbol.declaration } : {}),
    labels: symbol.aliases.map((text) => ({ text, detail: symbolSignature(symbol, text) })),
    group: symbol.scope === "global" ? symbol.context : symbol.scopeId,
    shadowKey: `${symbol.kind === "function" || symbol.kind === "sub" ? "call" : symbol.kind === "label" ? "label" : "value"}:${symbol.name.toLowerCase()}`,
  };
}
function symbols(input: Record<string, BasicPlusSymbol>): Record<string, LanguageSymbol> {
  return Object.fromEntries(
    Object.values(input)
      .filter((s) => s.scope !== "builtin")
      .map((s) => [s.id, basicPlusSymbol(s)]),
  );
}
export function basicPlusAnalysis(raw: BasicPlusProjectAnalysis): ProviderAnalysis {
  return {
    diagnostics: raw.diagnostics,
    tokensByFile: raw.tokensByFile,
    index: { ...raw.index, symbols: symbols(raw.index.symbols) },
  };
}
export function basicPlusCompletion(raw: BasicPlusCompletionIndex): CompletionIndex {
  return { ...raw, symbols: symbols(raw.symbols) };
}
