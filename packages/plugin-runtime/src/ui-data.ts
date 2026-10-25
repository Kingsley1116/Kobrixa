import { createHash, randomUUID } from "node:crypto";
import {
  type ResourceOwner,
  type UiBinding,
  type PanelResourceV2,
  type DatasetDeclarationV2,
  type DatasetHeaderV2,
  type DatasetChunkV2,
  type UiDataRequestMapV2,
  type UiDataResultV2,
  uiDataRequestSchemasV2,
  uiDataFailureSchemaV2,
  jsonRpcRequestSchema,
  validateDatasetDeclarationV2,
  validateDatasetHeaderV2,
  validateDatasetChunkV2,
  validateDatasetV2,
  validateDatasetPanelV2,
  canonicalDatasetV2Bytes,
  canonicalHeaderV2Json,
  canonicalChunkV2Json,
  validateUiDataReadValueV2,
  validateUiDataSnapshotValueV2,
  assertUiDataFrameBudgetV2,
  UiDataValidationErrorV2,
} from "@kobrixa/plugin-protocol";
import { sameResourceOwner, sameUiBinding } from "./ui-host-ports.js";

type Method = keyof UiDataRequestMapV2;
type Params<M extends Method> = UiDataRequestMapV2[M]["params"];
type Value<M extends Method> = Extract<UiDataRequestMapV2[M]["result"], { ok: true }>["value"];
type Metadata = Value<"ui/dataCommit">;
type Entry = DatasetChunkV2["entries"][number];
/** Trusted host state only. registration is a stable identity token replaced on
 * resource replacement. Withdraw retired authority before calling retire/close.
 */
export interface UiDataAuthority {
  owner: ResourceOwner;
  binding: UiBinding;
  registration: object;
  resource: PanelResourceV2;
  version: number;
  ready: boolean;
  panelsPermission: boolean;
  visible: boolean;
  presentation: number;
}
export interface UiDataStorePorts {
  /** Monotonic milliseconds. */
  now(): number;
  resolve(owner: ResourceOwner, binding: UiBinding): UiDataAuthority | null;
  /** Connect to the existing per-panel patch+commit budget (10/s, 4 pending).
   * Synchronous admission; this store has no separate rate bucket. */
  admitCommit(owner: ResourceOwner, binding: UiBinding): "admitted" | "rate" | "queue";
  /** Synchronously enqueue on the existing owner-scoped event bus; must not throw.
   * Queued delivery must revalidate owner/epoch. */
  publish(
    owner: ResourceOwner,
    event: {
      kind: "ui.data";
      data: { binding: UiBinding; dataset: string; revision: number; presentation: number };
    },
  ): void;
}
/** Transport adapter maps these to existing JSON-RPC error replies. */
export class UiDataRpcBoundaryError extends Error {
  constructor(readonly code: -32700 | -32600 | -32601) {
    super("Invalid UI data RPC frame");
  }
}
export class UiDataInvalidParamsError extends Error {
  readonly code = -32602;
  constructor() {
    super("Invalid UI data parameters");
  }
}
class Fault extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
function fail(reason: string): never {
  throw new Fault(reason);
}
const size = (text: string) => new TextEncoder().encode(text).byteLength;
const identity = (o: ResourceOwner, b: UiBinding) =>
  JSON.stringify([
    o.sourceKey,
    o.pluginId,
    o.generation,
    o.hostEpoch,
    o.processEpoch,
    b.contributionId,
    b.panelInstance,
    b.kind,
    b.uiResourceGeneration,
    b.generation,
    b.hostEpoch,
    b.processEpoch,
  ]);
interface Snapshot {
  metadata: Metadata;
  header: DatasetHeaderV2;
  entries: Entry[];
}
interface Transfer {
  handle: string;
  dataset: string;
  created: number;
  progress: number;
  baseRevision: number;
  presentation: number;
  declaration: DatasetDeclarationV2;
  header: DatasetHeaderV2;
  entryCount: number;
  byteLength: number;
  sha256: string;
  entries: Entry[];
  actualBytes: number;
  last?: { offset: number; count: number };
}
interface Receipt {
  dataset: string;
  created: number;
  metadata?: Metadata;
}
interface Panel {
  owner: ResourceOwner;
  binding: UiBinding;
  registration: object;
  committed: Map<string, Snapshot>;
  receiving?: Transfer;
  receipts: Map<string, Receipt>;
}

