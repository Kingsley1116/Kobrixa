import type { UiBinding } from "@kobrixa/plugin-protocol";
import type { PluginUiBridge } from "@kobrixa/plugin-runtime";
import type { CoreRecoveryPort } from "@kobrixa/plugin-runtime";
import type {
  SettingsSnapshot, Values, SettingKey, SettingsText, SettingsResourceV1, SettingsScalar,
} from "@kobrixa/plugin-protocol";
import type { SettingsFormBinding } from "@kobrixa/plugin-runtime";
export interface PluginUiRendererHost {
  start(): Promise<void>;
  setVisibility(
    binding: UiBinding,
    visible: boolean,
    reason: Parameters<PluginUiBridge["visibility"]>[0]["reason"],
  ): Promise<void>;
  dispose(): void;
}
export function createPluginUiRendererHost(input: {
  bridge: PluginUiBridge;
  recovery: CoreRecoveryPort;
}): PluginUiRendererHost {
  void input;
  return {
    start: () => Promise.reject(new Error("UI renderer unavailable before 3B1-T7")),
    setVisibility: () => Promise.reject(new Error("UI renderer unavailable before 3B1-T7")),
    dispose() {},
  };
}
export type SettingsDraftState = {
  baseline: SettingsSnapshot;
  draft: Values;
  busyKeys: SettingKey[];
  errors: Array<{ key: SettingKey; message: SettingsText }>;
};
// SettingsControlsPort/SettingsDraftState: B1-T7 host-ports.ts; B2-T3 consumes.
export interface SettingsControlsPort {
  render(
    binding: SettingsFormBinding,
    resource: SettingsResourceV1,
    state: SettingsDraftState,
  ): void;
  onChange(
    listener: (
      binding: SettingsFormBinding,
      key: SettingKey,
      value: SettingsScalar,
      phase: "change" | "blur" | "enter" | "reset",
    ) => void,
  ): () => void;
  dispose(binding: SettingsFormBinding): void;
}
