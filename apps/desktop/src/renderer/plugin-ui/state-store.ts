import type {
  PluginUiBridge,
  FoundationDiagnostics,
  FoundationCounters,
  FoundationDiagnosticEvent,
} from "@kobrixa/plugin-runtime";
import type {
  Condition,
  PanelResourceV1,
  UiStateSnapshot,
  UiScalar,
  ValueSpec,
  UiNodeV1,
  Text,
  ResourceOwner,
} from "@kobrixa/plugin-protocol";
import { catalogDiagnostics } from "./catalog-store.js";
import { copyDraft, type DraftPayload } from "./draft-cache.js";
export const bindingKey = (binding: UiStateSnapshot["binding"]): string =>
  JSON.stringify([
    binding.hostEpoch,
    binding.processEpoch,
    binding.generation,
    binding.uiResourceGeneration,
    binding.contributionId,
    binding.panelInstance,
    binding.kind,
  ]);
export function condition(
  value: Condition | undefined,
  data: Record<string, UiScalar>,
  form: Record<string, UiScalar>,
): boolean {
  if (!value) return true;
  if (value.op === "all") return value.items.every((item) => condition(item, data, form));
  if (value.op === "any") return value.items.some((item) => condition(item, data, form));
  if (value.op === "not") return !condition(value.item, data, form);
  if (!("left" in value)) return false;
  const left = (value.left.scope === "data" ? data : form)[value.left.key];
  if (value.op === "eq") return left === value.right;
  if (value.op === "ne") return left !== value.right;
  if (typeof left !== "number" || typeof value.right !== "number") return false;
  if (value.op === "lt") return left < value.right;
  if (value.op === "lte") return left <= value.right;
  if (value.op === "gt") return left > value.right;
  return left >= value.right;
}
export function scalarValid(schema: ValueSpec, value: UiScalar): boolean {
  if (value === null) return schema.nullable;
  switch (schema.type) {
    case "string":
      return typeof value === "string" && Array.from(value).length <= schema.maxLength;
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= schema.min &&
        value <= schema.max &&
        (!schema.integer || Number.isInteger(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && schema.values.includes(value);
  }
}
export function numericDraft(raw: string): number | null {
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw.trim()) &&
    Number.isFinite(Number(raw))
    ? Number(raw)
    : null;
}
export type StateView = {
  snapshot: UiStateSnapshot;
  draft: Record<string, UiScalar>;
  raw: Record<string, string>;
  // localRevision is the private edit generation, independent of wire formRevision.
  errors: Record<string, Text>;
  active: boolean;
  busy: boolean;
  problem: string | null;
  localRevision: number;
};
const stateDiagnostics = new WeakMap<object, FoundationDiagnostics>();
const zeroCounters = (): FoundationCounters =>
  Object.freeze({
    owners: 0,
    bindings: 0,
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
    timers: 0,
    pendingInvocations: 0,
    actionTokens: 0,
    resourceReaders: 0,
    workerJobs: 0,
  });
export function diagnosticsFor(instance: object): FoundationDiagnostics {
  const diagnostics = stateDiagnostics.get(instance) ?? catalogDiagnostics(instance);
  if (!diagnostics) throw new Error("Unknown renderer state instance");
  return diagnostics;
}
export class UiStateStore {
  private deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
  private retained = new Map<object, number>();
  private diagnosticListeners = new Set<(event: FoundationDiagnosticEvent) => void>();
  private diagnosticOwner: ResourceOwner | undefined;
  private committedRevision = -1;
  private inputTimers = new Set<ReturnType<typeof setTimeout>>();
  private inputQueue: string | undefined;
  trackInputTimer(timer: ReturnType<typeof setTimeout>): void {
    this.inputTimers.add(timer);
  }
  clearInputTimer(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.inputTimers.delete(timer);
  }
  queueChallenge(challenge: string | undefined): void {
    this.inputQueue = challenge;
  }
  setDiagnosticOwner(owner: ResourceOwner): void {
    this.diagnosticOwner = owner;
  }
  private observe(kind: "apply" | "revoke"): void {
    if (!this.diagnosticOwner) return;
    const event: FoundationDiagnosticEvent = {
      kind,
      owner: this.diagnosticOwner,
      binding: this.view.snapshot.binding,
      time: performance.timeOrigin + performance.now(),
    };
    this.diagnosticListeners.forEach((listener) => listener(event));
  }
  renderCommitted(revision: number): void {
    if (
      !this.view.active ||
      revision !== this.view.snapshot.revision ||
      revision <= this.committedRevision
    )
      return;
    this.committedRevision = revision;
    this.retained.clear();
    this.observe("apply");
  }
  intentRevoked(): void {
    this.observe("revoke");
  }
  private deadline<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        this.deadlines.delete(timer);
        reject(new Error("Renderer request ended"));
      };
      const timer = setTimeout(cancel, milliseconds);
      this.deadlines.set(timer, cancel);
      promise.then(
        (value) => {
          clearTimeout(timer);
          this.deadlines.delete(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          this.deadlines.delete(timer);
          reject(error);
        },
      );
    });
  }
  private view: StateView;
  private listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private target: number;
  private serial = 0;
  private acceptedRevision: number;
  private submissionRevision: number;
  private uncertain = false;
  private visible: boolean;
  private corePending = new Set<string>();
  onEdit: () => void = () => {};
  onAccepted: (nodeId: string) => void = () => {};
  constructor(
    private bridge: Pick<PluginUiBridge, "snapshot" | "invoke">,
    readonly resource: PanelResourceV1,
    initial: UiStateSnapshot,
    restored?: DraftPayload,
  ) {
    stateDiagnostics.set(
      this,
      Object.freeze({
        snapshot: () =>
          Object.freeze({
            ...zeroCounters(),
            timers: this.deadlines.size + this.inputTimers.size,
            queuedEvents: this.retained.size + (this.inputQueue ? 1 : 0),
            queuedBytes:
              [...this.retained.values()].reduce((a, b) => a + b, 0) +
              (this.inputQueue
                ? new TextEncoder().encode(JSON.stringify(this.inputQueue)).length
                : 0),
          }),
        onEvent: (listener: (event: FoundationDiagnosticEvent) => void) => {
          this.diagnosticListeners.add(listener);
          return () => {
            this.diagnosticListeners.delete(listener);
          };
        },
      }),
    );
    this.target = initial.revision;
    this.visible = initial.visible;
    this.acceptedRevision = this.submissionRevision = initial.formRevision;
    this.view = {
      snapshot: initial,
      draft: { ...initial.form },
      raw: {},
      errors: {},
      active: true,
      busy: false,
      problem: null,
      localRevision: 0,
    };
    if (restored) {
      const copy = copyDraft(resource, restored);
      for (const key of Object.keys(resource.fields))
        if (Object.hasOwn(copy.draft, key)) this.view.draft[key] = copy.draft[key]!;
      this.view.raw = copy.raw;
      this.view.localRevision++; // Private edit generation, never a wire revision.
    }
  }
  getSnapshot = (): StateView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<StateView>) {
    this.view = { ...this.view, ...update };
    this.listeners.forEach((listener) => listener());
  }
  edit(key: string, value: UiScalar, raw?: string): void {
    if (raw !== undefined && Array.from(raw).length > 4000) return;
    if (!this.view.active || !Object.hasOwn(this.resource.fields, key)) return;
    if (this.view.localRevision >= Number.MAX_SAFE_INTEGER) {
      this.retire();
      return;
    }
    this.onEdit();
    const errors = { ...this.view.errors };
    delete errors[key];
    const nextRaw = { ...this.view.raw };
    if (raw === undefined) delete nextRaw[key];
    else nextRaw[key] = raw;
    this.publish({
      draft: { ...this.view.draft, [key]: value },
      raw: nextRaw,
      localRevision: this.view.localRevision + 1,
      errors,
      problem: null,
    });
  }
  presentation(): Map<string, { visible: boolean; enabled: boolean }> {
    const result = new Map<string, { visible: boolean; enabled: boolean }>();
    const nodes = new Map(this.resource.nodes.map((node) => [node.id, node]));
    const walk = (id: string, visible: boolean, enabled: boolean): void => {
      const node = nodes.get(id);
      if (!node || result.has(id)) return;
      const state = {
        visible: visible && condition(node.visibleWhen, this.view.snapshot.data, this.view.draft),
        enabled: enabled && condition(node.enabledWhen, this.view.snapshot.data, this.view.draft),
      };
      result.set(id, state);
      if (node.type === "group")
        node.children.forEach((child) => walk(child, state.visible, state.enabled));
    };
    walk(this.resource.root, true, true);
    return result;
  }
  nodeEnabled(id: string): boolean {
    const state = this.presentation().get(id);
    return (
      this.view.active &&
      this.visible &&
      this.view.snapshot.visible &&
      !!state?.visible &&
      state.enabled
    );
  }
  fieldValid(node: UiNodeV1): boolean {
    if (!("field" in node)) return true;
    const field = this.resource.fields[node.field];
    if (!field) return false;
    const value = this.view.draft[node.field] ?? null;
    const raw = this.view.raw[node.field];
    if (
      field.schema.type === "number" &&
      raw !== undefined &&
      raw.trim() !== "" &&
      numericDraft(raw) === null
    )
      return false;
    const required =
      field.required ||
      (field.requiredWhen !== undefined &&
        condition(field.requiredWhen, this.view.snapshot.data, this.view.draft));
    if (required && (value === null || value === "")) return false;
    if (!scalarValid(field.schema, value)) return false;
    if (
      (node.type === "number" || node.type === "range") &&
      typeof value === "number" &&
      field.schema.type === "number"
    ) {
      const grid = (value - field.schema.min) / node.step;
      return Math.abs(grid - Math.round(grid)) <= 1e-9 * Math.max(1, Math.abs(grid));
    }
    return true;
  }
  valid(): boolean {
    const states = this.presentation();
    return (
      this.view.active &&
      new TextEncoder().encode(JSON.stringify(this.view.draft)).length <= 16384 &&
      this.resource.nodes.every(
        (node) =>
          !states.get(node.id)?.visible || !states.get(node.id)?.enabled || this.fieldValid(node),
      )
    );
  }
  safetyAction(id: string): boolean {
    const node = this.resource.nodes.find((node) => node.id === id);
    return (
      node?.type === "action" &&
      node.action.kind === "core" &&
      ["stop", "disconnect", "openRecovery"].includes(node.action.action)
    );
  }
  actionEnabled(id: string): boolean {
    if (this.safetyAction(id))
      return (
        this.view.active &&
        this.visible &&
        this.view.snapshot.visible &&
        !!this.presentation().get(id)?.visible &&
        !this.corePending.has(id)
      );
    return this.nodeEnabled(id) && this.valid() && !this.view.busy;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.view.active) this.publish({ snapshot: { ...this.view.snapshot, visible } });
  }
  needsReconcile(): boolean {
    return this.uncertain;
  }
  async reconcileAction(): Promise<boolean> {
    const generation = this.view.localRevision;
    try {
      const result = await this.deadline(
        this.bridge.snapshot({ binding: this.view.snapshot.binding }),
      );
      if (
        !this.view.active ||
        !result.ok ||
        bindingKey(result.value.binding) !== bindingKey(this.view.snapshot.binding) ||
        result.value.formRevision < this.acceptedRevision ||
        result.value.revision < this.view.snapshot.revision
      )
        return false;
      this.acceptedRevision = result.value.formRevision;
      this.uncertain = false;
      this.publish({ snapshot: result.value });
      return true;
    } catch {
      if (this.view.active && this.view.localRevision === generation)
        this.publish({ problem: "snapshot" });
      return false;
    }
  }
  nextAction(): boolean {
    if (this.uncertain || this.view.busy || this.acceptedRevision >= Number.MAX_SAFE_INTEGER)
      return false;
    this.submissionRevision = this.acceptedRevision + 1;
    this.uncertain = true;
    this.publish({ busy: true, errors: {}, problem: null });
    return true;
  }
  actionReply<T>(promise: Promise<T>): Promise<T> {
    return this.deadline(promise, 30000);
  }
  actionPreparing(): void {
    this.publish({ busy: true });
  }
  actionFinished(): void {
    if (this.view.active) this.publish({ busy: false });
  }
  form() {
    return {
      binding: this.view.snapshot.binding,
      formRevision: this.submissionRevision,
      form: { ...this.view.draft },
    };
  }
  invalidate(revision: number): Promise<void> {
    this.target = Math.max(this.target, revision);
    if (!this.view.active || this.target <= this.view.snapshot.revision) return Promise.resolve();
    if (this.pending) return this.pending;
    const serial = this.serial;
    this.pending = (async () => {
      try {
        while (this.view.active && this.view.snapshot.revision < this.target) {
          const result = await this.deadline(
            this.bridge.snapshot({ binding: this.view.snapshot.binding }),
          );
          if (!this.view.active || serial !== this.serial) return;
          if (!result.ok) throw new Error(result.error.code);
          if (
            bindingKey(result.value.binding) !== bindingKey(this.view.snapshot.binding) ||
            result.value.revision <= this.view.snapshot.revision
          )
            throw new Error("Stale UI state");
          this.retained.clear();
          this.retained.set(
            result.value,
            new TextEncoder().encode(JSON.stringify(result.value)).length,
          );
          this.publish({ snapshot: result.value }); // preserve local draft/raw/error
        }
      } catch {
        if (this.view.active) this.publish({ problem: "snapshot" });
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async invoke(nodeId: string): Promise<void> {
    if (!this.actionEnabled(nodeId)) return;
    if (this.safetyAction(nodeId)) {
      this.corePending.add(nodeId);
      this.publish({});
      // Core actions resolve their targets from host-owned data, never the field draft.
      // Invalid or over-budget user input must not prevent reaching the safety route.
      try {
        const result = await this.deadline(
          this.bridge.invoke({
            binding: this.view.snapshot.binding,
            formRevision: this.submissionRevision,
            form: {},
            nodeId,
          }),
          30000,
        );
        if (this.view.active && result.ok && result.value.fieldErrors.length === 0)
          this.onAccepted(nodeId);
      } catch {
        /* Host safety state remains authoritative. */
      } finally {
        this.corePending.delete(nodeId);
        if (this.view.active) this.publish({});
      }
      return;
    }
    if (this.uncertain) {
      const generation = this.view.localRevision;
      this.publish({ busy: true });
      const reconciled = await this.reconcileAction();
      this.actionFinished();
      if (!reconciled || generation !== this.view.localRevision || !this.actionEnabled(nodeId))
        return;
    }
    if (!this.nextAction()) return;
    const revision = this.view.localRevision;
    try {
      const result = await this.deadline(this.bridge.invoke({ ...this.form(), nodeId }), 30000);
      if (!this.view.active || this.view.localRevision !== revision) return;
      if (!result.ok) this.publish({ problem: result.error.code });
      else {
        this.publish({
          errors: Object.fromEntries(
            result.value.fieldErrors
              .filter((error) => Object.hasOwn(this.resource.fields, error.field))
              .map((error) => [error.field, error.message]),
          ),
        });
        if (result.value.fieldErrors.length === 0) this.onAccepted(nodeId);
      }
    } catch {
      if (this.view.active && this.view.localRevision === revision)
        this.publish({ problem: "command" });
    } finally {
      this.actionFinished();
    }
  }
  retire(): void {
    if (!this.view.active) return;
    this.onEdit();
    this.serial++;
    this.publish({ active: false, busy: false });
    for (const cancel of [...this.deadlines.values()]) cancel();
    for (const timer of this.inputTimers) clearTimeout(timer);
    this.inputTimers.clear();
    this.inputQueue = undefined;
    this.retained.clear();
    this.listeners.clear();
    this.diagnosticListeners.clear();
  }
}
