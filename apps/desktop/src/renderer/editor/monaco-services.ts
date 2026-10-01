// Load Monaco's contributions before its one-time service initialization.
import "monaco-editor";
// @ts-expect-error Monaco 0.52.2 service initialization has no public type declaration.
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { workspaceEditService } from "./workspace-edits.js";

/** Call before rendering: welcome-page keyboard bindings also initialize Monaco. */
export function initializeEditorServices(): void {
  StandaloneServices.initialize({ IWorkspaceEditService: workspaceEditService });
}
