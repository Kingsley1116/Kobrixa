import type { PanelResourceV1, StatusResourceV1 } from "./ui-resource.js";
import type { ContextCommandDeclaration, PanelDeclaration, Result } from "./ui-types.js";
export type UiValidationContext = {
  pluginId: string; commands: readonly ContextCommandDeclaration[]; panels: readonly PanelDeclaration[];
};
export declare function validateUiResource(value: unknown, context: UiValidationContext,
  rawBytes: number): Result<PanelResourceV1 | StatusResourceV1>;
