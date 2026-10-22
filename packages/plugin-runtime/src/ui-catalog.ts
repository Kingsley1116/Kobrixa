import { randomUUID } from "node:crypto";
import {
  UI_LIMITS_V1 as L,
  uiBytes,
  uiFailure,
  resourceFailure,
  validateUiResource,
  type Handle,
  type ResourceOwner,
  type UiOwner,
  type UiCatalogEntry,
  type UiCatalogPage,
  type PanelResourceV1,
  type StatusResourceV1,
  type Result,
  type UiValidationContext,
} from "@kobrixa/plugin-protocol";
import {
  readBuiltinJson,
  readPackagedJson,
  SourceReadBudget,
  PackagedResourceError,
  type PackagedJson,
} from "./packaged-json-resource.js";
import {
  sameResourceOwner,
  type UiBridgeEvent,
  type UiCatalogPort,
  type UiCatalogSource,
  type PluginUiBridge,
} from "./ui-host-ports.js";
type Resource = PanelResourceV1 | StatusResourceV1;
type Entry = { descriptor: UiCatalogEntry; resource?: Resource };
type Source = { input: UiCatalogSource; owner: UiOwner; token: object; entries: Entry[] };
export type UiCatalogDependencies = {
  beforeDelivery?: (sourceKey: string) => void;
  now?: () => number;
  read?: (
    source: UiCatalogSource,
    path: string,
    limit: number,
    budget: SourceReadBudget,
  ) => Promise<PackagedJson>;
  validate?: (value: unknown, context: UiValidationContext, bytes: number) => Result<Resource>;
};
const pathValid = (value: string) =>
  value.length <= 600 &&
  /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.json$/.test(value);
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
export class UiCatalog implements UiCatalogPort {
  #sources = new Map<string, Source>();
  #revision = 0;
  #generation = 0;
  #pass = 0;
  readonly #listeners = new Set<(event: UiBridgeEvent) => void>();
  readonly #cursors = new Map<Handle, { revision: number; offset: number; expires: number }>();
  readonly #now: () => number;
  readonly #read: NonNullable<UiCatalogDependencies["read"]>;
  readonly #validate: NonNullable<UiCatalogDependencies["validate"]>;
  readonly #beforeDelivery: UiCatalogDependencies["beforeDelivery"];
  constructor(
    readonly hostEpoch: Handle,
    deps: UiCatalogDependencies = {},
  ) {
    this.#now = deps.now ?? (() => performance.now());
    this.#read =
      deps.read ??
      (async (source, path, limit, budget) =>
        source.resources.kind === "builtin"
          ? readBuiltinJson(source.resources.files, path, limit)
          : readPackagedJson(source.resources.root, path, limit, budget));
    this.#validate = deps.validate ?? validateUiResource;
    this.#beforeDelivery = deps.beforeDelivery;
  }
  #changed(): void {
    if (this.#revision === Number.MAX_SAFE_INTEGER)
      throw new Error("UI catalog revision exhausted.");
    this.#revision++;
    this.#cursors.clear();
    const owners = [...this.#sources.values()].map((s) => s.owner);
    const event: UiBridgeEvent = {
      type: "catalog",
      hostEpoch: this.hostEpoch,
      revision: this.#revision,
      owners,
    };
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* A view cannot prevent retirement. */
      }
    }
  }
  onEvent(listener: (event: UiBridgeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  declaresUi(owner: ResourceOwner): boolean {
    const source = this.#sources.get(owner.sourceKey)?.input;
    return (
      !!source?.eligible &&
      source.owner.pluginId === owner.pluginId &&
      source.owner.hostEpoch === owner.hostEpoch &&
      (source.panels.length > 0 || source.status.length > 0 || source.commands.length > 0)
    );
  }
  isCurrent(owner: UiOwner): boolean {
    const current = this.#sources.get(owner.sourceKey);
    return (
      current?.owner.pluginId === owner.pluginId &&
      current.owner.uiResourceGeneration === owner.uiResourceGeneration
    );
  }
  replace(inputs: readonly UiCatalogSource[]): Promise<void> {
    return this.#replace(inputs, new Map());
  }
  async #replace(
    inputs: readonly UiCatalogSource[],
    retained: ReadonlyMap<string, Source>,
  ): Promise<void> {
    const pass = ++this.#pass;
    const eligible = inputs
      .filter((s) => s.eligible)
      .sort((a, b) => compare(a.owner.sourceKey, b.owner.sourceKey));
    if (
      eligible.length > 32 ||
      new Set(eligible.map((s) => s.owner.sourceKey)).size !== eligible.length
    )
      throw new Error(
        "UI source inventory exceeds the frozen catalog owner limit or contains duplicates.",
      );
    const next = new Map<string, Source>();
    for (const input of eligible) {
      const keep = retained.get(input.owner.sourceKey);
      if (keep) {
        next.set(input.owner.sourceKey, keep);
        continue;
      }
      if (input.owner.hostEpoch !== this.hostEpoch)
        throw new Error("UI owner belongs to a different host.");
      if (++this.#generation > Number.MAX_SAFE_INTEGER) throw new Error("UI generation exhausted.");
      next.set(input.owner.sourceKey, {
        input: structuredClone(input),
        token: {},
        owner: {
          sourceKey: input.owner.sourceKey,
          pluginId: input.owner.pluginId,
          uiResourceGeneration: this.#generation,
        },
        entries: [],
      });
    }
    // Same-turn invalidation before any file read; late awaits must match both map identity and pass.
    this.#sources = next;
    this.#changed();
    let hostBytes = [...retained.values()].reduce(
      (sum, source) =>
        sum +
        source.entries.reduce(
          (bytes, entry) =>
            bytes +
            (entry.descriptor.availability === "available" ? entry.descriptor.resourceBytes : 0),
          0,
        ),
      0,
    );
    for (const source of next.values()) {
      if (retained.has(source.owner.sourceKey)) continue;
      const token = source.token;
      const budget = new SourceReadBudget(L.sourceReadMs, this.#now);
      let sourceBytes = 0;
      const declarations = [
        ...source.input.panels.map((d) => ({ ...d, kind: "panel" as const })),
        ...source.input.status.map((d) => ({ ...d, kind: "status" as const })),
      ].sort((a, b) => compare(a.id, b.id));
      for (const declaration of declarations) {
        if (pass !== this.#pass || this.#sources.get(source.owner.sourceKey)?.token !== token)
          break;
        const descriptor: UiCatalogEntry = {
          ...source.owner,
          id: declaration.id,
          kind: declaration.kind,
          title: structuredClone(declaration.title),
          version: 1,
          resourceDigest: "0".repeat(64),
          resourceBytes: 0,
          availability: "unavailable",
        };
        const entry: Entry = { descriptor };
        const quarantine = (code: string, message: string) => {
          descriptor.problem = { code, message };
        };
        if (declaration.resource.version !== 1)
          quarantine("PLUGIN_E_UI_VERSION", "Unsupported UI resource version.");
        else if (!pathValid(declaration.resource.path))
          quarantine("PLUGIN_E_UI_RESOURCE", "Invalid packaged UI resource path.");
        else {
          const allowed = Math.min(
            L.resourceBytes,
            L.sourceBytes - sourceBytes,
            L.hostBytes - hostBytes,
          );
          if (allowed <= 0)
            quarantine("PLUGIN_E_UI_RESOURCE", "UI resource byte budget exhausted.");
          else
            try {
              // Reserve the allowed read window, not an unbounded file. Repeated path references run again.
              const parsed = await budget.run(() =>
                this.#read(source.input, declaration.resource.path, allowed, budget),
              );
              if (pass !== this.#pass || this.#sources.get(source.owner.sourceKey)?.token !== token)
                continue;
              if (parsed.bytes > allowed || parsed.bytes < 0 || !Number.isSafeInteger(parsed.bytes))
                throw new PackagedResourceError("Invalid byte accounting.");
              sourceBytes += parsed.bytes;
              descriptor.resourceBytes = parsed.bytes;
              descriptor.resourceDigest = parsed.digest;
              const validated = this.#validate(
                parsed.value,
                {
                  pluginId: source.owner.pluginId,
                  commands: source.input.commands,
                  panels: source.input.panels,
                },
                parsed.bytes,
              );
              if (!validated.ok) quarantine(validated.error.code, "UI resource validation failed.");
              else if (validated.value.kind !== declaration.kind)
                quarantine("PLUGIN_E_UI_RESOURCE", "UI contribution kind does not match resource.");
              else if (
                uiBytes({
                  owner: source.owner,
                  id: descriptor.id,
                  version: 1,
                  resource: validated.value,
                  validationContext: {
                    pluginId: source.owner.pluginId,
                    commands: source.input.commands,
                    panels: source.input.panels,
                  },
                  rawBytes: parsed.bytes,
                }) > L.resourceReplyBytes
              )
                quarantine("PLUGIN_E_UI_RESOURCE", "UI resource reply exceeds its limit.");
              else {
                entry.resource = validated.value;
                descriptor.availability = "available";
                hostBytes += parsed.bytes;
              }
            } catch {
              if (pass !== this.#pass || this.#sources.get(source.owner.sourceKey)?.token !== token)
                continue;
              quarantine(
                "PLUGIN_E_UI_RESOURCE",
                "UI resource could not be read within its limits.",
              );
            }
        }
        if (pass === this.#pass && this.#sources.get(source.owner.sourceKey)?.token === token)
          source.entries.push(entry);
      }
    }
    if (pass === this.#pass) this.#changed();
  }
  async retry(sourceKey: string): Promise<void> {
    if (!this.#sources.has(sourceKey)) return;
    // Keep every unrelated resource generation and its already admitted bytes.
    const retained = new Map(this.#sources);
    retained.delete(sourceKey);
    await this.#replace(
      [...this.#sources.values()].map((source) => source.input),
      retained,
    );
  }
  retire(owner: ResourceOwner): void {
    const source = this.#sources.get(owner.sourceKey);
    if (!source || !sameResourceOwner(source.input.owner, owner)) return;
    this.#sources.delete(owner.sourceKey);
    this.#changed();
  }
  async catalog(input: { cursor?: Handle }): Promise<Result<UiCatalogPage>> {
    const now = this.#now();
    for (const [handle, cursor] of this.#cursors)
      if (now >= cursor.expires) this.#cursors.delete(handle);
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = this.#cursors.get(input.cursor);
      if (!cursor || cursor.revision !== this.#revision || now >= cursor.expires)
        return resourceFailure("stale");
      offset = cursor.offset;
    }
    const entries = [...this.#sources.values()].flatMap((source) =>
      source.entries.map((entry) => entry.descriptor),
    );
    const selected: UiCatalogEntry[] = [];
    while (offset < entries.length && selected.length < L.catalogEntries) {
      const candidate = entries[offset]!;
      const probe = {
        hostEpoch: this.hostEpoch,
        revision: this.#revision,
        entries: [...selected, candidate],
        nextCursor: randomUUID(),
      };
      if (uiBytes(probe) > L.catalogBytes) break;
      selected.push(candidate);
      offset++;
    }
    if (selected.length === 0 && offset < entries.length)
      return uiFailure("limit", "$", "catalogBytes");
    let nextCursor: Handle | null = null;
    if (offset < entries.length) {
      if (this.#cursors.size >= 256) this.#cursors.delete(this.#cursors.keys().next().value!);
      const cursor = randomUUID();
      nextCursor = cursor;
      this.#cursors.set(cursor, { revision: this.#revision, offset, expires: now + L.cursorMs });
    }
    return {
      ok: true,
      value: {
        hostEpoch: this.hostEpoch,
        revision: this.#revision,
        entries: structuredClone(selected),
        nextCursor,
      },
    };
  }
  async resource(
    input: Parameters<PluginUiBridge["resource"]>[0],
  ): ReturnType<PluginUiBridge["resource"]> {
    const source = this.#sources.get(input.sourceKey);
    const entry = source?.entries.find((entry) => entry.descriptor.id === input.id);
    if (
      !source ||
      !entry ||
      source.owner.uiResourceGeneration !== input.uiResourceGeneration ||
      entry.descriptor.resourceDigest !== input.resourceDigest
    )
      return resourceFailure("stale");
    if (!entry.resource || entry.descriptor.availability !== "available")
      return uiFailure("renderer");
    try {
      this.#beforeDelivery?.(input.sourceKey);
    } catch {
      return uiFailure("read");
    }
    return {
      ok: true,
      value: {
        owner: structuredClone(source.owner),
        id: input.id,
        version: 1,
        resource: structuredClone(entry.resource),
        validationContext: {
          pluginId: source.owner.pluginId,
          commands: structuredClone(source.input.commands),
          panels: structuredClone(source.input.panels),
        },
        rawBytes: entry.descriptor.resourceBytes,
      },
    };
  }
  async reportFailure(
    input: Parameters<PluginUiBridge["reportFailure"]>[0],
  ): ReturnType<PluginUiBridge["reportFailure"]> {
    const source = this.#sources.get(input.sourceKey);
    if (
      !source ||
      source.owner.uiResourceGeneration !== input.uiResourceGeneration ||
      input.catalogRevision !== this.#revision
    )
      return { ok: true, value: { accepted: false } };
    const entry = source.entries.find((entry) => entry.descriptor.id === input.id);
    if (!entry || entry.descriptor.availability === "unavailable")
      return { ok: true, value: { accepted: false } };
    delete entry.resource;
    entry.descriptor.availability = "unavailable";
    entry.descriptor.problem = {
      code: "PLUGIN_E_UI_RESOURCE",
      message: "UI rendering is unavailable; explicit retry is required.",
    };
    this.#changed();
    return { ok: true, value: { accepted: true } };
  }
}
