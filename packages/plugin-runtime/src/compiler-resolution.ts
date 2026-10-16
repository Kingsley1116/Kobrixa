import type { BackendDecl, FrontendDecl, LanguageServiceDecl } from "@kobrixa/plugin-protocol";
import type { RegisteredPlugin } from "./registry.js";
import type { PluginProblem } from "./errors.js";

export type ProviderRef<T extends FrontendDecl | BackendDecl = FrontendDecl | BackendDecl> = {
  pluginId: string;
  sourceKey: string;
  contribution: T;
};
export type CompilerResolution =
  | { ok: true; frontend: ProviderRef<FrontendDecl>; backend: ProviderRef<BackendDecl>; ir: number }
  | { ok: false; code: "BUILD1001" | "BUILD1002"; message: string };
export type CompilerSnapshot = Extract<CompilerResolution, { ok: true }>;
export type FrontendResolution =
  | { ok: true; frontend: ProviderRef<FrontendDecl> }
  | { ok: false; reason: "missing" | "conflict"; language: string; conflicts: string[] };
export type LanguageServiceResolution =
  | {
      ok: true;
      frontend: ProviderRef<FrontendDecl>;
      generation: number;
      declaration: LanguageServiceDecl;
    }
  | { ok: false; reason: "missing" | "conflict"; language: string; conflicts: string[] };

export function markProviderConflicts(plugins: RegisteredPlugin[]): void {
  const owners = new Map<NonNullable<PluginProblem["providerKey"]>, RegisteredPlugin[]>();
  for (const plugin of plugins) {
    if (plugin.status !== "enabled") continue;
    const keys = [
      ...(plugin.manifest?.contributes?.frontends ?? []).map(
        (item) => `language:${item.language}` as const,
      ),
      ...(plugin.manifest?.contributes?.backends ?? []).map(
        (item) => `target:${item.target}` as const,
      ),
    ];
    for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), plugin]);
  }
  // 先建立全部分組再改 status，避免前一組失效使後一組誤剩單一提供者。
  for (const [key, group] of owners) {
    if (group.length < 2) continue;
    for (const plugin of new Set(group)) {
      plugin.status = "invalid";
      plugin.problems.push({
        code: "PLUGIN_E_PROVIDER_CONFLICT",
        providerKey: key,
        message: `Multiple enabled plugins provide ${key}.`,
      });
    }
  }
}
export function resolveFrontendProvider(
  plugins: readonly RegisteredPlugin[],
  language: string,
): FrontendResolution {
  const key = `language:${language}`;
  const conflicts = plugins
    .filter((plugin) =>
      plugin.problems.some((p) => p.code === "PLUGIN_E_PROVIDER_CONFLICT" && p.providerKey === key),
    )
    .map((plugin) => plugin.id)
    .sort();
  if (conflicts.length) return { ok: false, reason: "conflict", language, conflicts };
  const frontends = plugins
    .filter((p) => p.status === "enabled")
    .flatMap((plugin) =>
      (plugin.manifest?.contributes?.frontends ?? [])
        .filter((f) => f.language === language)
        .map((contribution) => ({
          pluginId: plugin.id,
          sourceKey: plugin.sourceKey,
          contribution,
        })),
    );
  if (frontends.length > 1)
    return {
      ok: false,
      reason: "conflict",
      language,
      conflicts: frontends.map((f) => f.pluginId).sort(),
    };
  return frontends.length === 1
    ? structuredClone({ ok: true, frontend: frontends[0]! })
    : { ok: false, reason: "missing", language, conflicts: [] };
}

export function resolveLanguageService(
  plugins: readonly RegisteredPlugin[],
  language: string,
  generation = 0,
): LanguageServiceResolution {
  const result = resolveFrontendProvider(plugins, language);
  if (!result.ok) return result;
  const owner = plugins.find((plugin) => plugin.sourceKey === result.frontend.sourceKey)!;
  const declaration = owner.manifest?.contributes?.languageServices?.find(
    (service) => service.language === language,
  );
  return declaration
    ? structuredClone({ ok: true, frontend: result.frontend, generation, declaration })
    : { ok: false, reason: "missing", language, conflicts: [] };
}

export function resolveCompilerProviders(
  plugins: readonly RegisteredPlugin[],
  language: string,
  target: string,
): CompilerResolution {
  const active = plugins.filter((plugin) => plugin.status === "enabled");
  const selected = resolveFrontendProvider(plugins, language);
  const backends: ProviderRef<BackendDecl>[] = active.flatMap((plugin) =>
    (plugin.manifest?.contributes?.backends ?? [])
      .filter((item) => item.target === target)
      .map((contribution) => ({ pluginId: plugin.id, sourceKey: plugin.sourceKey, contribution })),
  );
  if (!selected.ok || backends.length !== 1)
    return {
      ok: false,
      code: "BUILD1001",
      message: `No enabled language/target provider: ${language}/${target}`,
    };
  const frontend = selected.frontend;
  const backend = backends[0]!;
  const min = Math.max(frontend.contribution.ir.min, backend.contribution.ir.min);
  const max = Math.min(frontend.contribution.ir.max, backend.contribution.ir.max);
  if (min > max)
    return {
      ok: false,
      code: "BUILD1002",
      message: "The frontend's IR versions are incompatible with the target.",
    };
  return structuredClone({ ok: true, frontend, backend, ir: max });
}
