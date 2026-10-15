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

export const compilerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const extensionSchema = z.string().regex(/^[a-z0-9]{1,16}$/);
const irRangeSchema = z.looseObject({ min: z.number().int().min(1), max: z.number().int().min(1) });
export const frontendDeclSchema = z.looseObject({
  language: compilerIdSchema,
  entryExtensions: z.array(extensionSchema).min(1),
  sourceExtensions: z.array(extensionSchema).min(1),
  ir: irRangeSchema,
});
export const artifactDeclSchema = z.looseObject({
  slot: compilerIdSchema,
  kind: compilerIdSchema,
  extension: extensionSchema,
  mediaType: z
    .string()
    .max(127)
    .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
  role: z.enum(["deploy-main", "aux"]),
  required: z.boolean(),
});
export const backendDeclSchema = z.looseObject({
  target: compilerIdSchema,
  ir: irRangeSchema,
  capabilities: z.looseObject({ deploy: z.literal("ev3").optional() }),
  artifacts: z.array(artifactDeclSchema).max(16),
});
export type FrontendDecl = z.infer<typeof frontendDeclSchema>;
export type BackendDecl = z.infer<typeof backendDeclSchema>;
export type ArtifactDecl = z.infer<typeof artifactDeclSchema>;

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
      frontends: z.array(frontendDeclSchema).max(8).optional(),
      backends: z.array(backendDeclSchema).max(8).optional(),
    })
    .optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function compilerDeclarationProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  for (const frontend of manifest.contributes?.frontends ?? []) {
    if (frontend.ir.min > frontend.ir.max) problems.push("Frontend IR range is empty.");
    if (
      frontend.entryExtensions.some((extension) => !frontend.sourceExtensions.includes(extension))
    )
      problems.push("Entry extensions must be a subset of source extensions.");
  }
  for (const backend of manifest.contributes?.backends ?? []) {
    if (backend.ir.min > backend.ir.max) problems.push("Backend IR range is empty.");
    const slots = backend.artifacts.map((artifact) => artifact.slot);
    if (new Set(slots).size !== slots.length) problems.push("Artifact slots must be unique.");
    if (slots.some((slot) => slot === "ir" || slot === "asset"))
      problems.push("Artifact slot is reserved by the host.");
    const mains = backend.artifacts.filter((artifact) => artifact.role === "deploy-main");
    if (backend.capabilities.deploy && (mains.length !== 1 || !mains[0]!.required))
      problems.push("A deployable backend requires exactly one required deploy-main.");
  }
  return problems;
}
