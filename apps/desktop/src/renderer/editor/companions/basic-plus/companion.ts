import { formatBasicPlus } from "@kobrixa/basic-plus/language";
import type { LanguageCompanion } from "../../language-companion.js";
import { basicPlusCompletions } from "./completions.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
import { legend, structuralChange } from "./structure.js";
export { legend, structuralChange } from "./structure.js";
export const basicPlusCompanion: LanguageCompanion = {
  monacoLanguage: "basic-plus",
  legend,
  triggerCharacters: [".", "@"],
  signatureTriggers: ["(", ","],
  signatureRetriggers: [")"],
  completions: basicPlusCompletions,
  structuralChange,
  formatSource: (source, indentSize) => formatBasicPlus(source, { indentSize }),
  rangeFormatting: basicPlusRangeFormattingEdits,
};
