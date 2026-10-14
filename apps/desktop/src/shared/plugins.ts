import type {
  PluginActionResult,
  PluginCommandResult,
  PluginManagerEvent,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
} from "@kobrixa/plugin-runtime";
import type { LocalizedText } from "@kobrixa/plugin-protocol";

export type {
  LocalizedText,
  PluginActionResult,
  PluginCommandResult,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
};
export type PluginEvent = PluginManagerEvent;
export interface PluginsApi {
  state(): Promise<PluginsSnapshot>;
  execute(commandId: string): Promise<PluginCommandResult>;
  setEnabled(pluginId: string, enabled: boolean): Promise<PluginActionResult>;
  onEvent(listener: (event: PluginEvent) => void): () => void;
}
