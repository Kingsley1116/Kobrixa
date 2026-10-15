import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import { BuildError, type CompilerBackend, type LanguageFrontend } from "@kobrixa/compiler";
import {
  resolveCompilerProviders,
  resolvePlugins,
  type CompilerResolution,
  type CompilerSnapshot,
} from "@kobrixa/plugin-runtime";
import { pluginManifestSchema, type BackendDecl } from "@kobrixa/plugin-protocol";
import { BUILTIN_PLUGIN_SOURCES } from "../plugins/builtin.js";

const key = (pluginId: string, id: string): string => `${pluginId}:${id}`;
export const BUILTIN_FRONTENDS: Readonly<Record<string, () => LanguageFrontend>> = {
  "kobrixa.basic-plus:bp": () => new BasicPlusFrontend(),
};
export const BUILTIN_BACKENDS: Readonly<
  Record<string, (declaration: BackendDecl, irVersion: number) => CompilerBackend>
> = {
  "kobrixa.ev3:ev3-native": (declaration, irVersion) => ({
    id: declaration.target,
    declaration: structuredClone(declaration),
    irVersion,
    async compile(ir, signal) {
      const result = await new EV3Backend().compile(ir, signal);
      return {
        artifacts: [
          ...(result.rbf ? [{ slot: "program", data: result.rbf }] : []),
          ...(result.listing === undefined
            ? []
            : [{ slot: "listing", data: new TextEncoder().encode(result.listing) }]),
        ],
        diagnostics: result.diagnostics,
      };
    },
  }),
};
export function createBuiltinCompilers(snapshot: CompilerSnapshot): {
  frontend: LanguageFrontend;
  backend: CompilerBackend;
} {
  const front = snapshot.frontend;
  const back = snapshot.backend;
  const createFrontend = BUILTIN_FRONTENDS[key(front.pluginId, front.contribution.language)];
  const createBackend = BUILTIN_BACKENDS[key(back.pluginId, back.contribution.target)];
  if (!createFrontend || !createBackend)
    throw new BuildError(
      "BUILD1001",
      "No built-in compiler factory matches the provider snapshot.",
    );
  return { frontend: createFrontend(), backend: createBackend(back.contribution, snapshot.ir) };
}

export function resolveBuiltinCompiler(language: string, target: string): CompilerResolution {
  const sources = BUILTIN_PLUGIN_SOURCES.map((source) => {
    if (source.kind !== "builtin") throw new Error("Built-in sources only.");
    const manifest = pluginManifestSchema.parse(source.manifest);
    return {
      id: manifest.id,
      sourceKey: `builtin:${manifest.id}`,
      source: "builtin" as const,
      problems: [],
      manifest,
    };
  });
  const plugins = resolvePlugins(sources, { disabled: new Set(), safeMode: false });
  return resolveCompilerProviders(plugins, language, target);
}
