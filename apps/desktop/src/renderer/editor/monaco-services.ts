// Load Monaco's contributions before its one-time service initialization.
import "monaco-editor";
// @ts-expect-error Monaco 0.52.2 service initialization has no public type declaration.
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
// @ts-expect-error Monaco 0.52.2 hover factory has no public type declaration.
import { setHoverDelegateFactory } from "monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js";
// @ts-expect-error Monaco 0.52.2 hover delegate has no public type declaration.
import { WorkbenchHoverDelegate } from "monaco-editor/esm/vs/platform/hover/browser/hover.js";
import { workspaceEditService } from "./workspace-edits.js";

/** Call before rendering: welcome-page keyboard bindings also initialize Monaco. */
export function initializeEditorServices(): void {
  StandaloneServices.initialize({ IWorkspaceEditService: workspaceEditService });
}

/**
 * Monaco 0.52.2 installs a global hover factory from each diff subeditor's
 * disposable service scope. Keep later Find/Replace widgets on the root scope.
 */
export function restoreEditorHoverDelegate(): void {
  const root = StandaloneServices.initialize({ IWorkspaceEditService: workspaceEditService });
  setHoverDelegateFactory((placement: "mouse" | "element", instant: boolean) =>
    root.createInstance(WorkbenchHoverDelegate, placement, instant, {}),
  );
}
