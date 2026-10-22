import type {
  PanelResourceV1,
  UiBinding,
  UiCatalogEntry,
  UiScalar,
} from "@kobrixa/plugin-protocol";

export type DraftPayload = {
  draft: Record<string, UiScalar>;
  raw: Record<string, string>;
};

// Copy only admitted fields and primitive values. Invalid values remain invalid;
// in particular, a numeric raw "-" and its canonical null travel together.
export function copyDraft(resource: PanelResourceV1, payload: DraftPayload): DraftPayload {
  const draft: [string, UiScalar][] = [];
  const raw: [string, string][] = [];
  for (const [key, field] of Object.entries(resource.fields)) {
    if (!Object.hasOwn(payload.draft, key)) continue;
    const value = payload.draft[key];
    const type = field.schema.type;
    if (!(
      value === null ||
      (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (type === "boolean" && typeof value === "boolean") ||
      ((type === "string" || type === "enum") && typeof value === "string")
    ))
      continue;
    const text = Object.hasOwn(payload.raw, key) ? payload.raw[key] : undefined;
    if (text !== undefined && (typeof text !== "string" || Array.from(text).length > 4000))
      continue;
    draft.push([key, value]);
    if (text !== undefined) raw.push([key, text]);
  }
  return { draft: Object.fromEntries(draft), raw: Object.fromEntries(raw) };
}

type Identity = Pick<
  UiCatalogEntry,
  "sourceKey" | "pluginId" | "id" | "uiResourceGeneration" | "resourceDigest"
> &
  Pick<UiBinding, "hostEpoch" | "generation" | "processEpoch">;
type Cached = { identity: Identity; payload: DraftPayload; bytes: number };
const contribution = (entry: Identity | UiCatalogEntry): string =>
  JSON.stringify([entry.sourceKey, entry.pluginId, entry.id]);
const sameResource = (identity: Identity, entry: UiCatalogEntry, epoch: string | null): boolean =>
  identity.hostEpoch === epoch &&
  contribution(identity) === contribution(entry) &&
  identity.uiResourceGeneration === entry.uiResourceGeneration &&
  identity.resourceDigest === entry.resourceDigest &&
  entry.availability === "available";

// Workbench-local, best-effort memory only. Map insertion order is deterministic LRU.
export class DraftCache {
  private entries = new Map<string, Cached>();
  private bytes = 0;

  private remove(key: string): void {
    const cached = this.entries.get(key);
    if (cached) this.bytes -= cached.bytes;
    this.entries.delete(key);
  }

  drop(entry: UiCatalogEntry): void {
    this.remove(contribution(entry));
  }

  retain(
    entry: UiCatalogEntry,
    binding: UiBinding,
    resource: PanelResourceV1,
    payload: DraftPayload,
  ): void {
    this.drop(entry);
    for (const key of Object.keys(resource.fields)) {
      if (Object.hasOwn(payload.raw, key)) {
        const raw = payload.raw[key];
        if (typeof raw !== "string" || Array.from(raw).length > 4000) return;
      }
    }
    const copy = copyDraft(resource, payload);
    const bytes = new TextEncoder().encode(JSON.stringify(copy)).length;
    if (bytes > 32768) return; // No partial entry or silent truncation to fit a budget.
    while (this.entries.size >= 16 || this.bytes + bytes > 524288) {
      this.remove(this.entries.keys().next().value!);
    }
    const identity: Identity = {
      sourceKey: entry.sourceKey,
      pluginId: entry.pluginId,
      id: entry.id,
      uiResourceGeneration: entry.uiResourceGeneration,
      resourceDigest: entry.resourceDigest,
      hostEpoch: binding.hostEpoch,
      generation: binding.generation,
      processEpoch: binding.processEpoch,
    };
    this.entries.set(contribution(entry), { identity, payload: copy, bytes });
    this.bytes += bytes;
  }

  restore(entry: UiCatalogEntry, binding: UiBinding): DraftPayload | undefined {
    const key = contribution(entry);
    const cached = this.entries.get(key);
    if (!cached) return;
    if (
      !sameResource(cached.identity, entry, binding.hostEpoch) ||
      cached.identity.generation !== binding.generation ||
      cached.identity.processEpoch !== binding.processEpoch
    ) {
      this.remove(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, cached);
    return structuredClone(cached.payload);
  }

  reconcile(entries: readonly UiCatalogEntry[], epoch: string | null): void {
    for (const [key, cached] of this.entries) {
      if (!entries.some((entry) => sameResource(cached.identity, entry, epoch))) this.remove(key);
    }
  }

  withdrawOwners(
    epoch: string,
    owners: readonly Pick<UiCatalogEntry, "sourceKey" | "pluginId" | "uiResourceGeneration">[],
  ): void {
    for (const [key, { identity }] of this.entries) {
      if (
        identity.hostEpoch !== epoch ||
        !owners.some(
          (owner) =>
            owner.sourceKey === identity.sourceKey &&
            owner.pluginId === identity.pluginId &&
            owner.uiResourceGeneration === identity.uiResourceGeneration,
        )
      )
        this.remove(key);
    }
  }

  retireExecution(binding: UiBinding): void {
    for (const [key, { identity }] of this.entries) {
      if (
        identity.hostEpoch === binding.hostEpoch &&
        identity.processEpoch === binding.processEpoch &&
        identity.generation === binding.generation
      )
        this.remove(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
