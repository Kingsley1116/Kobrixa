import {
  canonicalDatasetV2Bytes,
  chartTimeDomainsMatchV2,
  validateDatasetDeclarationV2,
  validateDatasetPanelV2,
  validateDatasetV2,
  validateUiDataReadValueV2,
  validateUiDataSnapshotValueV2,
  type ChartHeaderV2,
  type DatasetDeclarationV2,
  type DatasetHeaderV2,
  type DatasetV2,
  type UiBinding,
  type UiDataRequestMapV2,
} from "@kobrixa/plugin-protocol";

type Read = UiDataRequestMapV2["ui/dataRead"];
type Snapshot = UiDataRequestMapV2["ui/dataSnapshot"];
type Metadata = Extract<Snapshot["result"], { ok: true }>["value"]["datasets"][number];
export interface UiDatasetReadPort {
  snapshot(binding: UiBinding, signal: AbortSignal): Promise<Snapshot["result"]>;
  read(params: Read["params"], signal: AbortSignal): Promise<Read["result"]>;
}
export type UiDatasetView = Readonly<{
  active: boolean;
  loading: boolean;
  unavailable: boolean;
  presentation: number;
}>;
type Cached = { metadata: Metadata; data: DatasetV2 };
const encoder = new TextEncoder();
const equalMetadata = (a: Metadata, b: Metadata) =>
  a.dataset === b.dataset &&
  a.revision === b.revision &&
  a.presentation === b.presentation &&
  a.byteLength === b.byteLength &&
  a.sha256 === b.sha256;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One binding's bounded renderer cache. This is a read-only consumer of the
 * host data plane; it never starts transfers or treats a UUID as authority.
 * Dialogs share this instance, rather than retaining another full dataset copy.
 */
