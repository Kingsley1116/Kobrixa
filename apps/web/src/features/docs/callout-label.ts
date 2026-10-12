export type CalloutVariant = "note" | "warning" | "safety" | "tip";

/**
 * Leading bold labels that turn a Markdown blockquote into a callout.
 * Keys are compared after trimming, lower-casing and dropping trailing punctuation.
 */
const labels: Record<string, CalloutVariant> = {
  note: "note",
  notes: "note",
  info: "note",
  "version note": "note",
  "version notes": "note",
  注意: "note",
  說明: "note",
  備註: "note",
  版本說明: "note",
  warning: "warning",
  caution: "warning",
  important: "warning",
  警告: "warning",
  小心: "warning",
  重要: "warning",
  safety: "safety",
  "safety note": "safety",
  "safety reminder": "safety",
  安全: "safety",
  安全提醒: "safety",
  安全須知: "safety",
  tip: "tip",
  tips: "tip",
  hint: "tip",
  提示: "tip",
  小提示: "tip",
  技巧: "tip",
};

/** Returns the callout variant for a blockquote's leading bold label, or null for a plain quote. */
export function calloutVariantFor(label: string): CalloutVariant | null {
  const key = label
    .trim()
    .replace(/[\s.:!。：！．]+$/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return Object.hasOwn(labels, key) ? (labels[key] ?? null) : null;
}
