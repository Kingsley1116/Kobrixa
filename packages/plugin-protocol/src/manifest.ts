import { z } from "zod";
import { staticLanguageText } from "./static-language-schemas.js";
import { PLUGIN_LIMITS } from "./limits.js";
import { diagnosticHelpDeclSchema } from "./diagnostic-help.js";
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
export const staticRuntimeSchema = z.strictObject({ kind: z.literal("static") });
export type StaticRuntime = z.infer<typeof staticRuntimeSchema>;
const runtimeSchema = z.discriminatedUnion("kind", [
  staticRuntimeSchema,
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
export const LANGUAGE_CAPABILITIES = [
  "analysis",
  "completion",
  "quickFixes",
  "semanticTokens",
  "hover",
  "signatureHelp",
  "definition",
  "references",
  "rename",
  "documentSymbols",
  "documentFormatting",
  "rangeFormatting",
] as const;
export const languageCapabilitySchema = z.enum(LANGUAGE_CAPABILITIES);
export type LanguageCapability = z.infer<typeof languageCapabilitySchema>;
export const languageServiceDeclSchema = z.strictObject({
  language: compilerIdSchema,
  extensions: z.array(extensionSchema).min(1),
  capabilities: z.array(languageCapabilitySchema).min(1),
});
export type LanguageServiceDecl = z.infer<typeof languageServiceDeclSchema>;

export const staticLanguageResourceDeclSchema = z.strictObject({
  version: z.literal(1),
  path: diagnosticHelpDeclSchema.shape.path,
});
export type StaticLanguageResourceDecl = z.infer<typeof staticLanguageResourceDeclSchema>;
export const staticLanguageDeclSchema = z.strictObject({
  id: compilerIdSchema,
  extensions: z.array(extensionSchema).min(1).max(16),
  aliases: z
    .array(staticLanguageText(1, 80, true))
    .min(1)
    .max(8)
    .optional(),
  tokenizer: staticLanguageResourceDeclSchema,
  configuration: staticLanguageResourceDeclSchema,
});
export type StaticLanguageDecl = z.infer<typeof staticLanguageDeclSchema>;

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
      diagnosticHelp: diagnosticHelpDeclSchema.optional(),
      languageServices: z.array(languageServiceDeclSchema).max(8).optional(),
      languages: z.array(staticLanguageDeclSchema).max(8).optional(),
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

export function languageServiceDeclarationProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  const languages = new Set<string>();
  for (const service of manifest.contributes?.languageServices ?? []) {
    if (languages.has(service.language))
      problems.push("Language services must have unique languages.");
    languages.add(service.language);
    if (new Set(service.extensions).size !== service.extensions.length)
      problems.push("Language service extensions must be unique.");
    if (new Set(service.capabilities).size !== service.capabilities.length)
      problems.push("Language service capabilities must be unique.");
    if (!service.capabilities.includes("analysis"))
      problems.push("Language services must support analysis.");
    const frontends = (manifest.contributes?.frontends ?? []).filter(
      (f) => f.language === service.language,
    );
    const frontend = frontends[0];
    if (
      frontends.length !== 1 ||
      !frontend ||
      new Set(frontend.sourceExtensions).size !== new Set(service.extensions).size ||
      frontend.sourceExtensions.some((extension) => !service.extensions.includes(extension))
    )
      problems.push(
        "Language services require one matching frontend with the same source extensions.",
      );
  }
  return problems;
}

/** Called only after source restrictions; T1 supplies cross-field/static-runtime semantics. */
export function staticLanguageDeclarationProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  const contributes = manifest.contributes;
  const languages = contributes?.languages ?? [];
  if (manifest.runtime.kind === "static") {
    for (const key of ["activationEvents", "permissions"] as const)
      if (Object.hasOwn(manifest, key)) problems.push(`Static runtime must not declare ${key}.`);
    for (const key of ["commands", "frontends", "backends", "languageServices"] as const)
      if (contributes && Object.hasOwn(contributes, key))
        problems.push(`Static runtime must not declare contributes.${key}.`);
    if (languages.length === 0 && !contributes?.diagnosticHelp)
      problems.push("Static runtime requires languages or diagnosticHelp.");
  }
  const ids = new Set<string>();
  const equal = (a: readonly string[], b: readonly string[]) => {
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((value) => right.has(value));
  };
  for (const language of languages) {
    if (ids.has(language.id)) problems.push(`Static language id ${language.id} is duplicated.`);
    ids.add(language.id);
    for (const [field, values] of [
      ["extensions", language.extensions],
      ["aliases", language.aliases ?? []],
    ] as const)
      if (new Set(values).size !== values.length)
        problems.push(`Static language ${language.id} ${field} must be unique.`);
    for (const frontend of contributes?.frontends ?? [])
      if (
        frontend.language === language.id &&
        !equal(language.extensions, frontend.sourceExtensions)
      )
        problems.push(
          `Static language ${language.id} extensions must match frontend sourceExtensions.`,
        );
    for (const service of contributes?.languageServices ?? [])
      if (service.language === language.id && !equal(language.extensions, service.extensions))
        problems.push(
          `Static language ${language.id} extensions must match language service extensions.`,
        );
  }
  return problems;
}
