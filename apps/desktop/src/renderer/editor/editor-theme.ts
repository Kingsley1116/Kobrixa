import type { editor } from "monaco-editor";

export interface EditorThemeApi {
  defineTheme(name: string, data: editor.IStandaloneThemeData): void;
}
/** T6 defines kobrixa-light and kobrixa-dark independently of grammar availability. */
export function initializeEditorThemes(api: EditorThemeApi): void {
  void api;
}