export class UiDatasetStore {
  readonly #binding: Read["params"]["binding"];
  readonly #declarations = new Map<string, DatasetDeclarationV2>();
  readonly #cache = new Map<string, Cached>();
  readonly #listeners = new Set<() => void>();
  #view: UiDatasetView = Object.freeze({
    active: true,
    loading: false,
    unavailable: false,
    presentation: 0,
  });
  #generation = 0;
  #wanted = false;
  #running: Promise<void> | undefined;
  #request: AbortController | undefined;

  constructor(
    binding: UiBinding,
    declarations: Readonly<Record<string, DatasetDeclarationV2>>,
    private readonly port: UiDatasetReadPort,
  ) {
    if (binding.kind !== "panel") throw new TypeError("Dataset binding must be a panel.");
    this.#binding = { ...binding, kind: "panel" };
    const entries = Object.entries(declarations);
    if (entries.length > 8) throw new TypeError("Too many datasets.");
    for (const [id, declaration] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(id))
        throw new TypeError("Invalid dataset id.");
      this.#declarations.set(id, validateDatasetDeclarationV2(declaration));
    }
  }
  getSnapshot = (): UiDatasetView => this.#view;
  subscribe = (listener: () => void): (() => void) => {
    if (!this.#view.active) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(next: Partial<UiDatasetView>): void {
    this.#view = Object.freeze({ ...this.#view, ...next });
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A subscriber cannot prevent revocation or another subscriber's update.
      }
    }
  }
  setPresentation(presentation: number): void {
    if (!this.#view.active) return;
    if (!Number.isSafeInteger(presentation) || presentation < this.#view.presentation)
      throw new TypeError("Invalid presentation revision.");
    if (presentation !== this.#view.presentation) this.#update({ presentation });
  }
  dataset(id: string): DatasetV2 | undefined {
    const cached = this.#cache.get(id);
    return this.#view.active &&
      !this.#view.unavailable &&
      cached?.metadata.presentation === this.#view.presentation &&
      this.#view.presentation > 0
      ? cached.data
      : undefined;
  }
  chartGroup(ids: readonly string[]): readonly ChartHeaderV2[] | undefined {
    if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length) return;
    const headers: ChartHeaderV2[] = [];
    for (const id of ids) {
      const header = this.dataset(id)?.header;
      if (!header || header.kind !== "chart") return;
      headers.push(header);
    }
    return chartTimeDomainsMatchV2(headers) ? Object.freeze(headers) : undefined;
  }
  invalidate(): Promise<void> {
    if (!this.#view.active) return Promise.resolve();
    this.#generation++;
    this.#wanted = true;
    this.#request?.abort();
    if (!this.#running) {
      this.#running = Promise.resolve()
        .then(() => this.#drain())
        .finally(() => {
          this.#running = undefined;
          if (this.#wanted && this.#view.active) return this.invalidate();
        });
    }
    return this.#running;
  }
  async #call<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.#view.active) throw new Error("Dataset binding retired.");
    const controller = new AbortController();
    this.#request = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Data read ended.")), {
        once: true,
      });
      timer = setTimeout(() => controller.abort(), 5000);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return run(controller.signal);
        }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      if (this.#request === controller) this.#request = undefined;
    }
  }
  #current(generation: number): boolean {
    return this.#view.active && generation === this.#generation;
  }
  async #drain(): Promise<void> {
    while (this.#wanted && this.#view.active) {
      this.#wanted = false;
      const generation = this.#generation;
      this.#update({ loading: true });
      try {
        await this.#load(generation);
        if (this.#current(generation)) this.#update({ unavailable: false });
      } catch {
        if (this.#current(generation)) this.#update({ unavailable: true });
      }
    }
    if (this.#view.active) this.#update({ loading: false });
  }
  async #load(generation: number): Promise<void> {
    const reply = await this.#call((signal) => this.port.snapshot({ ...this.#binding }, signal));
    if (!this.#current(generation)) return;
    if (!reply.ok) throw new Error("Data snapshot unavailable.");
    const metadata = validateUiDataSnapshotValueV2(reply.value).datasets;
    if (
      metadata.reduce((sum, item) => sum + item.byteLength, 0) > 524288 ||
      metadata.some((item) => !this.#declarations.has(item.dataset))
    )
      throw new Error("Invalid data snapshot.");
    for (const item of metadata) {
      const old = this.#cache.get(item.dataset)?.metadata;
      if (
        old &&
        (item.revision < old.revision ||
          (item.revision === old.revision && !equalMetadata(item, old)))
      )
        throw new Error("Data revision changed unexpectedly.");
    }
    // Drop replaced/removed payloads before receiving their replacement. Only one
    // bounded staging dataset exists; dialogs and views never duplicate this cache.
    for (const [id, cached] of this.#cache) {
      if (!metadata.some((item) => equalMetadata(item, cached.metadata))) this.#cache.delete(id);
    }
    this.#update({});
    for (const item of metadata) {
      if (!this.#current(generation)) return;
      if (this.#cache.has(item.dataset)) continue;
      let offset = 0;
      let header: DatasetHeaderV2 | undefined;
      const entries: unknown[] = [];
      let entryBytes = 0;
      for (;;) {
        const input: Read["params"] = {
          binding: { ...this.#binding },
          dataset: item.dataset,
          revision: item.revision,
          offset,
          limit: 256,
        };
        const response = await this.#call((signal) => this.port.read(input, signal));
        if (!this.#current(generation)) return;
        if (!response.ok) throw new Error("Data page unavailable.");
        const page = validateUiDataReadValueV2(response.value, input);
        if (
          !equalMetadata(item, { dataset: item.dataset, ...page }) ||
          (header && JSON.stringify(header) !== JSON.stringify(page.header))
        )
          throw new Error("Data page changed during read.");
        header = page.header;
        for (const entry of page.chunk.entries) {
          entryBytes += encoder.encode(JSON.stringify(entry)).byteLength;
          if (entryBytes > item.byteLength || entries.length >= 16384)
            throw new Error("Data page exceeds snapshot budget.");
          entries.push(entry);
        }
        offset = page.nextOffset;
        if (page.done) break;
      }
      const data = validateDatasetV2(this.#declarations.get(item.dataset)!, header, entries);
      const bytes = canonicalDatasetV2Bytes(data.header, data.entries);
      if (bytes.byteLength !== item.byteLength) throw new Error("Data byte length mismatch.");
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
      );
      if (!this.#current(generation)) return;
      const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== item.sha256) throw new Error("Data checksum mismatch.");
      validateDatasetPanelV2([
        ...Array.from(this.#cache, ([id, cached]) => ({
          declaration: this.#declarations.get(id)!,
          ...cached.data,
        })),
        { declaration: this.#declarations.get(item.dataset)!, ...data },
      ]);
      this.#cache.set(item.dataset, freeze({ metadata: item, data }));
      this.#update({});
    }
  }
  retire(): void {
    if (!this.#view.active) return;
    this.#generation++;
    this.#wanted = false;
    this.#request?.abort();
    this.#cache.clear();
    this.#update({ active: false, loading: false, unavailable: true });
    this.#listeners.clear();
  }
}
