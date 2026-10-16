import { editingContext } from "@kobrixa/basic-plus/intelligence";
import { BASIC_PLUS_API_COMPLETIONS } from "@kobrixa/basic-plus/language";
import type { LanguageCompanion } from "../../language-companion.js";

/** Built-in API signatures remain available before the next analysis is accepted. */
export const basicPlusSignatureHelp: NonNullable<LanguageCompanion["signatureHelp"]> = (
  model,
  position,
  token,
) => {
  if (model.isDisposed() || token.isCancellationRequested) return;
  const call = editingContext(
    model.getLineContent(position.lineNumber).slice(0, position.column - 1),
  ).call;
  if (!call) return;
  const api = BASIC_PLUS_API_COMPLETIONS.find(
    (entry) => entry.label.toLowerCase() === call.name.toLowerCase(),
  );
  if (!api) return;
  const label = api.signature;
  const texts = label
    .slice(label.indexOf("(") + 1, label.lastIndexOf(")"))
    .split(", ")
    .filter(Boolean);
  let start = label.indexOf("(") + 1;
  const parameters = texts.map((text): [number, number] => {
    const range: [number, number] = [start, start + text.length];
    start += text.length + 2;
    return range;
  });
  return {
    label,
    parameters,
    activeParameter: Math.min(call.argument, Math.max(0, parameters.length - 1)),
    documentation: api.documentation,
  };
};
