import { formatBasicPlus } from "@kobrixa/basic-plus/language";
import type { LanguageCompanion } from "../../language-companion.js";
import { basicPlusSignatureHelp } from "./signatures.js";
import { basicPlusCompletions } from "./completions.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
import { legend, structuralChange } from "./structure.js";
export { legend, structuralChange } from "./structure.js";

export const basicPlusCompanion: LanguageCompanion = {
  legend,
  triggerCharacters: [".", "@"],
  signatureTriggers: ["(", ","],
  signatureRetriggers: [")"],
  completions: basicPlusCompletions,
  signatureHelp: basicPlusSignatureHelp,
  structuralChange,
  formatSource: (source, indentSize) => formatBasicPlus(source, { indentSize }),
  rangeFormatting: basicPlusRangeFormattingEdits,
};
