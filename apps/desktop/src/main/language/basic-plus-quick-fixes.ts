import type { BasicPlusQuickFix } from "@kobrixa/basic-plus";

// Task 6 moves these shared helpers here after the remaining renderer callers migrate.
export { BASIC_PLUS_SOURCE, offersBasicPlusQuickFix } from "../../shared/basic-plus-quick-fixes.js";

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
