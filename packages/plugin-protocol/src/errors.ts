import type { PluginErrorCode } from "./business-result.js";

export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  timeout: -32001,
  permissionDenied: -32002,
  connectionClosed: -32003,
} as const;

// Type-only cumulative contracts; RPC_ERRORS remains the legacy numeric envelope.
export type PluginErrorCodeV150 = Exclude<
  PluginErrorCode,
  "PLUGIN_E_UI_RESOURCE" | "PLUGIN_E_UI_VERSION"
>;
export type PluginErrorCodeV160 =
  PluginErrorCodeV150 | "PLUGIN_E_UI_RESOURCE" | "PLUGIN_E_UI_VERSION";
export type PluginErrorCodeV170 =
  | PluginErrorCodeV160
  | "PLUGIN_E_SETTINGS_SCHEMA"
  | "PLUGIN_E_SETTINGS_CONFLICT"
  | "PLUGIN_E_SETTINGS_SAVE"
  | "PLUGIN_E_STORAGE_QUOTA"
  | "PLUGIN_E_STORAGE_CONFLICT"
  | "PLUGIN_E_STORAGE_IO"
  | "PLUGIN_E_STORAGE_VERSION";
export type Stage3PluginErrorCode = PluginErrorCodeV170;

export { PLUGIN_ERROR_CODES, pluginErrorCodeSchema } from "./business-result.js";
export type { PluginErrorCode } from "./business-result.js";
