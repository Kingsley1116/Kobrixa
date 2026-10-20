import { randomUUID } from "node:crypto";
import { UI_LIMITS_V1 as L, uiBytes, uiFailure, resourceFailure, validateUiData, uiRequestSchemas,
  type Counter, type ResourceOwner, type UiOwner, type UiBinding, type UiStateSnapshot, type UiEvent, type UiRevokeReason,
  type UiScalar, type PanelResourceV1, type StatusResourceV1, type Result, type UiRequestMap } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "./core-actions.js";
import type { UiRuntimeAttachment } from "./ui-lifecycle.js";
import { sameResourceOwner, sameUiBinding, type FoundationCounters, type FoundationDiagnostics } from "./ui-host-ports.js";
type Resource = PanelResourceV1 | StatusResourceV1;
type OpenInput = { owner: UiOwner; id: string; scope: CoreWindowScope; resource: Resource;
  activateInitialized: UiRuntimeAttachment["activateInitialized"]; signal?: AbortSignal };
type Live = { owner: ResourceOwner; uiOwner: UiOwner; scope: CoreWindowScope; resource: Resource; state: UiStateSnapshot;
  times: number[]; pending: number };
type Reservation = { owner: UiOwner; id: string; scope: CoreWindowScope; kind: Resource["kind"];
  token: object; promise: Promise<Result<UiStateSnapshot>>; cancel(): void };
