import type { BackendDecl, FrontendDecl } from "@kobrixa/plugin-protocol";
import type { RegisteredPlugin } from "./registry.js";

export type ProviderRef<T extends FrontendDecl | BackendDecl = FrontendDecl | BackendDecl> = {
  pluginId: string;
  sourceKey: string;
  contribution: T;
};
export type CompilerResolution =
  | { ok: true; frontend: ProviderRef<FrontendDecl>; backend: ProviderRef<BackendDecl>; ir: number }
  | { ok: false; code: "BUILD1001" | "BUILD1002"; message: string };
export type CompilerSnapshot = Extract<CompilerResolution, { ok: true }>;

export function markProviderConflicts(plugins: RegisteredPlugin[]): void {
  const owners = new Map<string, RegisteredPlugin[]>();
  for (const plugin of plugins) {
    if (plugin.status !== "enabled") continue;
    const keys = [
      ...(plugin.manifest?.contributes?.frontends ?? []).map((item) => `language:${item.language}`),
      ...(plugin.manifest?.contributes?.backends ?? []).map((item) => `target:${item.target}`),
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
        message: `Multiple enabled plugins provide ${key}.`,
      });
    }
  }
}
export function resolveCompilerProviders(
  plugins: readonly RegisteredPlugin[],
  language: string,
  target: string,
): CompilerResolution {
  const active = plugins.filter((plugin) => plugin.status === "enabled");
  const frontends: ProviderRef<FrontendDecl>[] = active.flatMap((plugin) =>
    (plugin.manifest?.contributes?.frontends ?? [])
      .filter((item) => item.language === language)
      .map((contribution) => ({ pluginId: plugin.id, sourceKey: plugin.sourceKey, contribution })),
  );
  const backends: ProviderRef<BackendDecl>[] = active.flatMap((plugin) =>
    (plugin.manifest?.contributes?.backends ?? [])
      .filter((item) => item.target === target)
      .map((contribution) => ({ pluginId: plugin.id, sourceKey: plugin.sourceKey, contribution })),
  );
  if (frontends.length !== 1 || backends.length !== 1)
    return {
      ok: false,
      code: "BUILD1001",
      message: `No enabled language/target provider: ${language}/${target}`,
    };
  const frontend = frontends[0]!;
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
