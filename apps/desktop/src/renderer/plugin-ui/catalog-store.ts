import type { PluginUiBridge, UiBridgeEvent, FoundationDiagnostics } from "@kobrixa/plugin-runtime";
import type { UiCatalogEntry, UiOwner } from "@kobrixa/plugin-protocol";
export const contributionKey = (entry: Pick<UiCatalogEntry, "sourceKey" | "id">): string =>
  JSON.stringify([entry.sourceKey, entry.id]);
const ownerKey = (owner: UiOwner): string =>
  JSON.stringify([owner.sourceKey, owner.pluginId, owner.uiResourceGeneration]);
const resourceKey = (entry: UiCatalogEntry): string =>
  JSON.stringify([contributionKey(entry), ownerKey(entry), entry.resourceDigest]);
export function bounded<T>(work: Promise<T>, milliseconds = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UI response deadline")), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
export function send(work: () => Promise<unknown>): void {
  try {
    void work().catch(() => {});
  } catch {
    /* synchronous adapter failure cannot interrupt revocation */
  }
}
type Resource = Extract<Awaited<ReturnType<PluginUiBridge["resource"]>>, { ok: true }>["value"];
const catalogs = new WeakSet<object>();
export function catalogDiagnostics(instance: object): FoundationDiagnostics | undefined {
  if (!catalogs.has(instance)) return undefined;
  const catalog = instance as UiCatalogStore;
  return Object.freeze({
    snapshot: () =>
      Object.freeze({
        owners: 0,
        bindings: 0,
        subscriptions: 0,
        queuedEvents: 0,
        queuedBytes: 0,
        timers: catalog.timerCount(),
        pendingInvocations: 0,
        actionTokens: 0,
        resourceReaders: 0,
        workerJobs: 0,
      }),
    onEvent: (_listener: Parameters<FoundationDiagnostics["onEvent"]>[0]) => () => {},
  });
}
export class UiCatalogStore {
  private cancellations = new Set<() => void>();
  timerCount(): number {
    return this.cancellations.size;
  }
  wait<T>(work: Promise<T>, milliseconds = 5000): Promise<T> {
    if (this.dead) return Promise.reject(new Error("Catalog disposed"));
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.cancellations.delete(cancel);
      };
      const cancel = () => {
        finish();
        reject(new Error("UI response deadline/disposal"));
      };
      const timer = setTimeout(cancel, milliseconds);
      this.cancellations.add(cancel);
      work.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  }
  private view: {
    phase: "loading" | "ready" | "failed";
    epoch: string | null;
    revision: number;
    entries: readonly UiCatalogEntry[];
  } = {
    phase: "loading",
    epoch: null,
    revision: -1,
    entries: [],
  };
  private listeners = new Set<() => void>();
  private resources = new Map<string, Promise<Resource | null>>();
  private owners: Set<string> | null = null;
  private target = -1;
  private retiredEpochs = new Set<string>();
  private serial = 0;
  private dead = false;
  private off: (() => void) | undefined;
  private flight: Promise<void> | undefined;
  private again = false;
  private started = false;
  private initialDeadline: number | undefined;
  private initialExpired = false;
  constructor(
    private api: Pick<PluginUiBridge, "catalog" | "resource" | "onEvent">,
    private immediate: (event: UiBridgeEvent) => void,
  ) {
    catalogs.add(this);
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  retainedReaders(): number {
    return this.resources.size;
  }
  current(entry: UiCatalogEntry): boolean {
    return !this.dead && this.view.entries.some((item) => resourceKey(item) === resourceKey(entry));
  }
  start(): Promise<void> {
    if (this.dead) return Promise.resolve();
    if (!this.started) {
      this.started = true;
      this.initialDeadline = Date.now() + 5000;
    }
    if (!this.off)
      this.off = this.api.onEvent((event) => {
        if (this.dead) return;
        if (event.type === "catalog") {
          if (this.retiredEpochs.has(event.hostEpoch)) return;
          if (event.hostEpoch === this.view.epoch && event.revision < this.target) return;
          if (event.hostEpoch !== this.view.epoch) {
            if (this.view.epoch) this.retiredEpochs.add(this.view.epoch);
            this.target = -1;
            this.resources.clear();
          }
          this.target = Math.max(this.target, event.revision);
          this.initialExpired = false;
          this.owners = new Set(event.owners.map(ownerKey));
          this.serial++;
          const entries =
            event.hostEpoch === this.view.epoch
              ? this.view.entries.filter((entry) => this.owners!.has(ownerKey(entry)))
              : [];
          const keep = new Set(entries.map(resourceKey));
          for (const key of this.resources.keys()) if (!keep.has(key)) this.resources.delete(key);
          this.view = { ...this.view, phase: "loading", epoch: event.hostEpoch, entries };
          this.immediate(event);
          this.publish();
          void this.refresh();
        } else this.immediate(event);
      });
    return this.refresh();
  }
  expireBootstrap(): void {
    if (this.dead || this.initialDeadline === undefined) return;
    this.initialDeadline = undefined;
    this.initialExpired = true;
    this.serial++;
    this.again = false;
    this.view = { ...this.view, phase: "failed", entries: [] };
    this.publish();
  }
  refresh(): Promise<void> {
    if (this.dead || this.initialExpired) return Promise.resolve();
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    this.flight = (async () => {
      do {
        this.again = false;
        const serial = this.serial;
        try {
          let cursor: string | undefined;
          let epoch: string | undefined;
          let revision = -1;
          const entries: UiCatalogEntry[] = [];
          const cursors = new Set<string>();
          const ids = new Set<string>();
          let bytes = 0;
          do {
            // All initial pages (including revision retries) share one bootstrap budget.
            const remaining =
              this.initialDeadline === undefined ? 5000 : this.initialDeadline - Date.now();
            if (remaining <= 0) throw new Error("UI bootstrap deadline");
            const result = await this.wait(
              this.api.catalog(cursor === undefined ? {} : { cursor }),
              remaining,
            );
            if (this.dead || serial !== this.serial) break;
            if (this.initialDeadline !== undefined && Date.now() >= this.initialDeadline)
              throw new Error("UI bootstrap deadline");
            if (!result.ok) throw new Error(result.error.code);
            const value = result.value;
            if (
              value.entries.length > 16 ||
              new TextEncoder().encode(JSON.stringify(value)).length > 262144
            )
              throw new Error("Catalog page limit");
            if (epoch !== undefined && (epoch !== value.hostEpoch || revision !== value.revision))
              throw new Error("Catalog changed during paging");
            epoch = value.hostEpoch;
            revision = value.revision;
            if (this.view.epoch !== null && (epoch !== this.view.epoch || revision < this.target))
              throw new Error("Stale catalog");
            for (const entry of value.entries) {
              if (ids.has(contributionKey(entry))) throw new Error("Duplicate contribution");
              ids.add(contributionKey(entry));
              entries.push(entry);
              bytes += entry.resourceBytes;
            }
            if (
              entries.filter((entry) => entry.kind === "panel").length > 16 ||
              entries.filter((entry) => entry.kind === "status").length > 16 ||
              bytes > 8388608
            )
              throw new Error("Catalog limit");
            for (const sourceKey of new Set(entries.map((entry) => entry.sourceKey))) {
              const own = entries.filter((entry) => entry.sourceKey === sourceKey);
              if (
                own.filter((entry) => entry.kind === "panel").length > 4 ||
                own.filter((entry) => entry.kind === "status").length > 2 ||
                own.reduce((sum, entry) => sum + entry.resourceBytes, 0) > 1048576
              )
                throw new Error("Source catalog limit");
            }
            cursor = value.nextCursor ?? undefined;
            if (cursor) {
              if (cursors.has(cursor)) throw new Error("Cursor cycle");
              cursors.add(cursor);
            }
          } while (cursor !== undefined);
          if (this.dead || serial !== this.serial) continue;
          if (epoch === undefined) throw new Error("Empty catalog response");
          if (this.owners && entries.some((entry) => !this.owners!.has(ownerKey(entry))))
            throw new Error("Retired owner");
          this.target = revision;
          this.view = { phase: "ready", epoch, revision, entries };
          this.publish();
        } catch {
          if (this.initialDeadline !== undefined && Date.now() >= this.initialDeadline) {
            this.expireBootstrap();
          } else if (!this.dead && serial === this.serial) {
            this.view = { ...this.view, phase: "failed" };
            this.publish();
          }
        }
      } while (this.again && !this.dead);
    })().finally(() => {
      this.flight = undefined;
      this.initialDeadline = undefined;
    });
    return this.flight;
  }
  resource(entry: UiCatalogEntry): Promise<Resource | null> {
    if (!this.current(entry) || entry.availability !== "available") return Promise.resolve(null);
    const key = resourceKey(entry);
    const cached = this.resources.get(key);
    if (cached) return cached;
    const epoch = this.view.epoch;
    const work = this.wait(
      Promise.resolve().then(() =>
        this.api.resource({
          sourceKey: entry.sourceKey,
          id: entry.id,
          uiResourceGeneration: entry.uiResourceGeneration,
          resourceDigest: entry.resourceDigest,
        }),
      ),
    ).then(
      (result) => {
        if (!this.current(entry) || epoch !== this.view.epoch || !result.ok) return null;
        const value = result.value;
        if (
          new TextEncoder().encode(JSON.stringify(value)).length > 524288 ||
          value.version !== 1 ||
          value.id !== entry.id ||
          ownerKey(value.owner) !== ownerKey(entry) ||
          value.resource.kind !== entry.kind
        )
          return null;
        return value;
      },
      () => null,
    );
    this.resources.set(key, work);
    return work;
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.serial++;
    this.off?.();
    this.off = undefined;
    for (const cancel of [...this.cancellations]) cancel();
    this.resources.clear();
    this.listeners.clear();
  }
}
