import { randomUUID } from "node:crypto";
import { synchronizedForm, equalForm } from "./ui-form.js";
import { z } from "zod";
import {
  acceptsValue,
  resourceFailure,
  uiBindingSchema,
  localIdSchema,
  counterSchema,
  type CommandInvocation,
  type CommandValue,
  type Condition,
  type ContextCommandDeclaration,
  type PanelResourceV1,
  type StatusResourceV1,
  type UiResourceV2,
  type PanelResourceV2,
  type UiNodeV2,
  type UiBinding,
  type UiStateSnapshot,
  type ResourceOwner,
  type Result,
  type UiScalar,
  type UiDataRequestMapV2,
  type DatasetRowV2,
  type ChartHeaderV2,
} from "@kobrixa/plugin-protocol";
import {
  sameResourceOwner,
  sameUiBinding,
  type UiInteractionRequest,
  type UiInteractionValue,
  type UiInteractionView,
  type UiPanelInteraction,
} from "./ui-host-ports.js";
const scalar = z.union([
  z
    .string()
    .max(8000)
    .refine(
      (v) =>
        Array.from(v).length <= 4000 &&
        !v.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
    ),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const form = z
  .record(localIdSchema, scalar)
  .refine((v) => Object.keys(v).length <= 32 && Buffer.byteLength(JSON.stringify(v)) <= 16384);
const base = {
  binding: uiBindingSchema,
  nodeId: localIdSchema,
  presentation: counterSchema,
  viewGeneration: counterSchema,
  formRevision: counterSchema,
  form,
};
const row = {
  dataset: localIdSchema,
  revision: counterSchema,
  key: z
    .string()
    .min(1)
    .max(256)
    .refine((v) => Array.from(v).length <= 128),
};
export const uiInteractionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("viewState"), binding: uiBindingSchema }),
  z.strictObject({ kind: z.literal("core"), binding: uiBindingSchema, actionId: localIdSchema }),
  z.strictObject({ ...base, kind: z.literal("action") }),
  z.strictObject({ ...base, ...row, kind: z.literal("row") }),
  z.strictObject({ ...base, ...row, kind: z.literal("list"), actionId: localIdSchema }),
  z.strictObject({ ...base, kind: z.literal("dialogConfirm") }),
  z.strictObject({ ...base, kind: z.literal("dialogClose") }),
  z.strictObject({ ...base, kind: z.literal("chartView"), view: z.enum(["full", "recent60s"]) }),
  z.strictObject({
    ...base,
    kind: z.literal("cursor"),
    dataset: localIdSchema,
    revision: counterSchema,
    time: z.number().finite().nullable(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("codeCopy"),
    dataset: localIdSchema,
    revision: counterSchema,
  }),
]);
export interface UiInteractionResolved {
  owner: ResourceOwner;
  resource: PanelResourceV1 | StatusResourceV1 | UiResourceV2;
  state: UiStateSnapshot;
  workbenchInstance: string;
  contextRef: string | null;
  commands: ReadonlyMap<string, ContextCommandDeclaration>;
}
export interface UiInteractionPorts {
  resolve(binding: UiBinding): UiInteractionResolved | null;
  read(
    params: UiDataRequestMapV2["ui/dataRead"]["params"],
  ): Promise<UiDataRequestMapV2["ui/dataRead"]["result"]>;
  snapshot(
    params: UiDataRequestMapV2["ui/dataSnapshot"]["params"],
  ): Promise<UiDataRequestMapV2["ui/dataSnapshot"]["result"]>;
  core(resolved: UiInteractionResolved, actionId: string): Promise<Result<CommandValue>>;
  dispatch(
    resolved: UiInteractionResolved,
    invocation: CommandInvocation,
  ): Promise<Result<CommandValue>>;
  admit(owner: ResourceOwner): Result<never> | null;
  acceptForm(binding: UiBinding, revision: number, values: Record<string, UiScalar>): boolean;
  mintAction(resolved: UiInteractionResolved): string;
  currentData(
    binding: UiBinding,
    expected: readonly Pick<Metadata, "dataset" | "revision" | "presentation">[],
  ): boolean;
  now(): number;
}
type Metadata = Extract<
  UiDataRequestMapV2["ui/dataSnapshot"]["result"],
  { ok: true }
