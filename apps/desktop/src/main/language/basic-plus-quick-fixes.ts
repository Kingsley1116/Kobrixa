import type { BasicPlusQuickFix } from "@kobrixa/basic-plus";
import type { PublishedDiagnostic } from "@kobrixa/compiler";

export const BASIC_PLUS_SOURCE = "kobrixa.basic-plus";
/** Codes the Basic Plus parser can repair; other providers' codes never qualify. */
export const BASIC_PLUS_QUICK_FIX_CODES: ReadonlySet<string> = new Set([
  "BP1015",
  "BP1024",
  "BP1013",
  "BP1040",
  "BP1043",
  "BP1033",
  "BP1034",
  "BP1014",
  "BP1030",
  "BP1031",
  "BP1035",
]);
export const offersBasicPlusQuickFix = (
  diagnostic: Pick<PublishedDiagnostic, "source" | "code">,
): boolean =>
  diagnostic.source === BASIC_PLUS_SOURCE && BASIC_PLUS_QUICK_FIX_CODES.has(diagnostic.code);

const fixTitles: Record<BasicPlusQuickFix["titleKey"], { en: string; "zh-TW": string }> = {
  "insert-type-bracket": { "zh-TW": "補上型別陣列的 ]", en: "Insert ] in array type" },
  "insert-parenthesis": { "zh-TW": "補上右括號 )", en: "Insert closing parenthesis )" },
  "insert-for-equals": { "zh-TW": "補上 For 的 =", en: "Insert = in For statement" },
  "insert-for-to": { "zh-TW": "補上 For 的 To", en: "Insert To in For statement" },
  "close-blocks": { "zh-TW": "在檔尾補齊區塊結尾", en: "Close unfinished blocks at end of file" },
};
export const basicPlusFixTitle = (
  key: BasicPlusQuickFix["titleKey"],
): { en: string; "zh-TW": string } => fixTitles[key];