const identity = (owner: UiOwner, id: string, scope: CoreWindowScope) => JSON.stringify([scope.hostEpoch, scope.workbenchInstance, owner.sourceKey, id]);
export class UiStateRegistry {
  readonly #live = new Map<string, Live>();
  readonly #opening = new Map<string, Reservation>();
  readonly #listeners = new Set<(owner: ResourceOwner, event: UiEvent) => void>();
  readonly #now: () => number;
  #locale: "en" | "zh-TW" = "en";
  #theme: "light" | "dark" = "light";
  constructor(private readonly deps: { current(owner: UiOwner): boolean; now?: () => number;
    eventCounters?: () => Pick<FoundationCounters, "subscriptions" | "queuedEvents" | "queuedBytes"> }) {
    this.#now = deps.now ?? (() => performance.now());
    stateDiagnostics.set(this, {
      snapshot: () => Object.freeze({ owners: 0, bindings: this.#live.size,
        subscriptions: 0, queuedEvents: 0, queuedBytes: 0, timers: 0, pendingInvocations: 0,
        actionTokens: 0, resourceReaders: 0, workerJobs: 0, ...deps.eventCounters?.() }),
      onEvent: () => () => {},
    });
  }
  onEvent(listener: (owner: ResourceOwner, event: UiEvent) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  #emit(owner: ResourceOwner, event: UiEvent): void {
    for (const listener of this.#listeners) { try { listener(structuredClone(owner), structuredClone(event)); } catch { /* State is authoritative. */ } }
  }
  #find(owner: ResourceOwner, binding: UiBinding): Live | undefined {
    const live = this.#live.get(binding.panelInstance);
    return live && sameResourceOwner(owner, live.owner) && sameUiBinding(binding, live.state.binding) && this.deps.current(live.uiOwner) ? live : undefined;
  }
  initialBindingsReady(owner: ResourceOwner, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const captured = [...this.#opening.values()].filter(opening =>
      opening.owner.sourceKey === owner.sourceKey && opening.owner.pluginId === owner.pluginId &&
      opening.scope.hostEpoch === owner.hostEpoch);
    if (!captured.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        for (const opening of captured) opening.cancel();
        signal.removeEventListener("abort", abort); reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void Promise.all(captured.map(opening => opening.promise)).then(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason); else resolve();
      });
    });
  }
  cancelInitialBindings(owner: ResourceOwner): void {
    for (const opening of [...this.#opening.values()]) if (
      opening.owner.sourceKey === owner.sourceKey && opening.owner.pluginId === owner.pluginId &&
      opening.scope.hostEpoch === owner.hostEpoch) opening.cancel();
  }
  executionOwner(binding: UiBinding): ResourceOwner | null {
    const live = this.#live.get(binding.panelInstance);
    return live && sameUiBinding(binding, live.state.binding) && this.deps.current(live.uiOwner)
      ? structuredClone(live.owner) : null;
  }
  instances(owner: ResourceOwner): UiBinding[] {
    return [...this.#live.values()].filter((live) => sameResourceOwner(owner, live.owner) && this.deps.current(live.uiOwner))
      .map((live) => structuredClone(live.state.binding));
  }
  currentStatus(scope: CoreWindowScope): readonly {binding: UiBinding; revision: number}[] {
    return [...this.#live.values()].filter(live => live.state.binding.kind === "status" &&
      live.scope.hostEpoch === scope.hostEpoch && live.scope.workbenchInstance === scope.workbenchInstance &&
      this.deps.current(live.uiOwner)).map(live => ({ binding: structuredClone(live.state.binding), revision: live.state.revision }));
  }
  environment(): { locale: "en" | "zh-TW"; theme: "light" | "dark" } { return { locale: this.#locale, theme: this.#theme }; }
  setEnvironment(locale: "en" | "zh-TW", theme: "light" | "dark"): void {
    this.#locale = locale; this.#theme = theme;
    const owners = new Map<string, ResourceOwner>();
    for (const live of this.#live.values()) { live.state.locale = locale; owners.set(JSON.stringify(live.owner), live.owner); }
    for (const owner of owners.values()) this.#emit(owner, { kind: "ui.environment", data: { locale, theme } });
  }
  async open(input: OpenInput): Promise<Result<UiStateSnapshot>> {
    if (input.signal?.aborted) return resourceFailure("stale");
    if (!this.deps.current(input.owner) || !input.id.startsWith(`${input.owner.pluginId}.`)) return resourceFailure("stale");
    const key = identity(input.owner, input.id, input.scope);
    for (const live of this.#live.values()) if (identity(live.uiOwner, live.state.binding.contributionId, live.scope) === key)
      return this.deps.current(live.uiOwner) ? { ok: true, value: structuredClone(live.state) } : resourceFailure("stale");
    const existing = this.#opening.get(key); if (existing) return existing.promise;
    const kind = input.resource.kind;
    const reservations = [...this.#opening.values()]; const live = [...this.#live.values()];
    const sourceCount = live.filter((v) => v.owner.sourceKey === input.owner.sourceKey && v.resource.kind === kind).length +
      reservations.filter((v) => v.owner.sourceKey === input.owner.sourceKey && v.kind === kind).length;
    const hostCount = live.filter((v) => v.resource.kind === kind).length + reservations.filter((v) => v.kind === kind).length;
    const sourceLimit = kind === "panel" ? L.sourcePanels : L.sourceStatus;
    const hostLimit = kind === "panel" ? L.hostPanels : L.hostStatus;
    if (sourceCount >= sourceLimit || hostCount >= hostLimit) return resourceFailure("quota", sourceCount >= sourceLimit ? sourceLimit : hostLimit);
    let resolve!: (result: Result<UiStateSnapshot>) => void;
    const token = {};
    const abort = () => resolve(resourceFailure("stale"));
    const promise = new Promise<Result<UiStateSnapshot>>((r) => { resolve = (result) => {
      input.signal?.removeEventListener("abort", abort);
      if (this.#opening.get(key)?.token === token) this.#opening.delete(key); r(result);
    }; });
    this.#opening.set(key, { owner: structuredClone(input.owner), id: input.id, scope: input.scope, kind, token, promise, cancel: abort });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    // Reservation is installed before calling any activation code, including synchronous callbacks.
    void Promise.resolve().then(() => input.activateInitialized(input.owner.sourceKey, input.signal ?? new AbortController().signal)).then((channel) => {
      if (this.#opening.get(key)?.token !== token || !this.deps.current(input.owner)) return resolve(resourceFailure("stale"));
      const owner = channel.owner;
      if (owner.sourceKey !== input.owner.sourceKey || owner.pluginId !== input.owner.pluginId || owner.hostEpoch !== input.scope.hostEpoch)
        return resolve(resourceFailure("stale"));
      const resource = structuredClone(input.resource);
      const data = Object.fromEntries(Object.entries(resource.data).map(([key, slot]) => [key, slot.initial]));
      const dataResult = validateUiData(resource, data); if (!dataResult.ok) return resolve(dataResult);
      const form = resource.kind === "panel" ? Object.fromEntries(Object.entries(resource.fields).map(([key, field]) => [key, field.initial])) : {};
      const binding: UiBinding = { contributionId: input.id, panelInstance: randomUUID(), kind,
        uiResourceGeneration: input.owner.uiResourceGeneration, generation: owner.generation,
        hostEpoch: owner.hostEpoch, processEpoch: owner.processEpoch };
      const state: UiStateSnapshot = { binding, revision: 0, data, formRevision: 0, form,
        valid: resource.kind === "status" || !Object.values(resource.fields).some((f) => f.required && (f.initial === null || f.initial === "")),
        visible: kind === "status", locale: this.#locale };
      this.#opening.delete(key);
      this.#live.set(binding.panelInstance, { owner: structuredClone(owner), uiOwner: structuredClone(input.owner),
        scope: structuredClone(input.scope), resource, state, times: [], pending: 0 });
      this.#emit(owner, { kind: "ui.instances", data: { instances: this.instances(owner) } });
      resolve({ ok: true, value: structuredClone(state) });
    }, () => resolve(uiFailure("read"))).catch(() => resolve(uiFailure("read"))).finally(() => {
      if (this.#opening.get(key)?.token === token) this.#opening.delete(key);
    });
    return promise;
  }
  state(owner: ResourceOwner, binding: UiBinding): Result<UiStateSnapshot> {
    const live = this.#find(owner, binding); return live ? { ok: true, value: structuredClone(live.state) } : resourceFailure("stale");
  }
  patch(owner: ResourceOwner, input: UiRequestMap["ui/patch"]["params"]): Result<{ revision: number }> {
    if (!uiRequestSchemas["ui/patch"].params.safeParse(input).success) return uiFailure("schema", "$.patch");
    const live = this.#find(owner, input.binding);
    if (!live || input.baseRevision !== live.state.revision) return resourceFailure("stale");
    const keys = Object.keys(input.set);
    if (keys.length < 1 || keys.length > L.patchEntries || uiBytes(input) > L.patchBytes) return uiFailure("limit", "$.patch", "patchBytes");
    if (keys.some((key) => !Object.hasOwn(live.resource.data, key))) return uiFailure("reference", "$.set");
    const now = this.#now(); live.times = live.times.filter((time) => now - time < 1000);
    if (live.times.length >= L.patchesPerSecond) return resourceFailure("rate", L.patchesPerSecond);
    if (live.pending >= L.pendingPatches) return resourceFailure("queue", L.pendingPatches);
    if (live.state.revision === Number.MAX_SAFE_INTEGER) return resourceFailure("quota", Number.MAX_SAFE_INTEGER);
    const next = { ...live.state.data, ...input.set };
    const valid = validateUiData(live.resource, next); if (!valid.ok) return valid;
    live.state = { ...live.state, revision: live.state.revision + 1, data: valid.value };
    live.times.push(now); live.pending++;
    return { ok: true, value: { revision: live.state.revision } };
  }
  flush(): void {
    // T3 schedules this on its existing bounded event drain, not a new timer per panel.
    for (const live of this.#live.values()) if (live.pending > 0) {
      live.pending = 0;
      this.#emit(live.owner, { kind: "ui.state", data: { binding: live.state.binding, revision: live.state.revision } });
    }
  }
  setForm(owner: ResourceOwner, binding: UiBinding, revision: number, values: Record<string, UiScalar>, valid: boolean): Result<{ accepted: true }> {
    const live = this.#find(owner, binding);
    if (!live || live.resource.kind !== "panel" || revision !== live.state.formRevision + 1 || !Number.isSafeInteger(revision)) return resourceFailure("stale");
    if (uiBytes(values) > L.formBytes || Object.keys(values).length !== Object.keys(live.resource.fields).length ||
      Object.keys(values).some((key) => !Object.hasOwn(live.resource.kind === "panel" ? live.resource.fields : {}, key))) return uiFailure("schema", "$.form");
    // T5 has validated raw typed draft against the resource before this host-only call.
    live.state = { ...live.state, formRevision: revision, form: structuredClone(values), valid };
    this.#emit(owner, { kind: "ui.form", data: { binding, revision, values: structuredClone(values) } });
    return { ok: true, value: { accepted: true } };
  }
  visibility(owner: ResourceOwner, binding: UiBinding, visible: boolean): Result<{ accepted: true }> {
    const live = this.#find(owner, binding); if (!live) return resourceFailure("stale");
    live.state.visible = visible;
    this.#emit(owner, { kind: "ui.visibility", data: { binding, visible } });
    return { ok: true, value: { accepted: true } };
  }
  #remove(live: Live, reason: UiRevokeReason): void {
    this.#live.delete(live.state.binding.panelInstance); live.pending = 0;
    this.#emit(live.owner, { kind: "ui.revoked", data: { binding: live.state.binding, reason } });
    this.#emit(live.owner, { kind: "ui.instances", data: { instances: this.instances(live.owner) } });
  }
  close(owner: ResourceOwner, binding: UiBinding): Result<{ closed: true }> {
    const live = this.#find(owner, binding); if (!live) return resourceFailure("stale");
    this.#remove(live, "closed"); return { ok: true, value: { closed: true } };
  }
  retireResource(owner: UiOwner, reason: UiRevokeReason): void {
    for (const opening of [...this.#opening.values()]) if (opening.owner.sourceKey === owner.sourceKey &&
      opening.owner.pluginId === owner.pluginId && opening.owner.uiResourceGeneration === owner.uiResourceGeneration) opening.cancel();
    for (const live of [...this.#live.values()]) if (live.uiOwner.sourceKey === owner.sourceKey &&
      live.uiOwner.pluginId === owner.pluginId && live.uiOwner.uiResourceGeneration === owner.uiResourceGeneration) this.#remove(live, reason);
  }
  retireExecution(owner: ResourceOwner, reason: UiRevokeReason): void {
    this.cancelInitialBindings(owner);
    for (const live of [...this.#live.values()]) if (sameResourceOwner(owner, live.owner)) this.#remove(live, reason);
  }
}
export function currentStatusBindings(state: UiStateRegistry, scope: CoreWindowScope): readonly {binding: UiBinding; revision: Counter}[] {
  return state.currentStatus(scope);
}
const stateDiagnostics = new WeakMap<object, FoundationDiagnostics>();
export function diagnosticsFor(instance: object): FoundationDiagnostics {
  const diagnostics = stateDiagnostics.get(instance);
  if (!diagnostics) throw new TypeError("Unknown UI state instance");
  return diagnostics;
}

