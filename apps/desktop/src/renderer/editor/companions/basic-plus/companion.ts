import { formatBasicPlus } from "@kobrixa/basic-plus/language";
import type { LanguageCompanion } from "../../language-companion.js";
import { basicPlusSignatureHelp } from "./signatures.js";
import { basicPlusCompletions } from "./completions.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
import { legend, structuralChange } from "./structure.js";
export { legend, structuralChange } from "./structure.js";

// Compiles locally against both T0's old interface and T5's field-free interface.
// No lexical field or cast is added to the runtime companion object.
type BasicPlusDynamicCompanion = Omit<LanguageCompanion, "monacoLanguage">;
export const basicPlusCompanion: BasicPlusDynamicCompanion = {
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
