export const PLUGIN_API_VERSION = "1.7.0";
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

export const DIAGNOSTIC_HELP_LIMITS = {
  fileBytes: 1_048_576,
  entriesPerPlugin: 512,
  entryBytes: 16_384,
  stepsPerLocale: 16,
  linksPerEntry: 4,
  urlLength: 2048,
  lineLength: 500,
  blockLength: 4000,
  totalBytes: 8_388_608,
} as const;
