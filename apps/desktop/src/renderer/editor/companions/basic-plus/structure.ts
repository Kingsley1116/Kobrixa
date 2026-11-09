import type { editor } from "monaco-editor";
import type { SemanticLegend } from "../../../../shared/language-types.js";

export const legend: SemanticLegend = {
  tokenTypes: ["namespace", "function", "method", "variable", "parameter", "label"],
  tokenModifiers: ["declaration", "defaultLibrary", "local", "global"],
};

const structuralText = /\b(?:function|sub|endfunction|endsub|include|import)\b/i;
/** Inspect only the two edited boundary lines, including a keyword typed one letter at a time. */
export function structuralChange(
  model: editor.ITextModel,
  event: editor.IModelContentChangedEvent,
): boolean {
  let delta = 0;
  for (const change of [...event.changes].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
    if (structuralText.test(change.text)) return true;
    const start = change.rangeOffset + delta;
    for (const offset of [start, start + change.text.length]) {
      if (structuralText.test(model.getLineContent(model.getPositionAt(offset).lineNumber)))
        return true;
    }
    delta += change.text.length - change.rangeLength;
  }
  return false;
}
