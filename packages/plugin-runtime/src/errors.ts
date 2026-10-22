import type { StaticLanguageProblemDetail } from "./static-languages.js";

import type { PluginErrorCode } from "@kobrixa/plugin-protocol";
export { PLUGIN_ERROR_CODES } from "@kobrixa/plugin-protocol";
export type { PluginErrorCode } from "@kobrixa/plugin-protocol";
export interface PluginProblem {
  code: PluginErrorCode;
  message: string;
  detail?: StaticLanguageProblemDetail;
  providerKey?: `language:${string}` | `target:${string}`;
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
