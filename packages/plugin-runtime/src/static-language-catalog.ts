import { createHash } from "node:crypto";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1 as L,
  validateStaticLanguageResources,
  type StaticLanguageDecl,
} from "@kobrixa/plugin-protocol";
import type { PluginProblem } from "./errors.js";
import type { PluginSource, RegisteredPlugin } from "./registry.js";
import {
  PackagedResourceError,
  readBuiltinJson,
  readPackagedJson,
} from "./packaged-json-resource.js";
import {
  CORE_STATIC_LANGUAGE_IDS,
  emptyStaticLanguagesCatalog,
  type StaticLanguageConflict,
  type StaticLanguageSourceIdentity,
  type StaticLanguagesCatalog,
  type ValidatedStaticLanguage,
} from "./static-languages.js";

export type StaticCatalogEntry = {
  source: PluginSource;
  plugin: RegisteredPlugin;
  generation: number;
};
type Candidate = StaticLanguageSourceIdentity & { generation: number; extensions: string[] };
type Job = { entry: StaticCatalogEntry; declaration: StaticLanguageDecl };
export type StaticCatalogBuild = {
  catalog: StaticLanguagesCatalog;
  problems: Map<string, PluginProblem[]>;
  resourceProblems: Map<string, PluginProblem[]>;
  idConflicts: StaticLanguageConflict[];
  valid: Candidate[];
  enabledKey: string;
};
export const staticLanguageKey = (sourceKey: string, generation: number, languageId: string) =>
  JSON.stringify([sourceKey, generation, languageId]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const identity = (job: Job): StaticLanguageSourceIdentity => ({
  pluginId: job.entry.plugin.id,
  sourceKey: job.entry.plugin.sourceKey,
  languageId: job.declaration.id,
});
const uniqueSources = (sources: StaticLanguageSourceIdentity[]) =>
  [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()].sort(
    (a, b) => order(a.sourceKey, b.sourceKey) || order(a.languageId, b.languageId),
  );
function addProblem(
  problems: Map<string, PluginProblem[]>,
  sourceKey: string,
  value: PluginProblem,
): void {
  const list = problems.get(sourceKey) ?? [];
  list.push(value);
  problems.set(sourceKey, list);
}
function limitProblem(job: Job, key: keyof typeof L, actual: number): PluginProblem {
  const allowed = L[key];
  if (typeof allowed !== "number") throw new Error("Expected a numeric static language limit.");
  return {
    code: "PLUGIN_E_STATIC_LANGUAGE",
    message: `${job.entry.plugin.id} / ${job.declaration.id}: STATIC_LANGUAGE_LIMITS_V1.${key} exceeded (actual ${actual}, allowed ${allowed}).`,
    detail: {
      languageId: job.declaration.id,
      resourcePath: job.declaration.tokenizer.path,
      limit: `STATIC_LANGUAGE_LIMITS_V1.${key}`,
      allowed,
      actual,
    },
  };
}

// Projection is synchronous so a renderer report can revoke immediately while an I/O pass is pending.
export function projectStaticLanguageCatalog(
  build: StaticCatalogBuild,
  keep: (sourceKey: string, generation: number) => boolean = () => true,
  quarantined: ReadonlyMap<string, PluginProblem> = new Map(),
): StaticCatalogBuild {
  const usable = (sourceKey: string, generation: number, id: string) =>
    keep(sourceKey, generation) && !quarantined.has(staticLanguageKey(sourceKey, generation, id));
  const valid = build.valid.filter((item) =>
    usable(item.sourceKey, item.generation, item.languageId),
  );
  const languages = build.catalog.languages.filter((item) =>
    usable(item.sourceKey, item.generation, item.id),
  );
  const conflicts = [...build.idConflicts];
  const extensions = new Map<string, Candidate[]>();
  for (const candidate of valid)
    for (const extension of candidate.extensions) {
      const group = extensions.get(extension) ?? [];
      group.push(candidate);
      extensions.set(extension, group);
    }
  const admitted = new Set(languages.map((language) => language.id));
  const routes: [string, string | null][] = [];
  for (const [extension, group] of [...extensions].sort(([a], [b]) => order(a, b))) {
    const sources = uniqueSources(
      group.map(({ pluginId, sourceKey, languageId }) => ({ pluginId, sourceKey, languageId })),
    );
    if (extension === "json")
      conflicts.push({ kind: "reserved-extension", key: extension, sources });
    else if (sources.length > 1) {
      conflicts.push({ kind: "extension", key: extension, sources });
      routes.push([extension, null]);
    } else if (admitted.has(sources[0]!.languageId))
      routes.push([extension, sources[0]!.languageId]);
  }
  conflicts.sort((a, b) => order(a.kind, b.kind) || order(a.key, b.key));
  const problems = new Map<string, PluginProblem[]>(
    [...build.resourceProblems].map(([key, items]) => [key, [...items]]),
  );
  for (const conflict of conflicts)
    for (const source of conflict.sources)
      addProblem(problems, source.sourceKey, {
        code: "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
        message: `${source.pluginId} / ${source.languageId}: ${conflict.kind} conflict for ${conflict.key}.`,
        detail: { languageId: source.languageId, conflictingSources: conflict.sources },
      });
  for (const [key, problem] of quarantined) {
    const [sourceKey, generation] = JSON.parse(key) as [string, number, string];
    if (keep(sourceKey, generation)) addProblem(problems, sourceKey, problem);
  }
  return {
    ...build,
    problems,
    catalog: {
      ...build.catalog,
      languages,
      extensionRoutes: Object.fromEntries(routes),
      conflicts,
    },
  };
}

export async function buildStaticLanguageCatalog(
  entries: readonly StaticCatalogEntry[],
  quarantined: ReadonlySet<string>,
  current: () => boolean = () => true,
): Promise<StaticCatalogBuild> {
  const enabled = entries
    .filter(({ plugin }) => plugin.status === "enabled")
    .sort((a, b) => order(a.plugin.sourceKey, b.plugin.sourceKey));
  const jobs: Job[] = [];
  const frontends = new Map<string, StaticLanguageSourceIdentity>();
  const ids = new Map<string, Job[]>();
  for (const entry of enabled) {
    for (const frontend of entry.plugin.manifest?.contributes?.frontends ?? [])
      frontends.set(frontend.language, {
        pluginId: entry.plugin.id,
        sourceKey: entry.plugin.sourceKey,
        languageId: frontend.language,
      });
    for (const declaration of [...(entry.plugin.manifest?.contributes?.languages ?? [])].sort(
      (a, b) => order(a.id, b.id),
    )) {
      const job = { entry, declaration };
      jobs.push(job);
      const group = ids.get(declaration.id) ?? [];
      group.push(job);
      ids.set(declaration.id, group);
    }
  }
  const blocked = new Set<Job>();
  const idConflicts: StaticLanguageConflict[] = [];
  for (const [id, group] of ids) {
    const owner = frontends.get(id);
    if (CORE_STATIC_LANGUAGE_IDS.includes(id)) {
      group.forEach((job) => blocked.add(job));
      idConflicts.push({
        kind: "reserved-id",
        key: id,
        sources: uniqueSources(group.map(identity)),
      });
    } else if (owner) {
      const foreign = group.filter(
        (job) =>
          job.entry.plugin.sourceKey !== owner.sourceKey || job.entry.plugin.id !== owner.pluginId,
      );
      foreign.forEach((job) => blocked.add(job));
      if (foreign.length)
        idConflicts.push({
          kind: "frontend-owner",
          key: id,
          sources: uniqueSources([owner, ...foreign.map(identity)]),
        });
    } else if (group.length > 1) {
      group.forEach((job) => blocked.add(job));
      idConflicts.push({ kind: "id", key: id, sources: uniqueSources(group.map(identity)) });
    }
  }
  const resourceProblems = new Map<string, PluginProblem[]>();
  const languages: ValidatedStaticLanguage[] = [];
  const valid: Candidate[] = [];
  const pluginBytes = new Map<string, number>();
  let totalBytes = 0;
  let totalRules = 0;
  // One in-flight resource job: no Promise.all over raw resources. Each read resumes
  // only its source's remaining allowance; every other source's budget is paused.
  // Rejected payloads leave this iteration; only admitted payloads remain retained.
  for (const job of jobs) {
    if (!current()) throw new Error("Superseded static language operation.");
    const { entry, declaration: decl } = job;
    const { plugin, generation, source } = entry;
    if (
      blocked.has(job) ||
      quarantined.has(staticLanguageKey(plugin.sourceKey, generation, decl.id))
    )
      continue;
    let resourcePath = decl.tokenizer.path;
    try {
      const budget = plugin.resourceBudget;
      if (!budget) throw new Error("No current source read budget.");
      const read = (file: string) =>
        budget.run(async () => {
          if (source.kind === "builtin")
            return readBuiltinJson(source.resources, file, L.resourceFileBytes);
          return readPackagedJson(plugin.directory!, file, L.resourceFileBytes, budget);
        });
      const tokenizer = await read(decl.tokenizer.path);
      resourcePath = decl.configuration.path;
      const configuration = await read(decl.configuration.path);
      if (!current()) throw new Error("Superseded static language operation.");
      budget.check();
      const bytes = tokenizer.bytes + configuration.bytes;
      if (bytes > L.resourceBytesPerLanguage) {
        addProblem(
          resourceProblems,
          plugin.sourceKey,
          limitProblem(job, "resourceBytesPerLanguage", bytes),
        );
        continue;
      }
      const validation = validateStaticLanguageResources({
        languageId: decl.id,
        formatVersion: STATIC_LANGUAGE_FORMAT_VERSION,
        limitsVersion: 1,
        tokenizer: tokenizer.value,
        configuration: configuration.value,
        resourceBytes: { tokenizer: tokenizer.bytes, configuration: configuration.bytes },
        resourcePaths: { tokenizer: decl.tokenizer.path, configuration: decl.configuration.path },
      });
      if (!validation.ok) {
        for (const problem of validation.problems)
          addProblem(resourceProblems, plugin.sourceKey, {
            code: "PLUGIN_E_STATIC_LANGUAGE",
            message: `${plugin.id} / ${decl.id}: ${problem.message}`,
            detail: { ...problem.detail, languageId: decl.id },
          });
        continue;
      }
      valid.push({ ...identity(job), generation, extensions: [...decl.extensions] });
      const nextPluginBytes = (pluginBytes.get(plugin.sourceKey) ?? 0) + bytes;
      const checks: [keyof typeof L, number][] = [
        ["resourceBytesPerPlugin", nextPluginBytes],
        ["resourceBytesTotal", totalBytes + bytes],
        ["languagesTotal", languages.length + 1],
        ["expandedRulesTotal", totalRules + validation.expandedRules],
      ];
      const exceeded = checks.find(
        ([key, actual]) => typeof L[key] === "number" && actual > (L[key] as number),
      );
      if (exceeded) {
        addProblem(resourceProblems, plugin.sourceKey, limitProblem(job, exceeded[0], exceeded[1]));
        continue;
      }
      pluginBytes.set(plugin.sourceKey, nextPluginBytes);
      totalBytes += bytes;
      totalRules += validation.expandedRules;
      languages.push({
        pluginId: plugin.id,
        sourceKey: plugin.sourceKey,
        generation,
        id: decl.id,
        extensions: [...decl.extensions],
        aliases: [...(decl.aliases ?? [])],
        resourceDigest: createHash("sha256")
          .update(`${tokenizer.digest}:${configuration.digest}`)
          .digest("hex"),
        tokenizer: validation.tokenizer,
        configuration: validation.configuration,
        resourceBytes: { tokenizer: tokenizer.bytes, configuration: configuration.bytes },
        expandedRules: validation.expandedRules,
      });
    } catch (error) {
      if (!current()) throw error;
      const detail: NonNullable<PluginProblem["detail"]> = { languageId: decl.id, resourcePath };
      if (error instanceof PackagedResourceError && error.limit !== undefined) {
        detail.limit = `STATIC_LANGUAGE_LIMITS_V1.${error.limit}`;
        if (error.allowed !== undefined) detail.allowed = error.allowed;
        if (error.actual !== undefined) detail.actual = error.actual;
      }
      // Do not forward filesystem exceptions: their messages can contain physical paths.
      const reason =
        error instanceof Error && error.message.includes("deadline")
          ? "source resource deadline exceeded"
          : "invalid or unreadable packaged JSON resource";
      addProblem(resourceProblems, plugin.sourceKey, {
        code: "PLUGIN_E_STATIC_LANGUAGE",
        message: `${plugin.id} / ${decl.id} / ${resourcePath}: ${reason}.`,
        detail,
      });
    }
  }
  return projectStaticLanguageCatalog({
    catalog: { ...emptyStaticLanguagesCatalog(), languages },
    problems: new Map(),
    resourceProblems,
    valid,
    idConflicts,
    enabledKey: JSON.stringify(
      enabled.map(({ plugin, generation }) => [plugin.sourceKey, plugin.id, generation]),
    ),
  });
}