>["value"]["datasets"][number];
type Synced = {
  resource: PanelResourceV2;
  metadata: Map<string, Metadata>;
  charts: Map<string, ChartHeaderV2>;
  consistent: boolean;
  presentation: number;
  stateRevision: number;
};
type RowCommand = NonNullable<Extract<UiNodeV2, { type: "table" }>["onSelect"]>;
type Command = Pick<RowCommand, "command" | "arguments">;
type Tuple = { dataset: string; revision: number; key: string; version: string | null };
type Pending = {
  request: Extract<UiInteractionRequest, { kind: "cursor" }>;
  finish: (r: Result<UiInteractionValue>) => void;
};
type View = {
  view: UiInteractionView;
  stamp: string;
  tuple: Tuple | null;
  serial: number;
  busy: boolean;
  last: number;
  times: number[];
  pending: Pending | null;
  timer: ReturnType<typeof setTimeout> | null;
};
const key = (b: UiBinding) =>
  JSON.stringify([
    b.contributionId,
    b.panelInstance,
    b.kind,
    b.uiResourceGeneration,
    b.generation,
    b.hostEpoch,
    b.processEpoch,
  ]);
const stale = (): Result<never> => resourceFailure("stale");
function condition(
  c: Condition | undefined,
  data: Record<string, UiScalar>,
  values: Record<string, UiScalar>,
): boolean {
  if (!c) return true;
  if (c.op === "all") return c.items.every((i) => condition(i, data, values));
  if (c.op === "any") return c.items.some((i) => condition(i, data, values));
  if (c.op === "not") return !condition(c.item, data, values);
  if (!("left" in c)) return false;
  const v = (c.left.scope === "data" ? data : values)[c.left.key];
  switch (c.op) {
    case "eq":
      return v === c.right;
    case "ne":
      return v !== c.right;
    case "lt":
      return typeof v === "number" && v < c.right;
    case "lte":
      return typeof v === "number" && v <= c.right;
    case "gt":
      return typeof v === "number" && v > c.right;
    case "gte":
      return typeof v === "number" && v >= c.right;
  }
}
export class UiInteractions {
  readonly #views = new Map<string, View>();
  readonly #controls = new Set<string>();
  #disposed = false;
  constructor(private readonly ports: UiInteractionPorts) {}
  #view(binding: UiBinding): View {
    let v = this.#views.get(key(binding));
    if (!v) {
      v = {
        view: { generation: 0, dialogId: null, inspectView: null },
        stamp: "",
        tuple: null,
        serial: 0,
        busy: false,
        last: -Infinity,
        times: [],
        pending: null,
        timer: null,
      };
      this.#views.set(key(binding), v);
    }
    return v;
  }
  #bump(v: View, clear = false): void {
    v.view.generation++;
    v.serial++;
    if (clear) {
      v.view.dialogId = null;
      v.view.inspectView = null;
      v.tuple = null;
    }
    if (v.timer) clearTimeout(v.timer);
    v.timer = null;
    v.pending?.finish(stale());
    v.pending = null;
  }
  invalidate(binding: UiBinding, retire = false): void {
    const v = this.#views.get(key(binding));
    if (v) this.#bump(v, true);
    if (retire) this.#views.delete(key(binding));
  }
  dispose(): void {
    this.#disposed = true;
    for (const v of this.#views.values()) this.#bump(v, true);
    this.#views.clear();
  }
  #current(r: UiInteractionResolved): UiInteractionResolved | null {
    if (this.#disposed) return null;
    const now = this.ports.resolve(r.state.binding);
    return now &&
      sameResourceOwner(now.owner, r.owner) &&
      sameUiBinding(now.state.binding, r.state.binding) &&
      now.resource === r.resource &&
      now.workbenchInstance === r.workbenchInstance
      ? now
      : null;
  }
  async #sync(r: UiInteractionResolved, v: View): Promise<Synced | null> {
    if (
      r.resource.kind !== "panel" ||
      !("datasets" in r.resource) ||
      r.state.binding.kind !== "panel"
    )
      return null;
    const binding = { ...r.state.binding, kind: "panel" as const };
    const snapshot = await this.ports.snapshot({ binding });
    if (!snapshot.ok) return null;
    const metadata = new Map(snapshot.value.datasets.map((d) => [d.dataset, d]));
    const charts = new Map<string, ChartHeaderV2>();
    let consistent = true;
    const presentation = r.state.data[r.resource.presentationKey];
    if (typeof presentation !== "number" || !Number.isSafeInteger(presentation)) return null;
    const chartIds = new Set(
      r.resource.nodes.filter((n) => n.type === "lineChart").map((n) => n.dataset),
    );
    for (const id of chartIds) {
      const m = metadata.get(id);
      if (!m || m.presentation !== presentation) {
        consistent = false;
        continue;
      }
      const read = await this.ports.read({
        binding,
        dataset: id,
        revision: m.revision,
        offset: 0,
        limit: 1,
      });
      if (!read.ok || read.value.header.kind !== "chart") {
        consistent = false;
        continue;
      }
      charts.set(id, read.value.header);
    }
    const domains = [...charts.values()].map((h) => JSON.stringify([h.timeDomain, h.view]));
    if (new Set(domains).size > 1) consistent = false;
    const stamp = JSON.stringify([presentation, r.state.visible, domains, consistent]);
    if (v.stamp && v.stamp !== stamp) this.#bump(v);
    v.stamp = stamp;
    const current = this.#current(r);
    if (
      !current ||
      current.state.revision !== r.state.revision ||
      !this.ports.currentData(r.state.binding, [...metadata.values()])
    )
      return null;
    return {
      resource: r.resource,
      metadata,
      charts,
      consistent,
      presentation,
      stateRevision: r.state.revision,
    };
  }
  #enabled(
    resource: PanelResourceV2,
    r: UiInteractionResolved,
    v: View,
    form: Record<string, UiScalar>,
  ): Set<string> {
    const nodes = new Map(resource.nodes.map((n) => [n.id, n]));
    const enabled = new Set<string>();
    const visit = (id: string, active: boolean) => {
      const n = nodes.get(id);
      if (!n) return;
      const on =
        active &&
        condition(n.visibleWhen, r.state.data, form) &&
        condition(n.enabledWhen, r.state.data, form);
      if (on) enabled.add(id);
      if (n.type === "group" || n.type === "dialog")
        for (const child of n.children) visit(child, on);
    };
    visit(resource.root, true);
    if (v.view.dialogId) visit(v.view.dialogId, true);
    return enabled;
  }
  #form(
    resource: PanelResourceV2,
    r: UiInteractionResolved,
    v: View,
    q: UiPanelInteraction,
    command: boolean,
  ): Record<string, UiScalar> | null {
    if (q.formRevision !== r.state.formRevision + (command ? 1 : 0)) return null;
    const names = Object.keys(resource.fields);
    if (Object.keys(q.form).length !== names.length || names.some((n) => !Object.hasOwn(q.form, n)))
      return null;
    if (!command && names.some((n) => q.form[n] !== r.state.form[n])) return null;
    const enabled = this.#enabled(resource, r, v, q.form),
      masked = { ...q.form };
    for (const node of resource.nodes)
      if ("field" in node) {
        const f = resource.fields[node.field]!;
        if (!enabled.has(node.id)) masked[node.field] = null;
        else if (
          command &&
          (!acceptsValue(f.schema, masked[node.field]!) ||
            ((f.required ||
              (condition(f.requiredWhen, r.state.data, q.form) && f.requiredWhen !== undefined)) &&
              (masked[node.field] === null || masked[node.field] === "")))
        )
          return null;
      }
    return masked;
  }
  async #row(
    r: UiInteractionResolved,
    metadata: Map<string, Metadata>,
    tuple: Pick<Tuple, "dataset" | "revision" | "key">,
  ): Promise<DatasetRowV2 | null> {
    const m = metadata.get(tuple.dataset);
    if (
      !m ||
      m.revision !== tuple.revision ||
      r.resource.kind !== "panel" ||
      !("presentationKey" in r.resource) ||
      m.presentation !== r.state.data[r.resource.presentationKey]
    )
      return null;
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const result = await this.ports.read({
        binding: { ...r.state.binding, kind: "panel" },
        dataset: tuple.dataset,
        revision: tuple.revision,
        offset,
        limit: 50,
      });
      if (!result.ok || (result.value.chunk.kind !== "table" && result.value.chunk.kind !== "list"))
        return null;
      const row = result.value.chunk.entries.find((row) => row.key === tuple.key);
      if (row) return row;
      if (result.value.done || result.value.nextOffset <= offset) return null;
      offset = result.value.nextOffset;
    }
    return null;
  }
  #invocation(
    r: UiInteractionResolved,
    q: UiPanelInteraction,
    command: Command,
    form: Record<string, UiScalar>,
    extra: Record<string, UiScalar>,
  ): CommandInvocation | null {
    const declaration = r.commands.get(command.command);
    if (!declaration || !command.command.startsWith(`${r.owner.pluginId}.`)) return null;
    const args: Record<string, UiScalar> = {};
    for (const [name, binding] of Object.entries(command.arguments)) {
      if (Object.hasOwn(extra, name)) return null;
      const value =
        "literal" in binding
          ? binding.literal
          : (binding.ref.scope === "data" ? r.state.data : form)[binding.ref.key];
      if (value === undefined) return null;
      Object.defineProperty(args, name, { value, enumerable: true });
    }
    for (const [name, value] of Object.entries(extra))
      Object.defineProperty(args, name, { value, enumerable: true });
    if (
      Object.keys(args).length !== Object.keys(declaration.arguments).length ||
      Object.entries(declaration.arguments).some(
        ([name, spec]) => !Object.hasOwn(args, name) || !acceptsValue(spec, args[name]!),
      )
    )
      return null;
    if (Buffer.byteLength(JSON.stringify(args)) > 16384) return null;
    const invocation: CommandInvocation = {
      version: 1,
      invocationId: randomUUID(),
      command: command.command,
      arguments: args,
      context: {
        origin: "panel",
        binding: r.state.binding,
        contextRef: r.contextRef,
        locale: r.state.locale,
        form: { revision: q.formRevision, values: form },
        trigger: { kind: "activate" },
      },
    };
    return Buffer.byteLength(JSON.stringify(invocation)) <= 65536 ? invocation : null;
  }
  async interact(input: UiInteractionRequest): Promise<Result<UiInteractionValue>> {
    try {
      const parsed = uiInteractionRequestSchema.safeParse(input);
      if (!parsed.success || this.#disposed) return stale();
      const q = parsed.data;
      const r = this.ports.resolve(q.binding);
      if (!r || !sameUiBinding(q.binding, r.state.binding)) return stale();
      if (q.kind === "core") return await this.#core(r, q.actionId);
      const v = this.#view(q.binding),
        sync = await this.#sync(r, v);
      if (!sync) return stale();
      if (q.kind === "viewState") return { ok: true, value: { kind: "view", view: { ...v.view } } };
      if (
        !r.state.visible ||
        q.presentation !== sync.presentation ||
        q.viewGeneration !== v.view.generation
      )
        return stale();
      if (q.kind === "cursor") return await this.#enqueue(q, v);
      return await this.#act(r, v, q, sync);
    } catch {
      return stale();
    }
  }
  async #core(r: UiInteractionResolved, id: string): Promise<Result<UiInteractionValue>> {
    let action;
    if (r.resource.kind === "status" && "actions" in r.resource)
      action = r.resource.actions.find((a) => a.id === id)?.action;
    else if (r.resource.kind === "panel" && "datasets" in r.resource) {
      const n = r.resource.nodes.find((n) => n.id === id);
      if (n?.type === "action") action = n.action;
    }
    if (
      !action ||
      action.kind !== "core" ||
      (action.action !== "stopRecording" &&
        action.action !== "openPanel" &&
        action.action !== "cancelConnectionRecovery")
    )
      return stale();
    const recoveryCancel = action.action === "cancelConnectionRecovery";
    if (recoveryCancel && !this.#coreVisible(r, id)) return stale();
    const idKey = `${key(r.state.binding)}:${action.action}`;
    if (this.#controls.has(idKey)) return resourceFailure("queue", 1);
    this.#controls.add(idKey);
    try {
      const result = await this.ports.core(r, id);
      const current = this.#current(r);
      if (!current || (recoveryCancel && !this.#coreVisible(current, id))) return stale();
      return result.ok ? { ok: true, value: { kind: "control", accepted: true } } : result;
    } finally {
      this.#controls.delete(idKey);
    }
  }
  // Safety cancellation ignores enabledWhen and form validity, but never visibility.
  #coreVisible(r: UiInteractionResolved, id: string): boolean {
    if (!r.state.visible) return false;
    const resource = r.resource;
    if (resource.kind === "status") return condition(resource.visibleWhen, r.state.data, {});
    if (!("datasets" in resource)) return false;
    const nodes = new Map(resource.nodes.map((node) => [node.id, node]));
    const dialog = this.#views.get(key(r.state.binding))?.view.dialogId;
    const visit = (nodeId: string): boolean => {
      const node = nodes.get(nodeId);
      if (!node || !condition(node.visibleWhen, r.state.data, r.state.form)) return false;
      if (node.id === id) return true;
      return (
        (node.type === "group" || (node.type === "dialog" && node.id === dialog)) &&
        node.children.some(visit)
      );
    };
    return visit(resource.root) || (!!dialog && visit(dialog));
  }
  #currentView(r: UiInteractionResolved, v: View, q: UiPanelInteraction, sync: Synced): boolean {
    const current = this.#current(r);
    return (
      !!current &&
      current.state.visible &&
      current.state.revision === sync.stateRevision &&
      current.state.data[sync.resource.presentationKey] === q.presentation &&
      v.view.generation === q.viewGeneration
    );
  }
  async #act(
    r: UiInteractionResolved,
    v: View,
    q: Exclude<UiInteractionRequest, { kind: "core" | "viewState" | "cursor" }>,
    sync: Synced,
  ): Promise<Result<UiInteractionValue>> {
    const resource = sync.resource;
    const node = resource.nodes.find((n) => n.id === q.nodeId);
    if (!node) return stale();
    // Closing is a host view operation, never a form submission. In particular a
    // stale draft or a newly-required field must not trap the open dialog.
    if (q.kind === "dialogClose") {
      if (
        node.type !== "dialog" ||
        v.view.dialogId !== node.id ||
        !this.#currentView(r, v, q, sync)
      )
        return stale();
      this.#bump(v, true);
      return { ok: true, value: { kind: "view", view: { ...v.view } } };
    }
    if (
      q.kind === "action" &&
      node.type === "action" &&
      node.action.kind === "view" &&
      node.action.action === "closeDialog"
    ) {
      if (
        v.view.dialogId !== node.action.dialogId ||
        !this.#currentView(r, v, q, sync) ||
        !this.#enabled(resource, r, v, r.state.form).has(node.id)
      )
        return stale();
      this.#bump(v, true);
      return { ok: true, value: { kind: "view", view: { ...v.view } } };
    }
    const isCommand =
      q.kind === "row" ||
      q.kind === "codeCopy" ||
      q.kind === "dialogConfirm" ||
      (q.kind === "list" &&
        node.type === "list" &&
        node.actions.find((a) => a.id === q.actionId)?.action.kind === "command") ||
      (q.kind === "action" && node.type === "action" && node.action.kind === "command");
    const form = this.#form(resource, r, v, q, isCommand);
    if (!form || !this.#enabled(resource, r, v, form).has(node.id)) return stale();
    let command: Command | undefined,
      extra: Record<string, UiScalar> = {},
      tuple: Tuple | null = null,
      open: string | undefined;
    if (q.kind === "chartView") {
      if (
        node.type !== "lineChart" ||
        node.timeView !== "inspect" ||
        !v.view.dialogId ||
        !sync.consistent
      )
        return stale();
      v.view.inspectView = q.view;
      this.#bump(v);
      return { ok: true, value: { kind: "view", view: { ...v.view } } };
    }
    if (q.kind === "action") {
      if (node.type !== "action") return stale();
      if (node.action.kind === "command") command = node.action;
      else if (node.action.kind === "view") {
        open = node.action.dialogId;
      } else return stale();
    }
    if (q.kind === "row" || q.kind === "list") {
      if (
        (q.kind === "row" && node.type !== "table") ||
        (q.kind === "list" && node.type !== "list") ||
        !("dataset" in node) ||
        node.dataset !== q.dataset
      )
        return stale();
      const row = await this.#row(r, sync.metadata, q);
      if (!row) return stale();
      tuple = { dataset: q.dataset, revision: q.revision, key: row.key, version: row.version };
      let selected: RowCommand | undefined;
      if (node.type === "table") selected = node.onSelect;
      if (node.type === "list" && q.kind === "list") {
        const a = node.actions.find((a) => a.id === q.actionId)?.action;
        if (a?.kind === "command") selected = a.command;
        else if (a?.kind === "view") open = a.dialogId;
        else return stale();
      }
      if (selected) {
        command = selected;
        extra = this.#rowArgs(selected, tuple);
      } else if (!open) return stale();
    }
    if (q.kind === "dialogConfirm") {
      if (
        node.type !== "dialog" ||
        v.view.dialogId !== node.id ||
        !node.confirm ||
        !v.tuple ||
        v.tuple.dataset !== node.confirm.dataset
      )
        return stale();
      const row = await this.#row(r, sync.metadata, v.tuple);
      if (!row || row.version !== v.tuple.version) return stale();
      tuple = v.tuple;
      command = node.confirm.command;
      extra = this.#rowArgs(node.confirm.command, v.tuple);
    }
    if (q.kind === "codeCopy") {
      if (node.type !== "code" || node.dataset !== q.dataset) return stale();
      const m = sync.metadata.get(q.dataset);
      if (!m || m.revision !== q.revision || m.presentation !== q.presentation) return stale();
      command = node.copy;
    }
    if (
      !this.#currentView(r, v, q, sync) ||
      !this.ports.currentData(q.binding, [...sync.metadata.values()])
    )
      return stale();
    if (open) {
      const dialog = resource.nodes.find((n) => n.id === open);
      if (
        v.view.dialogId ||
        dialog?.type !== "dialog" ||
        (dialog.confirm && !tuple) ||
        !condition(dialog.visibleWhen, r.state.data, form) ||
        !condition(dialog.enabledWhen, r.state.data, form)
      )
        return stale();
      v.view.dialogId = open;
      v.tuple = tuple;
      v.view.inspectView = sync.charts.values().next().value?.view ?? null;
      this.#bump(v);
      return { ok: true, value: { kind: "view", view: { ...v.view } } };
    }
    if (!command) return stale();
    const limited = this.ports.admit(r.owner);
    if (limited) return limited;
    const invocation = this.#invocation(r, q, command, form, extra);
    const canonical = synchronizedForm(resource) ? r.state.form : form;
    if (synchronizedForm(resource) && !equalForm(q.form, r.state.form)) return stale();
    if (!invocation || !this.ports.acceptForm(q.binding, q.formRevision, canonical)) return stale();
    invocation.context.actionRef = this.ports.mintAction(r);
    const result = await this.ports.dispatch(r, invocation);
    const latest = this.#current(r);
    if (!latest) return stale();
    const refreshed = await this.#sync(latest, v);
    if (
      !refreshed ||
      refreshed.presentation !== q.presentation ||
      v.view.generation !== q.viewGeneration ||
      !this.ports.currentData(q.binding, [...sync.metadata.values()])
    )
      return stale();
    if (tuple) {
      const current = await this.#row(latest, refreshed.metadata, tuple);
      if (!current || current.version !== tuple.version) return stale();
    }
    if (
      !this.#currentView(latest, v, q, refreshed) ||
      !this.ports.currentData(q.binding, [...sync.metadata.values()])
    )
      return stale();
    return result.ok
      ? {
          ok: true,
          value: {
            kind: "command",
            invocationId: invocation.invocationId,
            presentation: q.presentation,
            viewGeneration: q.viewGeneration,
            value: result.value,
          },
        }
      : result;
  }
  #rowArgs(command: RowCommand, tuple: Tuple): Record<string, UiScalar> {
    return {
      [command.rowKeyArg]: tuple.key,
      [command.rowVersionArg]: tuple.version,
      [command.datasetRevisionArg]: tuple.revision,
    };
  }
  #enqueue(
    q: Extract<UiInteractionRequest, { kind: "cursor" }>,
    v: View,
  ): Promise<Result<UiInteractionValue>> {
    v.serial++;
    v.pending?.finish(stale());
    return new Promise((finish) => {
      v.pending = { request: q, finish };
      this.#pump(v);
    });
  }
  #pump(v: View): void {
    if (v.busy || v.timer || !v.pending || this.#disposed) return;
    const now = this.ports.now();
    v.times = v.times.filter((t) => now - t < 1000);
    const delay = Math.max(
      0,
      100 - (now - v.last),
      v.times.length >= 10 ? 1000 - (now - v.times[0]!) : 0,
    );
    if (delay > 0) {
      v.timer = setTimeout(() => {
        v.timer = null;
        this.#pump(v);
      }, delay);
      return;
    }
    const pending = v.pending;
    v.pending = null;
    v.busy = true;
    const serial = v.serial;
    void this.#cursor(pending.request, v, serial)
      .then(pending.finish, () => pending.finish(stale()))
      .finally(() => {
        v.busy = false;
        this.#pump(v);
      });
  }
  #cursorFormCurrent(r: UiInteractionResolved, q: UiPanelInteraction): boolean {
    // resolve() returns a snapshot. Never check a snapshot captured before an await.
    const current = this.#current(r);
    return (
      !!current &&
      (!synchronizedForm(current.resource) || current.state.formRevision === q.formRevision)
    );
  }
  async #cursor(
    q: Extract<UiInteractionRequest, { kind: "cursor" }>,
    v: View,
    serial: number,
  ): Promise<Result<UiInteractionValue>> {
    const r = this.ports.resolve(q.binding);
    if (!r) return stale();
    const sync = await this.#sync(r, v);
    if (
      !sync ||
      !sync.consistent ||
      q.presentation !== sync.presentation ||
      v.view.generation !== q.viewGeneration ||
      !r.state.visible
    )
      return stale();
    const node = sync.resource.nodes.find((n) => n.id === q.nodeId);
    if (
      node?.type !== "lineChart" ||
      node.dataset !== q.dataset ||
      sync.metadata.get(q.dataset)?.revision !== q.revision
    )
      return stale();
    const form = this.#form(sync.resource, r, v, q, false);
    if (!form || !this.#enabled(sync.resource, r, v, form).has(node.id)) return stale();
    const header = sync.charts.get(node.dataset);
    if (!header) return stale();
    const view = node.timeView === "inspect" ? v.view.inspectView : header.view;
    if (!view) return stale();
    const end = header.timeDomain[1],
      from = view === "full" ? 0 : Math.max(0, end - 60000),
      time = q.time ?? end;
    if (time < from || time > end) return stale();
    if (
      !this.#currentView(r, v, q, sync) ||
      !this.#cursorFormCurrent(r, q) ||
      v.serial !== serial ||
      !this.ports.currentData(q.binding, [...sync.metadata.values()])
    )
      return stale();
    const limited = this.ports.admit(r.owner);
    if (limited) return limited;
    const invocation = this.#invocation(r, q, node.onCursor, form, {
      [node.onCursor.timeArg]: time,
      [node.onCursor.presentationArg]: q.presentation,
    });
    if (!invocation) return stale();
    v.last = this.ports.now();
    v.times.push(v.last);
    const result = await this.ports.dispatch(r, invocation);
    const latest = this.#current(r);
    if (!latest) return stale();
    const refreshed = await this.#sync(latest, v);
    if (
      !refreshed ||
      !this.#currentView(latest, v, q, refreshed) ||
      refreshed.presentation !== q.presentation ||
      !this.#cursorFormCurrent(latest, q) ||
      v.serial !== serial ||
      v.view.generation !== q.viewGeneration ||
      !this.ports.currentData(q.binding, [...sync.metadata.values()])
    )
      return stale();
    if (!result.ok) return result;
    const keys = node.onCursor.readings.flatMap((r) => [r.rawKey, r.valueKey]);
    const output = result.value.output;
    if (
      keys.length > 16 ||
      Object.keys(output).length !== keys.length ||
      result.value.fieldErrors.length ||
      keys.some(
        (k) =>
          !Object.hasOwn(output, k) ||
          (output[k] !== null && (typeof output[k] !== "number" || !Number.isFinite(output[k]))),
      )
    )
      return stale();
    const checked: Record<string, number | null> = {};
    for (const k of keys) {
      const value = output[k];
      if (value !== null && typeof value !== "number") return stale();
      Object.defineProperty(checked, k, { value, enumerable: true });
    }
    return {
      ok: true,
      value: {
        kind: "cursor",
        invocationId: invocation.invocationId,
        presentation: q.presentation,
        viewGeneration: q.viewGeneration,
        time,
        output: checked,
      },
    };
  }
}