/** Unpublished synchronous store; lifecycle and transport integration are external.
 * Canonical strings/bytes are temporary validation workspaces, never cached. */
export class UiDataStore {
  private readonly panels = new Map<string, Panel>();
  constructor(private readonly ports: UiDataStorePorts) {}
  private guard<T>(action: () => T): UiDataResultV2<T> {
    try {
      this.sweep();
      return { ok: true, value: action() };
    } catch (error) {
      if (!(error instanceof Fault || error instanceof UiDataValidationErrorV2)) throw error;
      const reason = error.reason;
      const code = ["revision", "expired", "stale"].includes(reason)
        ? "PLUGIN_E_STALE_RESOURCE"
        : ["quota", "rate", "queue"].includes(reason)
          ? "PLUGIN_E_RESOURCE_LIMIT"
          : reason === "version"
            ? "PLUGIN_E_UI_VERSION"
            : reason === "permission"
              ? "PLUGIN_E_PERMISSION_DENIED"
              : "PLUGIN_E_UI_RESOURCE";
      return uiDataFailureSchemaV2.parse({
        ok: false,
        error: {
          code,
          message: "UI data request rejected",
          detail: {
            kind: reason === "permission" ? "permission" : "ui-data",
            reason,
          },
        },
      });
    }
  }
  private parse<M extends Method>(method: M, input: Params<M>): Params<M> {
    const result = uiDataRequestSchemasV2[method].params.safeParse(input);
    if (!result.success) throw new UiDataInvalidParamsError();
    return result.data as Params<M>;
  }
  private authority(owner: ResourceOwner, binding: UiBinding, writing = false): UiDataAuthority {
    const a = this.ports.resolve(structuredClone(owner), structuredClone(binding));
    if (
      !a ||
      !sameResourceOwner(owner, a.owner) ||
      !sameUiBinding(binding, a.binding) ||
      owner.generation !== binding.generation ||
      owner.hostEpoch !== binding.hostEpoch ||
      owner.processEpoch !== binding.processEpoch ||
      !a.ready
    )
      fail("stale");
    if (a.version !== 2) fail("version");
    if (!a.panelsPermission) fail("permission");
    if (a.resource.kind !== "panel" || binding.kind !== "panel" || (writing && !a.visible))
      fail("stale");
    return a;
  }
  private panel(owner: ResourceOwner, binding: UiBinding, a: UiDataAuthority): Panel {
    const key = identity(owner, binding);
    let p = this.panels.get(key);
    if (p && p.registration !== a.registration) {
      this.panels.delete(key);
      p = undefined;
    }
    if (!p) {
      p = {
        owner: structuredClone(owner),
        binding: structuredClone(binding),
        registration: a.registration,
        committed: new Map(),
        receipts: new Map(),
      };
      this.panels.set(key, p);
    }
    return p;
  }
  private declaration(a: UiDataAuthority, dataset: string): DatasetDeclarationV2 {
    const declarations = Object.values(a.resource.datasets);
    if (
      declarations.length > 8 ||
      declarations.filter((d) => d.kind === "chart").length > 4 ||
      declarations.filter((d) => d.kind === "code").length > 1
    )
      fail("quota");
    if (
      !Object.hasOwn(a.resource.datasets, dataset) ||
      ["__proto__", "constructor", "prototype"].includes(dataset)
    )
      fail("reference");
    return validateDatasetDeclarationV2(a.resource.datasets[dataset]);
  }
  private cas(p: Panel, a: UiDataAuthority, dataset: string, base: number, presentation: number) {
    const revision = p.committed.get(dataset)?.metadata.revision ?? 0;
    if (base !== revision || revision >= Number.MAX_SAFE_INTEGER || presentation <= a.presentation)
      fail("revision");
  }
  private budgets(p: Panel, dataset: string, bytes: number, receiving: boolean) {
    let host = 0,
      source = 0,
      panel = 0,
      hostReceiving = 0,
      sourceReceiving = 0;
    for (const current of this.panels.values()) {
      for (const [id, snapshot] of current.committed) {
        if (current === p && id === dataset) continue;
        host += snapshot.metadata.byteLength;
        if (current.owner.sourceKey === p.owner.sourceKey) source += snapshot.metadata.byteLength;
        if (current === p) panel += snapshot.metadata.byteLength;
      }
      if (current.receiving) {
        hostReceiving += current.receiving.byteLength;
        if (current.owner.sourceKey === p.owner.sourceKey)
          sourceReceiving += current.receiving.byteLength;
      }
    }
    if (
      panel + bytes > 524288 ||
      source + bytes > 2097152 ||
      host + bytes > 8388608 ||
      (!p.committed.has(dataset) && p.committed.size >= 8) ||
      (receiving && (hostReceiving + bytes > 2097152 || sourceReceiving + bytes > 524288))
    )
      fail("quota");
  }
  private remaining(t: Transfer) {
    return Math.max(0, Math.min(t.created + 10000, t.progress + 5000) - this.ports.now());
  }
  private finish(p: Panel, t: Transfer, metadata?: Metadata) {
    delete p.receiving;
    p.receipts.set(t.handle, {
      dataset: t.dataset,
      created: t.created,
      ...(metadata ? { metadata } : {}),
    });
    while (p.receipts.size > 4) p.receipts.delete(p.receipts.keys().next().value!);
  }
  /** Also call from a host timer to release idle staging without more requests. */
  sweep(): void {
    const now = this.ports.now();
    for (const p of this.panels.values()) {
      if (p.receiving && this.remaining(p.receiving) === 0) delete p.receiving;
      for (const [handle, receipt] of p.receipts)
        if (now >= receipt.created + 30000) p.receipts.delete(handle);
    }
  }
  private transfer(p: Panel, dataset: string, handle: string): Transfer {
    const t = p.receiving;
    if (!t || t.handle !== handle || t.dataset !== dataset) fail("stale");
    return t;
  }
  begin(
    owner: ResourceOwner,
    input: Params<"ui/dataBegin">,
  ): UiDataResultV2<Value<"ui/dataBegin">> {
    const q = this.parse("ui/dataBegin", input);
    return this.guard(() => {
      const a = this.authority(owner, q.binding, true),
        p = this.panel(owner, q.binding, a);
      const declaration = this.declaration(a, q.dataset);
      const header = validateDatasetHeaderV2(q.header, declaration);
      this.cas(p, a, q.dataset, q.baseRevision, q.presentation);
      if (p.receiving) fail("quota");
      const max =
        header.kind === "chart" ? header.series.length * 800 : header.kind === "code" ? 16384 : 50;
      if (q.entryCount > max) fail("quota");
      const actualBytes = size(canonicalHeaderV2Json(header)) + 5;
      if (q.byteLength < actualBytes) fail("checksum");
      this.budgets(p, q.dataset, q.byteLength, true);
      const now = this.ports.now();
      const t: Transfer = {
        ...q,
        handle: randomUUID(),
        declaration,
        header,
        created: now,
        progress: now,
        entries: [],
        actualBytes,
      };
      p.receiving = t;
      return { transfer: t.handle, nextOffset: 0 as const, remainingMs: this.remaining(t) };
    });
  }
  chunk(
    owner: ResourceOwner,
    input: Params<"ui/dataChunk">,
  ): UiDataResultV2<Value<"ui/dataChunk">> {
    const q = this.parse("ui/dataChunk", input);
    return this.guard(() => {
      const a = this.authority(owner, q.binding, true),
        p = this.panel(owner, q.binding, a);
      const t = this.transfer(p, q.dataset, q.transfer);
      if (q.offset !== t.entries.length && q.offset !== t.last?.offset) fail("offset");
      try {
        const chunk = validateDatasetChunkV2(q.chunk, t.header, t.declaration);
        const canonical = canonicalChunkV2Json(chunk);
        if (q.offset === t.last?.offset) {
          const previous = canonicalChunkV2Json({
            kind: t.header.kind,
            entries: t.entries.slice(t.last.offset, t.last.offset + t.last.count),
          });
          if (canonical !== previous) fail("offset");
          return { nextOffset: t.entries.length, remainingMs: this.remaining(t) };
        }
        const entries = (JSON.parse(canonical) as DatasetChunkV2).entries;
        if (!entries.length) fail("offset");
        if (t.entries.length + entries.length > t.entryCount) fail("checksum");
        let bytes = t.actualBytes;
        for (const [i, entry] of entries.entries())
          bytes += size(JSON.stringify(entry)) + (t.entries.length + i > 0 ? 1 : 0);
        if (bytes > t.byteLength) fail("checksum");
        if (t.header.kind === "table" || t.header.kind === "list") {
          const keys = [...t.entries, ...entries].map((e) => (e as { key: string }).key);
          if (new Set(keys).size !== keys.length) fail("schema");
        }
        t.last = { offset: t.entries.length, count: entries.length };
        t.entries.push(...entries);
        t.actualBytes = bytes;
        t.progress = this.ports.now();
        return { nextOffset: t.entries.length, remainingMs: this.remaining(t) };
      } catch (error) {
        if (!(error instanceof Fault && error.reason === "offset")) this.finish(p, t);
        throw error;
      }
    });
  }
  commit(owner: ResourceOwner, input: Params<"ui/dataCommit">): UiDataResultV2<Metadata> {
    const q = this.parse("ui/dataCommit", input);
    return this.guard(() => {
      let a = this.authority(owner, q.binding);
      const p = this.panel(owner, q.binding, a),
        receipt = p.receipts.get(q.transfer);
      if (receipt?.dataset === q.dataset && receipt.metadata)
        return structuredClone(receipt.metadata);
      if (!a.visible) fail("stale");
      const t = this.transfer(p, q.dataset, q.transfer);
      const validate = () => {
        this.cas(p, a, q.dataset, t.baseRevision, t.presentation);
        const declaration = this.declaration(a, q.dataset);
        if (JSON.stringify(declaration) !== JSON.stringify(t.declaration)) fail("reference");
        this.budgets(p, q.dataset, t.byteLength, false);
      };
      validate();
      try {
        if (t.entries.length !== t.entryCount || t.actualBytes !== t.byteLength) fail("checksum");
        validateDatasetV2(t.declaration, t.header, t.entries);
        const bytes = canonicalDatasetV2Bytes(t.header, t.entries);
        if (
          bytes.byteLength !== t.byteLength ||
          createHash("sha256").update(bytes).digest("hex") !== t.sha256
        )
          fail("checksum");
        validateDatasetPanelV2([
          ...[...p.committed]
            .filter(([id]) => id !== q.dataset)
            .map(([id, s]) => ({
              declaration: this.declaration(a, id),
              header: s.header,
              entries: s.entries as DatasetChunkV2["entries"],
            })),
          {
            declaration: t.declaration,
            header: t.header,
            entries: t.entries as DatasetChunkV2["entries"],
          },
        ]);
      } catch (error) {
        this.finish(p, t);
        throw error;
      }
      const admission = this.ports.admitCommit(structuredClone(owner), structuredClone(q.binding));
      // Admission can synchronously hide/retire/reenter, so recheck before swapping.
      this.sweep();
      a = this.authority(owner, q.binding, true);
      if (
        this.panels.get(identity(owner, q.binding)) !== p ||
        p.registration !== a.registration ||
        p.receiving !== t
      )
        fail("stale");
      validate();
      if (admission !== "admitted") fail(admission);
      const metadata: Metadata = {
        revision: t.baseRevision + 1,
        presentation: t.presentation,
        byteLength: t.byteLength,
        sha256: t.sha256,
      };
      p.committed.set(q.dataset, { metadata, header: t.header, entries: t.entries });
      this.finish(p, t, metadata);
      this.ports.publish(structuredClone(owner), {
        kind: "ui.data",
        data: {
          binding: structuredClone(q.binding),
          dataset: q.dataset,
          revision: metadata.revision,
          presentation: metadata.presentation,
        },
      });
      return structuredClone(metadata);
    });
  }
  abort(
    owner: ResourceOwner,
    input: Params<"ui/dataAbort">,
  ): UiDataResultV2<Value<"ui/dataAbort">> {
    const q = this.parse("ui/dataAbort", input);
    return this.guard(() => {
      const a = this.authority(owner, q.binding),
        p = this.panel(owner, q.binding, a);
      if (p.receipts.get(q.transfer)?.dataset === q.dataset) return { aborted: false };
      this.finish(p, this.transfer(p, q.dataset, q.transfer));
      return { aborted: true };
    });
  }
  read(owner: ResourceOwner, input: Params<"ui/dataRead">): UiDataResultV2<Value<"ui/dataRead">> {
    const q = this.parse("ui/dataRead", input);
    return this.guard(() => {
      const a = this.authority(owner, q.binding),
        p = this.panel(owner, q.binding, a);
      this.declaration(a, q.dataset);
      const s = p.committed.get(q.dataset);
      if (!s || s.metadata.revision !== q.revision) fail("revision");
      if (q.offset > s.entries.length) fail("offset");
      let count = Math.min(q.limit, s.entries.length - q.offset);
      for (;;) {
        try {
          return validateUiDataReadValueV2(
            {
              ...s.metadata,
              header: s.header,
              chunk: { kind: s.header.kind, entries: s.entries.slice(q.offset, q.offset + count) },
              nextOffset: q.offset + count,
              done: q.offset + count === s.entries.length,
            },
            q,
          );
        } catch (error) {
          if (!(error instanceof UiDataValidationErrorV2) || error.reason !== "quota" || count <= 1)
            throw error;
          count--;
        }
      }
    });
  }
  snapshot(
    owner: ResourceOwner,
    input: Params<"ui/dataSnapshot">,
  ): UiDataResultV2<Value<"ui/dataSnapshot">> {
    const q = this.parse("ui/dataSnapshot", input);
    return this.guard(() => {
      const a = this.authority(owner, q.binding),
        p = this.panel(owner, q.binding, a);
      return validateUiDataSnapshotValueV2({
        datasets: [...p.committed].map(([dataset, s]) => ({ dataset, ...s.metadata })),
      });
    });
  }
  invalidateHide(owner: ResourceOwner, binding: UiBinding): void {
    this.sweep();
    const p = this.panels.get(identity(owner, binding));
    if (p?.receiving) this.finish(p, p.receiving);
  }
  close(owner: ResourceOwner, binding: UiBinding): void {
    this.panels.delete(identity(owner, binding));
  }
  /** Resource replacement: close the old binding. Process retirement: retire its
   * complete owner. Host retirement: retireHost(oldHostEpoch). */
  retire(owner: ResourceOwner): void {
    for (const [key, p] of this.panels)
      if (sameResourceOwner(owner, p.owner)) this.panels.delete(key);
  }
  retireHost(hostEpoch: string): void {
    for (const [key, p] of this.panels)
      if (p.owner.hostEpoch === hostEpoch) this.panels.delete(key);
  }
  /** Raw boundary measures original bytes. Typed entry points require the caller
   * to enforce this boundary before parsing, including the complete RPC envelope. */
  requestFrame(owner: ResourceOwner, frame: string | Uint8Array): string {
    assertUiDataFrameBudgetV2(frame);
    let raw: unknown;
    try {
      raw = JSON.parse(
        typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame),
      );
    } catch {
      throw new UiDataRpcBoundaryError(-32700);
    }
    const parsed = jsonRpcRequestSchema.safeParse(raw);
    if (!parsed.success) throw new UiDataRpcBoundaryError(-32600);
    const q = parsed.data;
    let result: UiDataResultV2<unknown>;
    switch (q.method) {
      case "ui/dataBegin":
        result = this.begin(owner, q.params as Params<"ui/dataBegin">);
        break;
      case "ui/dataChunk":
        result = this.chunk(owner, q.params as Params<"ui/dataChunk">);
        break;
      case "ui/dataCommit":
        result = this.commit(owner, q.params as Params<"ui/dataCommit">);
        break;
      case "ui/dataAbort":
        result = this.abort(owner, q.params as Params<"ui/dataAbort">);
        break;
      case "ui/dataRead":
        result = this.read(owner, q.params as Params<"ui/dataRead">);
        break;
      case "ui/dataSnapshot":
        result = this.snapshot(owner, q.params as Params<"ui/dataSnapshot">);
        break;
      default:
        throw new UiDataRpcBoundaryError(-32601);
    }
    const response = JSON.stringify({ jsonrpc: "2.0", id: q.id, result });
    assertUiDataFrameBudgetV2(response);
    return response;
  }
}
