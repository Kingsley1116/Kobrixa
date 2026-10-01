import type { editor } from "monaco-editor";
import type { EditorAnalysis } from "./editor.js";

/** Text is trusted only when supplied while creating/reconciling a model, or by
 * a document-version-checked analysis result. Queries need no full-buffer reads. */
export class ModelSnapshots {
  private readonly models = new Map<
    editor.ITextModel,
    { file: string; version: number; source: string; snapshot?: EditorAnalysis }
  >();
  bind(model: editor.ITextModel, file: string, source: string): void {
    this.models.set(model, { file, source, version: model.getVersionId() });
  }
  remap(model: editor.ITextModel, file: string): void {
    const previous = this.models.get(model);
    if (previous)
      this.models.set(model, { file, source: previous.source, version: previous.version });
  }
  unbind(model: editor.ITextModel): void {
    this.models.delete(model);
  }
  source(model: editor.ITextModel): string | undefined {
    const entry = this.models.get(model);
    return entry?.version === model.getVersionId() ? entry.source : undefined;
  }
  accept(model: editor.ITextModel, snapshot: EditorAnalysis): void {
    const entry = this.models.get(model);
    if (!entry) return;
    const source = snapshot.analysis.index.sources[entry.file];
    if (source === undefined) return;
    this.models.set(model, { file: entry.file, source, version: model.getVersionId(), snapshot });
  }
  isCurrent(model: editor.ITextModel, file: string, snapshot: EditorAnalysis): boolean {
    const entry = this.models.get(model);
    return (
      entry?.file === file && entry.snapshot === snapshot && entry.version === model.getVersionId()
    );
  }
  versions(snapshot: EditorAnalysis): ReadonlyMap<editor.ITextModel, number> {
    return new Map(
      [...this.models]
        .filter(([, entry]) => entry.snapshot === snapshot)
        .map(([model, entry]) => [model, entry.version]),
    );
  }
}
