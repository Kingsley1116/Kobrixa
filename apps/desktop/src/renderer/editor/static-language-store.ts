import { z } from "zod";
import { STATIC_LANGUAGE_LIMITS_V1 } from "@kobrixa/plugin-protocol";
import type {
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "@kobrixa/plugin-protocol";

import type { PluginsApi } from "../../shared/plugins.js";
import type { StaticLanguageOwner, StaticLanguagesCatalog } from "../../shared/static-languages.js";

export interface StaticLanguageStoreSnapshot {
  phase: "loading" | "ready" | "failed";
  /** Highest observed catalog target; distinct from accepted catalog.revision. */
  targetRevision: number;
  /** Complete owner metadata for targetRevision, including ambiguous extensions. */
  owners: readonly StaticLanguageOwner[];
  catalog: StaticLanguagesCatalog;
  error?: string;
}
export interface StaticLanguageStore {
  getSnapshot(): StaticLanguageStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Settles when the first consistent catalog arrives or the initial fetch fails. */
  ready(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}
export type StaticLanguageStoreApi = Pick<PluginsApi, "state" | "staticLanguages" | "onEvent">;

const limits = STATIC_LANGUAGE_LIMITS_V1;
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const extensionsSchema = z
  .array(z.string().regex(/^[a-z0-9]{1,16}$/))
  .min(1)
  .max(16)
  .refine((values) => new Set(values).size === values.length);
const identityShape = {
  pluginId: z.string().min(1),
  sourceKey: z.string().min(1),
  generation: revisionSchema,
};
const ownerSchema = z.object({
  ...identityShape,
  languageId: idSchema,
  extensions: extensionsSchema,
});
const ownersSchema = z
  .array(ownerSchema)
  .max(limits.languagesTotal)
  .refine((values) => new Set(values.map((value) => value.languageId)).size === values.length);
const metadataSchema = z.object({
  staticLanguagesRevision: revisionSchema,
  staticLanguageOwners: ownersSchema,
});
const languageSchema = z.object({
  ...identityShape,
  id: idSchema,
  extensions: extensionsSchema,
  aliases: z
    .array(z.string().regex(/^[^\p{Cc}\u2028\u2029]{1,80}$/u))
    .max(8)
    .refine((values) => new Set(values).size === values.length),
  resourceDigest: z.string().min(1),
  // Unknown resource contents are deliberately left for the pure shared validator.
  tokenizer: z.custom<StaticLanguageTokenizerV1>((value) => value !== undefined),
  configuration: z.custom<StaticLanguageConfigurationV1>((value) => value !== undefined),
  resourceBytes: z.object({
    tokenizer: z.number().int().nonnegative().max(limits.resourceFileBytes),
    configuration: z.number().int().nonnegative().max(limits.resourceFileBytes),
  }),
  expandedRules: z.number().int().nonnegative().max(limits.expandedRulesPerLanguage),
});
const catalogSchema = z.object({
  // Preserve unsupported numeric versions long enough to report each identifiable owner.
  formatVersion: revisionSchema,
  limitsVersion: revisionSchema,
  revision: revisionSchema,
  languages: z.array(languageSchema).max(limits.languagesTotal),
  extensionRoutes: z.record(z.string().regex(/^[a-z0-9]{1,16}$/), idSchema.nullable()),
  conflicts: z.array(
    z.object({
      kind: z.enum(["reserved-id", "reserved-extension", "frontend-owner", "id", "extension"]),
      key: z.string(),
      sources: z.array(
        z.object({ pluginId: z.string(), sourceKey: z.string(), languageId: idSchema }),
      ),
    }),
  ),
});
function emptyCatalog(revision: number): StaticLanguagesCatalog {
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages: [],
    extensionRoutes: {},
    conflicts: [],
  };
}
function catalogOwners(catalog: StaticLanguagesCatalog): StaticLanguageOwner[] {
  return catalog.languages.map((value) => ({
    pluginId: value.pluginId,
    sourceKey: value.sourceKey,
    generation: value.generation,
    languageId: value.id,
    extensions: [...value.extensions],
  }));
}
function ownerSignature(owners: readonly StaticLanguageOwner[]): string {
  return JSON.stringify(
    owners
      .map((value) => [
        value.pluginId,
        value.sourceKey,
        value.generation,
        value.languageId,
        [...value.extensions].sort(),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}
function parseCatalog(value: unknown): StaticLanguagesCatalog {
  const parsed = catalogSchema.parse(value);
  if (new Set(parsed.languages.map((language) => language.id)).size !== parsed.languages.length)
    throw new Error("Duplicate catalog language id");
  let bytes = 0;
  let expanded = 0;
  const pluginBytes = new Map<string, number>();
  for (const language of parsed.languages) {
    const size = language.resourceBytes.tokenizer + language.resourceBytes.configuration;
    bytes += size;
    expanded += language.expandedRules;
    const total = (pluginBytes.get(language.sourceKey) ?? 0) + size;
    pluginBytes.set(language.sourceKey, total);
    if (size > limits.resourceBytesPerLanguage || total > limits.resourceBytesPerPlugin)
      throw new Error("Catalog resource budget exceeded");
  }
  if (bytes > limits.resourceBytesTotal || expanded > limits.expandedRulesTotal)
    throw new Error("Catalog total budget exceeded");
  for (const [extension, id] of Object.entries(parsed.extensionRoutes)) {
    // Null is the host's authoritative ambiguity decision over all valid candidates.
    // Admission budgets or marker filtering can omit claimants and conflict details.
    if (id === null) continue;
    const candidates = parsed.languages.filter((language) =>
      language.extensions.includes(extension),
    );
    if (candidates.length !== 1 || candidates[0]!.id !== id)
      throw new Error("Invalid extension route identity");
  }
  // Numeric unsupported versions are quarantined by the registrar, never installed.
  return parsed as StaticLanguagesCatalog;
}

export function createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore {
  let snapshot: StaticLanguageStoreSnapshot = {
    phase: "loading",
    targetRevision: 0,
    owners: [],
    catalog: emptyCatalog(0),
  };
  let disposed = false;
  let request = 0;
  let haveMetadata = false;
  let settled = false;
  let settle!: () => void;
  const first = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const listeners = new Set<() => void>();
  const publish = (next: StaticLanguageStoreSnapshot) => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
    if (!settled && next.phase !== "loading") {
      settled = true;
      settle();
    }
  };
  const fail = (message: string, clear: boolean) => {
    if (clear) haveMetadata = false;
    publish({
      phase: "failed",
      targetRevision: snapshot.targetRevision,
      owners: clear ? [] : snapshot.owners,
      catalog: clear ? emptyCatalog(snapshot.targetRevision) : snapshot.catalog,
      error: message,
    });
  };
  const observe = (value: unknown): boolean => {
    if (disposed) return false;
    const revision = z.object({ staticLanguagesRevision: revisionSchema }).safeParse(value);
    if (revision.success && revision.data.staticLanguagesRevision < snapshot.targetRevision)
      return false;
    const parsed = metadataSchema.safeParse(value);
    if (!parsed.success) {
      if (revision.success)
        snapshot = { ...snapshot, targetRevision: revision.data.staticLanguagesRevision };
      fail("Invalid static language owner metadata", true);
      return true;
    }
    const next = parsed.data;
    if (next.staticLanguagesRevision === snapshot.targetRevision && haveMetadata) {
      if (ownerSignature(next.staticLanguageOwners) !== ownerSignature(snapshot.owners)) {
        fail("Owner metadata changed without a catalog revision", true);
        return true;
      }
      return false;
    }
    haveMetadata = true;
    publish({
      phase: "loading",
      targetRevision: next.staticLanguagesRevision,
      owners: next.staticLanguageOwners,
      catalog: snapshot.catalog,
    });
    return true;
  };
  const fetchCatalog = async (ticket: number): Promise<void> => {
    try {
      const raw = await api.staticLanguages();
      if (disposed) return;
      const revision = z.object({ revision: revisionSchema }).safeParse(raw);
      if (revision.success && revision.data.revision < snapshot.targetRevision) {
        if (ticket === request) fail("Catalog response is older than current ownership", false);
        return;
      }
      let catalog: StaticLanguagesCatalog;
      try {
        catalog = parseCatalog(raw);
      } catch {
        if (ticket === request) fail("Invalid static language catalog", true);
        return;
      }
      const owners = catalogOwners(catalog);
      if (
        catalog.revision === snapshot.targetRevision &&
        haveMetadata &&
        ownerSignature(owners) !== ownerSignature(snapshot.owners)
      ) {
        fail("Catalog and owner metadata disagree", true);
        return;
      }
      haveMetadata = true;
      publish({ phase: "ready", targetRevision: catalog.revision, owners, catalog });
    } catch {
      if (!disposed && ticket === request) fail("Could not load static languages", false);
    }
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const ticket = ++request;
    try {
      observe(await api.state());
    } catch {
      if (!disposed && ticket === request) fail("Could not load plugin state", true);
      return;
    }
    if (!disposed) await fetchCatalog(ticket);
  };
  // Subscribe before state(), including the first request.
  const off = api.onEvent((event) => {
    if (!disposed && event.type === "state" && observe(event.state)) void fetchCatalog(++request);
  });
  void refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: () => first,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      request++;
      off();
      listeners.clear();
      settle();
    },
  };
}
