import type { PluginUiBridge, UiBridgeEvent } from "@kobrixa/plugin-runtime";
import type {
  UiCatalogEntry,
  UiBinding,
  PanelResourceV1,
  StatusResourceV1,
} from "@kobrixa/plugin-protocol";
import { validateUiResource, type UiValidationContext } from "@kobrixa/plugin-protocol";
import { contributionKey, send, UiCatalogStore } from "./catalog-store.js";
import { bindingKey, UiStateStore } from "./state-store.js";
import { UiIntentController } from "./intent-controller.js";
import { DraftCache } from "./draft-cache.js";
export type PanelRecord = {
  entry: UiCatalogEntry;
  resource: PanelResourceV1 | StatusResourceV1;
  state: UiStateStore;
  intent: UiIntentController;
};
type VisibilityReason = Parameters<PluginUiBridge["visibility"]>[0]["reason"];
const kinds = new Set([
  "group",
  "text",
  "help",
  "textInput",
  "number",
  "range",
  "choice",
  "boolean",
  "action",
  "holdAction",
  "status",
  "alert",
  "progress",
  "keyValue",
]);
export function assertRenderable(
  resource: PanelResourceV1 | StatusResourceV1,
  validationContext: UiValidationContext,
  rawBytes: number,
): void {
  const measured = new TextEncoder().encode(JSON.stringify(resource)).length;
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0)
    throw new Error("Invalid admitted byte count");
  const validated = validateUiResource(resource, validationContext, Math.max(rawBytes, measured));
  if (!validated.ok) throw new Error(validated.error.code);
  if (new TextEncoder().encode(JSON.stringify(resource)).length > 262144)
    throw new Error("UI resource budget");
  if (resource.kind === "status") {
    if ("nodes" in resource || "action" in resource || "actions" in resource)
      throw new Error("Status cannot contain actions");
    return;
  }
  if (
    resource.kind !== "panel" ||
    resource.nodes.length > 256 ||
    Object.keys(resource.fields).length > 32 ||
    Object.keys(resource.data).length > 64
  )
    throw new Error("UI tree budget");
  const nodes = new Map(resource.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const node = nodes.get(id);
    if (!node || !kinds.has(node.type) || seen.has(id) || depth > 8)
      throw new Error("Invalid UI tree");
    seen.add(id);
    if ("field" in node && !Object.hasOwn(resource.fields, node.field))
      throw new Error("Invalid UI field");
    if (node.type === "group") node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(resource.root, 1);
  if (seen.size !== resource.nodes.length) throw new Error("Orphan or duplicate UI node");
}
export class RendererSession {
  readonly catalog: UiCatalogStore;
  private records = new Map<string, PanelRecord>();
  private drafts = new DraftCache();
  private opening = new Map<string, Promise<void>>();
  private failures = new Set<string>();
  private unavailableStatus = new Set<string>();
  private statusPending = new Set<string>();
  private statusEvents = new Map<string, Extract<UiBridgeEvent, { type: "state" }>>();
  private offCatalog: () => void;
  private listeners = new Set<() => void>();
  private revision = 0;
  private ready: Promise<void> | undefined;
  private dead = false;
  private serial = 0;
  private pane = false;
  private selected: string | null = null;
  private recoveryRequest = 0;
  private documentVisible = true;
  private focused = true;
  constructor(readonly bridge: PluginUiBridge) {
    this.catalog = new UiCatalogStore(bridge, (event) => this.event(event));
    this.offCatalog = this.catalog.subscribe(() => {
      const catalog = this.catalog.getSnapshot();
      if (catalog.phase === "ready") {
        this.drafts.reconcile(catalog.entries, catalog.epoch);
        for (const record of [...this.records.values()])
          if (
            !this.catalog.current(record.entry) ||
            !catalog.entries.some(
              (entry) =>
                contributionKey(entry) === contributionKey(record.entry) &&
                entry.availability === "available",
            )
          )
            this.remove(record.entry);
      }
      if (catalog.phase === "ready")
        for (const [key, event] of this.statusEvents) {
          if (
            !catalog.entries.some(
              (item) =>
                item.kind === "status" &&
                item.id === event.binding.contributionId &&
                item.uiResourceGeneration === event.binding.uiResourceGeneration,
            )
          )
            this.statusEvents.delete(key);
        }
      for (const event of this.statusEvents.values()) void this.adoptStatus(event);
    });
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): number => this.revision;
  private publish(): void {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  record(entry: UiCatalogEntry): PanelRecord | undefined {
    return this.records.get(contributionKey(entry));
  }
  selectedKey(): string | null {
    return this.selected;
  }
  getRecoveryRequest = (): number => this.recoveryRequest;
  statusUnavailable(entry: UiCatalogEntry): boolean {
    return this.unavailableStatus.has(contributionKey(entry));
  }
  failed(entry: UiCatalogEntry): boolean {
    return this.failures.has(this.failureKey(entry));
  }
  private failureKey(entry: UiCatalogEntry): string {
    return JSON.stringify([
      this.catalog.getSnapshot().epoch,
      contributionKey(entry),
      entry.uiResourceGeneration,
      entry.resourceDigest,
    ]);
  }
  start(): Promise<void> {
    return (this.ready ??= this.catalog.start());
  }
  showPane(visible: boolean, reason: VisibilityReason): void {
    this.pane = visible;
    if (!visible) this.serial++;
    for (const [key, record] of this.records)
      if (record.entry.kind === "panel")
        void record.intent.visibility(
          visible && this.documentVisible && this.focused && key === this.selected,
          reason,
        );
    this.publish();
  }
  select(entry: UiCatalogEntry): void {
    this.serial++;
    this.selected = contributionKey(entry);
    for (const [key, record] of this.records)
      if (record.entry.kind === "panel")
        void record.intent.visibility(
          this.pane && this.documentVisible && this.focused && key === this.selected,
          "tab",
        );
    this.publish();
  }
  environment(visible: boolean, focused: boolean, reason: "document" | "window"): void {
    this.documentVisible = visible;
    this.focused = focused;
    if (!visible || !focused) this.serial++;
    for (const [key, record] of this.records) {
      record.intent.focus(focused);
      void record.intent.visibility(
        visible &&
          focused &&
          (record.entry.kind === "status" || (this.pane && key === this.selected)),
        reason,
      );
    }
  }
  async setVisibility(
    binding: UiBinding,
    visible: boolean,
    reason: VisibilityReason,
  ): Promise<void> {
    const record = [...this.records.values()].find(
      (item) => bindingKey(item.state.form().binding) === bindingKey(binding),
    );
    if (record) await record.intent.visibility(visible, reason);
  }
  open(entry: UiCatalogEntry): Promise<void> {
    const key = contributionKey(entry);
    const pending = this.opening.get(key);
    if (pending) return pending;
    if (
      this.dead ||
      !this.pane ||
      !this.focused ||
      !this.documentVisible ||
      this.failed(entry) ||
      !this.catalog.current(entry) ||
      entry.kind !== "panel"
    )
      return Promise.resolve();
    this.select(entry);
    if (this.records.has(key)) return Promise.resolve();
    const serial = this.serial;
    const work = (async () => {
      const admitted = await this.catalog.resource(entry);
      const resource = admitted?.resource;
      if (this.dead || !this.catalog.current(entry) || serial !== this.serial) return;
      if (!resource) {
        this.failures.add(this.failureKey(entry));
        this.publish();
        return;
      }
      try {
        assertRenderable(resource, admitted!.validationContext, admitted!.rawBytes);
      } catch {
        this.quarantine(entry, "validation");
        return;
      }
      try {
        const result = await this.bridge.open({
          sourceKey: entry.sourceKey,
          id: entry.id,
          uiResourceGeneration: entry.uiResourceGeneration,
        });
        if (!result.ok) {
          this.failures.add(this.failureKey(entry));
          this.publish();
          return;
        }
        if (
          this.dead ||
          !this.pane ||
          serial !== this.serial ||
          !this.catalog.current(entry) ||
          result.value.binding.contributionId !== entry.id ||
          result.value.binding.kind !== "panel" ||
          result.value.binding.uiResourceGeneration !== entry.uiResourceGeneration ||
          result.value.binding.hostEpoch !== this.catalog.getSnapshot().epoch
        ) {
          send(() => this.bridge.close({ binding: result.value.binding }));
          return;
        }
        const state = new UiStateStore(
          this.bridge,
          resource as PanelResourceV1,
          result.value,
          this.drafts.restore(entry, result.value.binding),
        );
        state.setDiagnosticOwner({
          sourceKey: entry.sourceKey,
          pluginId: entry.pluginId,
          generation: result.value.binding.generation,
          hostEpoch: result.value.binding.hostEpoch,
          processEpoch: result.value.binding.processEpoch,
        });
        const intent = new UiIntentController(this.bridge, state);
        state.onAccepted = (nodeId) => {
          if (resource.kind !== "panel") return;
          const node = resource.nodes.find((item) => item.id === nodeId);
          if (node?.type !== "action" || node.action.kind !== "core") return;
          if (node.action.action === "openRecovery") {
            this.recoveryRequest++;
            this.publish();
          } else if (node.action.action === "openPanel") {
            const panelId = node.action.panelId;
            const target = this.catalog
              .getSnapshot()
              .entries.find(
                (item) =>
                  item.sourceKey === entry.sourceKey &&
                  item.id === panelId &&
                  item.kind === "panel",
              );
            if (target) void this.open(target);
          }
        };
        this.records.set(key, { entry, resource, state, intent });
        void intent.visibility(true, "tab");
        this.publish();
      } catch {
        this.failures.add(this.failureKey(entry));
        this.publish();
      }
    })().finally(() => {
      this.opening.delete(key);
    });
    this.opening.set(key, work);
    return work;
  }
  close(entry: UiCatalogEntry): void {
    this.remove(entry, true);
  }
  private remove(entry: UiCatalogEntry, voluntary = false): void {
    this.serial++;
    const key = contributionKey(entry);
    const record = this.records.get(key);
    if (!record) return;
    if (
      voluntary &&
      !this.dead &&
      this.catalog.current(record.entry) &&
      record.entry.availability === "available" &&
      record.resource.kind === "panel" &&
      record.state.getSnapshot().active &&
      !this.failed(record.entry)
    ) {
      const view = record.state.getSnapshot();
      this.drafts.retain(record.entry, view.snapshot.binding, record.resource, view);
    } else this.drafts.drop(record.entry);
    record.intent.dispose();
    record.state.retire();
    this.records.delete(key);
    this.publish();
    send(() => this.bridge.close({ binding: record.state.form().binding }));
  }
  quarantine(entry: UiCatalogEntry, reason: "validation" | "renderer"): void {
    const key = this.failureKey(entry);
    if (this.failures.has(key)) return;
    this.drafts.drop(entry);
    this.failures.add(key);
    this.remove(entry);
    this.publish();
    send(() =>
      this.bridge.reportFailure({
        sourceKey: entry.sourceKey,
        id: entry.id,
        uiResourceGeneration: entry.uiResourceGeneration,
        catalogRevision: Math.max(0, this.catalog.getSnapshot().revision),
        reason,
      }),
    );
  }
  private event(event: UiBridgeEvent): void {
    if (this.dead) return;
    if (event.type === "catalog") {
      this.serial++;
      this.drafts.withdrawOwners(event.hostEpoch, event.owners);
      for (const record of [...this.records.values()]) {
        if (
          record.state.form().binding.hostEpoch !== event.hostEpoch ||
          !event.owners.some(
            (owner) =>
              owner.sourceKey === record.entry.sourceKey &&
              owner.pluginId === record.entry.pluginId &&
              owner.uiResourceGeneration === record.entry.uiResourceGeneration,
          )
        )
          this.remove(record.entry);
      }
      const keep = new Set(
        this.catalog.getSnapshot().entries.map((entry) => this.failureKey(entry)),
      );
      for (const key of this.failures) if (!keep.has(key)) this.failures.delete(key);
      const current = this.catalog.getSnapshot().entries;
      for (const key of this.unavailableStatus)
        if (!current.some((entry) => contributionKey(entry) === key))
          this.unavailableStatus.delete(key);
      for (const [key, pending] of this.statusEvents)
        if (pending.binding.hostEpoch !== event.hostEpoch) this.statusEvents.delete(key);
      return;
    }
    const record = [...this.records.values()].find(
      (item) => bindingKey(item.state.form().binding) === bindingKey(event.binding),
    );
    if (event.type === "revoked") {
      const retired = [
        "generation-retired",
        "resource-replaced",
        "renderer-gone",
        "process-gone",
        "safe-mode",
        "shutdown",
        "overflow",
      ].includes(event.reason);
      if (retired) {
        // Registry retirement is distinct from its actual voluntary-close notification.
        // Also purge closed panels and cancel pending opens when no live record remains.
        this.serial++;
        this.drafts.retireExecution(event.binding);
      }
      if (record) {
        if (retired || event.reason === "closed") {
          if (record.entry.kind === "status")
            this.unavailableStatus.add(contributionKey(record.entry));
          this.remove(record.entry);
        } else record.intent.cancel(); // release/hide/expiry withdraw intent, retaining the UI draft
      }
      this.statusEvents.delete(bindingKey(event.binding));
      return;
    }
    if (record) {
      if (event.type === "state") void record.state.invalidate(event.revision);
      else record.intent.challenge(event.challenge);
    } else if (event.type === "state" && event.binding.kind === "status") {
      const key = bindingKey(event.binding);
      const previous = this.statusEvents.get(key);
      if (
        (!previous || event.revision > previous.revision) &&
        (previous || this.statusEvents.size < 16)
      )
        this.statusEvents.set(key, event);
      void this.adoptStatus(event);
    }
  }
  private async adoptStatus(event: Extract<UiBridgeEvent, { type: "state" }>): Promise<void> {
    const bindingId = bindingKey(event.binding);
    const entry = this.catalog
      .getSnapshot()
      .entries.find(
        (item) =>
          item.id === event.binding.contributionId &&
          item.kind === "status" &&
          item.uiResourceGeneration === event.binding.uiResourceGeneration,
      );
    if (
      !entry ||
      event.binding.hostEpoch !== this.catalog.getSnapshot().epoch ||
      this.record(entry) ||
      this.statusPending.has(bindingId)
    )
      return;
    this.statusPending.add(bindingId);
    try {
      const admitted = await this.catalog.resource(entry);
      const resource = admitted?.resource;
      if (!resource || resource.kind !== "status") return;
      try {
        assertRenderable(resource, admitted!.validationContext, admitted!.rawBytes);
      } catch {
        this.quarantine(entry, "validation");
        return;
      }
      const result = await this.catalog.wait(this.bridge.snapshot({ binding: event.binding }));
      if (
        !result.ok ||
        this.dead ||
        !this.statusEvents.has(bindingId) ||
        !!this.record(entry) ||
        !this.catalog.current(entry) ||
        bindingKey(result.value.binding) !== bindingId
      )
        return;
      const state = new UiStateStore(
        this.bridge,
        {
          kind: "panel",
          data: resource.data,
          fields: {},
          root: "root",
          nodes: [{ id: "root", type: "group", layout: "stack", children: [] }],
        },
        result.value,
      );
      state.setDiagnosticOwner({
        sourceKey: entry.sourceKey,
        pluginId: entry.pluginId,
        generation: result.value.binding.generation,
        hostEpoch: result.value.binding.hostEpoch,
        processEpoch: result.value.binding.processEpoch,
      });
      this.records.set(contributionKey(entry), {
        entry,
        resource,
        state,
        intent: new UiIntentController(this.bridge, state),
      });
      this.unavailableStatus.delete(contributionKey(entry));
      const latest = this.statusEvents.get(bindingId);
      this.statusEvents.delete(bindingId);
      if (latest) void state.invalidate(latest.revision);
      this.publish();
    } catch {
      if (!this.dead && this.catalog.current(entry)) this.quarantine(entry, "renderer");
    } finally {
      this.statusPending.delete(bindingId);
    }
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.serial++;
    for (const record of [...this.records.values()]) this.remove(record.entry);
    this.drafts.clear();
    this.offCatalog();
    this.catalog.dispose();
    this.listeners.clear();
    this.failures.clear();
    this.statusPending.clear();
    this.statusEvents.clear();
    this.unavailableStatus.clear();
  }
}
export async function bootstrapPluginUi(session: RendererSession): Promise<void> {
  try {
    await session.catalog.wait(session.start());
  } catch {
    session.catalog.expireBootstrap();
    // Editor restoration proceeds with an empty catalog until a fresh revision event.
  }
}
