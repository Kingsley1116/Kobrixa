import type { editor } from "monaco-editor";
import type { EditorLocation } from "../../shared/api.js";

/** Models outlive the visible editor, preserving undo across project switches. */
export class EditorModels {
  readonly models = new Map<string, editor.ITextModel>();
  readonly views = new Map<string, editor.ICodeEditorViewState>();
  readonly locations: Record<string, EditorLocation>;
  constructor(locations: Record<string, EditorLocation> = {}) {
    this.locations = { ...locations };
  }
  capture(file: string, instance: editor.IStandaloneCodeEditor): void {
    const view = instance.saveViewState();
    if (view) this.views.set(file, view);
    const selection = instance.getSelection();
    if (selection)
      this.locations[file] = {
        line: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn,
        endLine: selection.positionLineNumber,
        endColumn: selection.positionColumn,
        scrollTop: instance.getScrollTop(),
        scrollLeft: instance.getScrollLeft(),
      };
  }
  format(file: string, before: string, after: string): void {
    const model = this.models.get(file);
    if (
      !model ||
      model.isDisposed() ||
      model.getValue(undefined, true) !== before ||
      before === after
    )
      return;
    model.pushStackElement();
    model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: after }], () => null);
    model.pushStackElement();
  }
  remap(moved: Readonly<Record<string, string>>): void {
    for (const [source, target] of Object.entries(moved)) {
      const location = this.locations[source];
      if (location) {
        this.locations[target] = location;
        delete this.locations[source];
      }
    }
  }
  dispose(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.views.clear();
  }
}
