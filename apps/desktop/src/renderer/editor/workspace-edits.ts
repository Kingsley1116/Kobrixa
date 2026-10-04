import type { editor, languages } from "monaco-editor";
import type { EditorAnalysis } from "./editor.js";

export interface WorkspaceEditContext {
  snapshot: EditorAnalysis;
  kind: "rename" | "quick-fix";
  files?: string[];
  summary?: string;
}
const snapshots = new WeakMap<languages.WorkspaceEdit, WorkspaceEditContext>();
export function rememberRename(edit: languages.WorkspaceEdit, snapshot: EditorAnalysis): void {
  snapshots.set(edit, { snapshot, kind: "rename" });
}
export function renameSnapshot(edit: languages.WorkspaceEdit): EditorAnalysis | undefined {
  return snapshots.get(edit)?.snapshot;
}
export function rememberQuickFix(
  edit: languages.WorkspaceEdit,
  snapshot: EditorAnalysis,
  file: string,
  summary: string,
): void {
  snapshots.set(edit, { snapshot, kind: "quick-fix", files: [file], summary });
}
export function workspaceEditContext(
  edit: languages.WorkspaceEdit,
): WorkspaceEditContext | undefined {
  return snapshots.get(edit);
}

type Apply = (
  edit: languages.WorkspaceEdit,
) => Promise<{ isApplied: boolean; ariaSummary: string }>;
let current: Apply | undefined;

// Standalone Monaco services survive editor/workspace remounts. Keep the service
// stable, but bind its handler only to the currently mounted workspace.
export const workspaceEditService = {
  hasPreviewHandler: () => false,
  apply: (edit: languages.WorkspaceEdit) => {
    if (!current) return Promise.reject(new Error("No editable workspace is open."));
    return current(edit);
  },
};
export function bindWorkspaceEdits(apply: Apply): () => void {
  current = apply;
  return () => {
    if (current === apply) current = undefined;
  };
}

export function validateTextEdits(
  edit: languages.WorkspaceEdit,
  findModel: (resource: string) => editor.ITextModel | undefined,
): Map<editor.ITextModel, editor.IIdentifiedSingleEditOperation[]> {
  const groups = new Map<editor.ITextModel, editor.IIdentifiedSingleEditOperation[]>();
  for (const item of edit.edits) {
    if (!("textEdit" in item) || item.textEdit.insertAsSnippet)
      throw new Error("Unsupported workspace edit.");
    const model = findModel(item.resource.toString());
    if (!model || model.isDisposed() || item.versionId !== model.getVersionId())
      throw new Error("A document changed while preparing the edit. Try again.");
    const range = item.textEdit.range;
    const valid = model.validateRange(range);
    if (
      valid.startLineNumber !== range.startLineNumber ||
      valid.startColumn !== range.startColumn ||
      valid.endLineNumber !== range.endLineNumber ||
      valid.endColumn !== range.endColumn
    )
      throw new Error("The edit contains an invalid source range.");
    const edits = groups.get(model) ?? [];
    edits.push({ range, text: item.textEdit.text });
    groups.set(model, edits);
  }
  for (const edits of groups.values()) {
    edits.sort(
      (a, b) =>
        a.range.startLineNumber - b.range.startLineNumber ||
        a.range.startColumn - b.range.startColumn,
    );
    for (let i = 1; i < edits.length; i++) {
      const previous = edits[i - 1]!.range,
        next = edits[i]!.range;
      if (
        previous.endLineNumber > next.startLineNumber ||
        (previous.endLineNumber === next.startLineNumber && previous.endColumn > next.startColumn)
      )
        throw new Error("The edit contains overlapping edits.");
    }
  }
  return groups;
}
