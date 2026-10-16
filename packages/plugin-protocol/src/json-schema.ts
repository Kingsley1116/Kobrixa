import { z } from "zod";
import { PLUGIN_API_VERSION } from "./limits.js";
import { pluginDiagnosticHelpFileSchema } from "./diagnostic-help.js";
import { pluginManifestSchema } from "./manifest.js";
import { notificationMethods, requestMethods } from "./methods.js";
import { jsonRpcMessageSchema } from "./rpc.js";

export const SCHEMA_DEFINITIONS: Record<string, z.ZodType> = {
  manifest: pluginManifestSchema,
  "diagnostic-help": pluginDiagnosticHelpFileSchema,
  message: jsonRpcMessageSchema,
  ...Object.fromEntries(
    Object.entries(requestMethods).flatMap(([method, { params, result }]) => [
      [`${method}.params`, params],
      [`${method}.result`, result],
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(notificationMethods).map(([method, params]) => [`${method}.params`, params]),
  ),
};

export function buildJsonSchema() {
  const $defs = Object.fromEntries(
    Object.entries(SCHEMA_DEFINITIONS).map(([name, schema]) => {
      // unrepresentable: "throw" makes unsupported Zod features fail instead of widening to {}.
      const definition: Record<string, unknown> = {
        ...z.toJSONSchema(schema, {
          target: "draft-2020-12",
          unrepresentable: "throw",
          io: "input",
          reused: "inline",
          cycles: "throw",
        }),
      };
      delete definition.$schema;
      return [name, definition];
    }),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://kobrixa.com/schemas/plugin-protocol/${PLUGIN_API_VERSION}.json`,
    title: `Kobrixa plugin protocol ${PLUGIN_API_VERSION}`,
    $defs,
  };
}

export const serializeJsonSchema = (): string => `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
