export const PLUGIN_API_VERSION = "1.0.0";
export const PLUGIN_LIMITS = {
  messageBytes: 1024 * 1024,
  headerBytes: 1024,
  idLength: 128,
  textLength: 200,
  messageLength: 2000,
  errorMessageLength: 2000,
  commandsPerPlugin: 64,
  activationEvents: 64,
  manifestBytes: 64 * 1024,
} as const;
