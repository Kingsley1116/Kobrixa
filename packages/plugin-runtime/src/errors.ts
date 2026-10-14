export const PLUGIN_ERROR_CODES = [
  "PLUGIN_E_MANIFEST",
  "PLUGIN_E_API_VERSION",
  "PLUGIN_E_DUPLICATE_ID",
  "PLUGIN_E_COMMAND_NAMESPACE",
  "PLUGIN_E_DUPLICATE_COMMAND",
  "PLUGIN_E_ACTIVATION",
  "PLUGIN_E_RUNTIME_NOT_ALLOWED",
  "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
  "PLUGIN_E_ENTRY",
  "PLUGIN_E_LAUNCH",
  "PLUGIN_E_HANDSHAKE",
  "PLUGIN_E_PROTOCOL",
  "PLUGIN_E_UNRESPONSIVE",
  "PLUGIN_E_CRASHED",
  "PLUGIN_E_CRASH_LOOP",
  "PLUGIN_E_TIMEOUT",
  "PLUGIN_E_CANCELLED",
  "PLUGIN_E_COMMAND_FAILED",
  "PLUGIN_E_UNKNOWN_COMMAND",
  "PLUGIN_E_UNKNOWN_PLUGIN",
  "PLUGIN_E_DISABLED",
  "PLUGIN_E_BUILTIN_REQUIRED",
  "PLUGIN_E_SAFE_MODE",
  "PLUGIN_E_STATE_SAVE",
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];
export interface PluginProblem {
  code: PluginErrorCode;
  message: string;
}
export class PluginError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
