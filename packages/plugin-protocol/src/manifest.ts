import { z } from "zod";
import { PLUGIN_LIMITS } from "./limits.js";
import {
  localizedTextSchema,
  namespacedIdSchema,
  permissionSchema,
  semverSchema,
} from "./common.js";

// Segments cannot start with "." so "..", hidden folders and absolute paths are rejected.
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/);
const runtimeSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("builtin") }),
  z.looseObject({ kind: z.literal("node"), entry: relativePath }),
  z.looseObject({ kind: z.literal("python"), entry: relativePath }),
]);

/** Unknown fields are allowed for forward compatibility; invalid known fields are errors. */
export const pluginManifestSchema = z.looseObject({
  id: namespacedIdSchema,
  version: semverSchema,
  apiVersion: z
    .string()
    .max(64)
    .regex(/^[\^~]?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/),
  displayName: localizedTextSchema.optional(),
  runtime: runtimeSchema,
  activationEvents: z
    .array(
      z
        .string()
        .max(160)
        .regex(/^onCommand:[a-z0-9.-]+$/),
    )
    .max(PLUGIN_LIMITS.activationEvents)
    .optional(),
  permissions: z.array(permissionSchema).max(16).optional(),
  contributes: z
    .looseObject({
      commands: z
        .array(z.looseObject({ id: namespacedIdSchema, title: localizedTextSchema }))
        .max(PLUGIN_LIMITS.commandsPerPlugin)
        .optional(),
      frontends: z
        .array(z.looseObject({ language: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }))
        .max(8)
        .optional(),
    })
    .optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
