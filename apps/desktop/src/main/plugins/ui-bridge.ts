import type {
  UiBridgeEvent,
  FoundationDiagnostics,
  FoundationCounters,
  FoundationDiagnosticEvent,
} from "@kobrixa/plugin-runtime";
import {
  RpcError,
  RPC_ERRORS,
  UI_LIMITS_V1,
  resourceFailure,
  uiRequestSchemas,
  type RequestContext,
  type Handle,
} from "@kobrixa/plugin-protocol";
import {
  sameResourceOwner,
  sameUiBinding,
  remainingActivationMs,
  UiCatalog,
  UiStateRegistry,
  UiSubscriptions,
  currentStatusBindings,
  type UiRuntimeAttachment,
  type Stage3ChannelContext,
  type Stage3ChannelBinding,
  type DeviceChannelAttachment,
  type UiEventLedgerPort,
  type CommonEventLedgerPort,
} from "@kobrixa/plugin-runtime";
import { uiEventLedgerPort } from "../device-broker/broker-port.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { namespacedIdSchema, validateCommandValue } from "@kobrixa/plugin-protocol";
import { sourceKeySchema } from "@kobrixa/plugin-runtime";
import type {
  CommandInvocation,
  CommandValue,
  Condition,
  ContextCommandDeclaration,
  PanelResourceV1,
  ResourceOwner,
  Result,
  StatusResourceV1,
  UiBinding,
  UiStateSnapshot,
  UiScalar as Scalar,
  ValueSpec,
} from "@kobrixa/plugin-protocol";
import type { CoreWindowScope, PluginUiBridge, UiCatalogPort } from "@kobrixa/plugin-runtime";
import type { IpcHandle } from "../ipc.js";
import type { UiIntent } from "./ui-intent.js";
import type { UserPersistenceActions } from "./user-persistence-actions.js";

export type ResolvedUi = {
  owner: ResourceOwner;
  resource: PanelResourceV1 | StatusResourceV1;
  state: UiStateSnapshot;
  workbenchInstance: string;
  contextRef: string | null;
  commands: ReadonlyMap<string, ContextCommandDeclaration>;
};
export interface UiExecutionAdapter {
  open: PluginUiBridge["open"];
  close: PluginUiBridge["close"];
  visibility: PluginUiBridge["visibility"];
  snapshot: PluginUiBridge["snapshot"];
  reportFailure: PluginUiBridge["reportFailure"];
  resolve(binding: UiBinding): ResolvedUi | null;
  acceptForm(binding: UiBinding, revision: number, values: Record<string, Scalar>): boolean;
  invoke(
    owner: ResourceOwner,
    invocation: CommandInvocation,
    signal: AbortSignal,
  ): Promise<Result<CommandValue>>;
  core(resolved: ResolvedUi, nodeId: string): Promise<Result<CommandValue>>;
  dispose(): void;
}
const stale = <T>(): Result<T> => ({
  ok: false,
  error: {
    code: "PLUGIN_E_STALE_RESOURCE",
    message: "UI action is no longer current.",
    detail: { kind: "resource", reason: "stale", resource: "ui-binding" },
  },
});
function accepts(spec: ValueSpec, value: Scalar): boolean {
  if (value === null) return spec.nullable;
  switch (spec.type) {
    case "string":
      return typeof value === "string" && Array.from(value).length <= spec.maxLength;
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= spec.min &&
        value <= spec.max &&
        (!spec.integer || Number.isInteger(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
  }
}
function condition(
  value: Condition | undefined,
  data: Record<string, Scalar>,
  form: Record<string, Scalar>,
): boolean {
  if (!value) return true;
  switch (value.op) {
    case "all":
      return value.items.every((item) => condition(item, data, form));
    case "any":
      return value.items.some((item) => condition(item, data, form));
    case "not":
      return !condition(value.item, data, form);
    default: {
      const left = (value.left.scope === "data" ? data : form)[value.left.key];
      switch (value.op) {
        case "eq":
          return left === value.right;
        case "ne":
          return left !== value.right;
        case "lt":
          return typeof left === "number" && left < value.right;
        case "lte":
          return typeof left === "number" && left <= value.right;
        case "gt":
          return typeof left === "number" && left > value.right;
        case "gte":
          return typeof left === "number" && left >= value.right;
      }
    }
  }
}
export function buildInvocation(
  resolved: ResolvedUi,
  nodeId: string,
  formRevision: number,
  form: Record<string, Scalar>,
  trigger: CommandInvocation["context"]["trigger"],
  actionRef?: string,
  motionScopeRef?: string,
): Result<CommandInvocation> {
  const { owner, state, resource } = resolved;
  const binding = state.binding;
  const cleanup = trigger.kind === "hold" && trigger.phase !== "begin";
  if (
    resource.kind !== "panel" ||
    !state.visible ||
    formRevision !== state.formRevision + (cleanup ? 0 : 1) ||
    binding.generation !== owner.generation ||
    binding.hostEpoch !== owner.hostEpoch ||
    binding.processEpoch !== owner.processEpoch ||
    Buffer.byteLength(JSON.stringify(form), "utf8") > 16 * 1024
  )
    return stale();
  const keys = Object.keys(resource.fields);
  if (Object.keys(form).length !== keys.length || keys.some((key) => !Object.hasOwn(form, key)))
    return stale();
  const nodes = new Map(resource.nodes.map((node) => [node.id, node]));
  const enabled = new Set<string>();
  const visit = (id: string, active: boolean) => {
    const node = nodes.get(id);
    if (!node) return;
    const current =
      active &&
      condition(node.visibleWhen, state.data, form) &&
      condition(node.enabledWhen, state.data, form);
    if (current) enabled.add(id);
    if (node.type === "group") for (const child of node.children) visit(child, current);
  };
  visit(resource.root, true);
  const masked = { ...form };
  for (const node of resource.nodes)
    if ("field" in node) {
      const field = resource.fields[node.field]!;
      if (!enabled.has(node.id)) masked[node.field] = null;
      else if (
        !accepts(field.schema, masked[node.field]!) ||
        ((field.required ||
          (field.requiredWhen !== undefined && condition(field.requiredWhen, state.data, form))) &&
          (masked[node.field] === null || masked[node.field] === ""))
      )
        return stale();
    }
  const node = nodes.get(nodeId);
  if (!node || !enabled.has(nodeId)) return stale();
  const action =
    node.type === "holdAction"
      ? { command: node.command, arguments: node.arguments }
      : node.type === "action" && node.action.kind === "command"
        ? node.action
        : undefined;
  if (!action || !action.command.startsWith(`${owner.pluginId}.`)) return stale();
  if ((node.type === "holdAction") !== (trigger.kind === "hold")) return stale();
  const declaration = resolved.commands.get(action.command);
  if (!declaration) return stale();
  const args: Record<string, Scalar> = Object.create(null) as Record<string, Scalar>;
  for (const [name, binding] of Object.entries(action.arguments)) {
    const value =
      "literal" in binding
        ? binding.literal
        : (binding.ref.scope === "data" ? state.data : masked)[binding.ref.key];
    if (value === undefined) return stale();
    args[name] = value;
  }
  if (
    Object.keys(args).length !== Object.keys(declaration.arguments).length ||
    Object.entries(declaration.arguments).some(
      ([name, spec]) => !Object.hasOwn(args, name) || !accepts(spec, args[name]!),
    ) ||
    Buffer.byteLength(JSON.stringify(args), "utf8") > 16 * 1024
  )
    return stale();
  const invocation: CommandInvocation = {
    version: 1,
    invocationId: randomUUID(),
    command: action.command,
    arguments: args,
    context: {
      contextRef: resolved.contextRef,
      origin: "panel",
      locale: state.locale,
      binding,
      form: { revision: formRevision, values: masked },
      trigger,
      ...(actionRef === undefined ? {} : { actionRef }),
      ...(motionScopeRef === undefined ? {} : { motionScopeRef }),
    },
  };
  return Buffer.byteLength(JSON.stringify(invocation), "utf8") <= 64 * 1024
    ? { ok: true, value: invocation }
    : stale();
}
export function trustedWorkbench(
  event: { sender: { id: number }; senderFrame: unknown },
  trusted: { id: number; mainFrame: unknown },
): boolean {
  return event.sender.id === trusted.id && event.senderFrame === trusted.mainFrame;
}
export function createPluginUiBridge(input: {
  catalog: UiCatalogPort;
  execution: UiExecutionAdapter;
  intent: UiIntent;
  actions: UserPersistenceActions;
  scope(): CoreWindowScope;
  events: UiBridgeEvents;
  coreActionCount?: () => number;
}): PluginUiBridge {
  const { execution, intent } = input;
  let disposed = false;
  const inflight = new Map<string, Set<AbortController>>();
  // Source quotas span panels and execution generations until their bindings retire.
  // Controller identity makes release idempotent even after a replacement dispatch.
  const pending = new Map<AbortController, string>();
  const admission = (owner: ResourceOwner): Result<never> | null => {
    if (pending.size >= UI_LIMITS_V1.hostPending)
      return resourceFailure("queue", UI_LIMITS_V1.hostPending);
    let sourcePending = 0;
    for (const sourceKey of pending.values()) if (sourceKey === owner.sourceKey) sourcePending++;
    return sourcePending >= UI_LIMITS_V1.sourcePending
      ? resourceFailure("queue", UI_LIMITS_V1.sourcePending)
      : null;
  };
  const holds = new Map<
    string,
    { invocation: CommandInvocation; owner: ResourceOwner; gesture: string }
  >();
  const bindKey = (binding: UiBinding) =>
    JSON.stringify([
      binding.contributionId,
      binding.panelInstance,
      binding.kind,
      binding.uiResourceGeneration,
      binding.generation,
      binding.hostEpoch,
      binding.processEpoch,
    ]);
  const holdKey = (binding: UiBinding, token: string) => JSON.stringify([bindKey(binding), token]);
  const resolve = (binding: UiBinding) => {
    if (disposed) return null;
    const value = execution.resolve(binding);
    const scope = input.scope();
    return value &&
      value.workbenchInstance === scope.workbenchInstance &&
      value.owner.hostEpoch === scope.hostEpoch
      ? value
      : null;
  };
  const abort = (binding: UiBinding) => {
    const key = bindKey(binding);
    const requests = inflight.get(key);
    inflight.delete(key);
    for (const control of requests ?? []) control.abort();
    for (const [token, held] of holds)
      if (held.invocation.context.binding && bindKey(held.invocation.context.binding) === key)
        holds.delete(token);
  };
  const dispatch = async (
    resolved: ResolvedUi,
    invocation: CommandInvocation,
  ): Promise<Result<CommandValue>> => {
    const key = bindKey(resolved.state.binding);
    const control = new AbortController();
    const cleanup = invocation.context.trigger.kind === "hold" && invocation.context.trigger.phase !== "begin";
    if (!cleanup) pending.set(control, resolved.owner.sourceKey);
    const release = () => { pending.delete(control); };
    control.signal.addEventListener("abort", release, { once: true });
    const requests = inflight.get(key) ?? new Set<AbortController>();
    requests.add(control);
    inflight.set(key, requests);
    try {
      const result = await execution.invoke(resolved.owner, invocation, control.signal);
      if (control.signal.aborted || !resolve(resolved.state.binding)) return stale();
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16 * 1024) return stale();
      if (!result.ok) return result;
      return validateCommandValue(result.value, invocation);
    } catch {
      return stale();
    } finally {
      control.signal.removeEventListener("abort", release);
      release();
      requests.delete(control);
      if (requests.size === 0 && inflight.get(key) === requests) inflight.delete(key);
    }
  };
  const bridge: PluginUiBridge = {
    catalog: (value) => input.catalog.catalog(value),
    resource: (value) => input.catalog.resource(value),
    open: async (value) => {
      const result = await execution.open(value);
      if (!result.ok) return result;
      const resolved = resolve(result.value.binding);
      if (!resolved) return stale();
      if (
        result.value.visible &&
        resolved.contextRef !== null &&
        result.value.binding.kind === "panel"
      )
        intent.bind(result.value.binding, {
          owner: resolved.owner,
          contextRef: resolved.contextRef,
          panelInstance: result.value.binding.panelInstance,
          uiResourceGeneration: result.value.binding.uiResourceGeneration,
          workbenchInstance: resolved.workbenchInstance,
        });
      return result;
    },
    close: (value) => {
      intent.revoke(value.binding, "closed");
      abort(value.binding);
      return execution.close(value);
    },
    visibility: async (value) => {
      if (!value.visible) {
        intent.revoke(value.binding, "hidden");
        abort(value.binding);
      }
      const result = await execution.visibility(value);
      if (!result.ok || !value.visible) return result;
      const resolved = resolve(value.binding);
      if (resolved?.contextRef && value.binding.kind === "panel")
        intent.bind(value.binding, {
          owner: resolved.owner,
          contextRef: resolved.contextRef,
          panelInstance: value.binding.panelInstance,
          uiResourceGeneration: value.binding.uiResourceGeneration,
          workbenchInstance: resolved.workbenchInstance,
        });
      return result;
    },
    invoke: async (value) => {
      const resolved = resolve(value.binding);
      if (!resolved) return stale();
      const node =
        resolved.resource.kind === "panel"
          ? resolved.resource.nodes.find((item) => item.id === value.nodeId)
          : undefined;
      // Core safety routes do not depend on feature form validity or enabledWhen.
      if (node?.type === "action" && node.action.kind === "core")
        return execution.core(resolved, node.id);
      const limited = admission(resolved.owner);
      if (limited) return limited;
      const built = buildInvocation(
        resolved,
        value.nodeId,
        value.formRevision,
        value.form,
        { kind: "activate" },
        undefined,
        intent.scope(value.binding),
      );
      if (
        !built.ok ||
        !execution.acceptForm(value.binding, value.formRevision, built.value.context.form!.values)
      )
        return stale();
      try {
        built.value.context.actionRef = input.actions.mint(
          resolved.owner,
          input.scope(),
          value.binding.uiResourceGeneration,
        );
      } catch {
        return stale();
      }
      return dispatch(resolved, built.value);
    },
    hold: async (value) => {
      const key = holdKey(value.binding, value.inputToken);
      if (value.phase !== "begin") {
        // Always stop before validating a changed form, awaiting launch, or invoking plugin code.
        const held = holds.get(key);
        intent.end(value.binding, value.inputToken, value.phase);
        holds.delete(key);
        if (held) {
          const resolved = resolve(value.binding);
          if (resolved) {
            const context = { ...held.invocation.context };
            delete context.actionRef;
            const ending: CommandInvocation = {
              ...held.invocation,
              invocationId: randomUUID(),
              context: {
                ...context,
                trigger: { kind: "hold", phase: value.phase, gestureRef: held.gesture },
              },
            };
            void dispatch(resolved, ending);
          }
        }
        return { ok: true, value: { gesture: null } };
      }
      const resolved = resolve(value.binding);
      if (!resolved) return stale();
      const limited = admission(resolved.owner);
      if (limited) return limited;
      const built = buildInvocation(
        resolved,
        value.nodeId,
        value.formRevision,
        value.form,
        { kind: "hold", phase: "begin", gestureRef: randomUUID() },
        undefined,
        intent.scope(value.binding),
      );
      if (
        !built.ok ||
        !execution.acceptForm(value.binding, value.formRevision, built.value.context.form!.values)
      )
        return stale();
      const gesture = intent.begin(value.binding, value.inputToken);
      if (!gesture) return stale();
      built.value.context.trigger = { kind: "hold", phase: "begin", gestureRef: gesture };
      try {
        built.value.context.actionRef = input.actions.mint(
          resolved.owner,
          input.scope(),
          value.binding.uiResourceGeneration,
        );
      } catch {
        intent.end(value.binding, value.inputToken, "cancel");
        return stale();
      }
      holds.set(key, { owner: resolved.owner, invocation: built.value, gesture });
      const result = await dispatch(resolved, built.value);
      if (!result.ok) {
        intent.end(value.binding, value.inputToken, "cancel");
        holds.delete(key);
        return result;
      }
      return {
        ok: true,
        value: {
          gesture: intent.liveGesture(value.binding, value.inputToken, gesture) ? gesture : null,
        },
      };
    },
    pulse: async (value) =>
      intent.pulse(value.binding, value.challenge, value.gesture, value.inputToken)
        ? { ok: true, value: { accepted: true } }
        : stale(),
    snapshot: (value) => execution.snapshot(value),
    reportFailure: (value) => execution.reportFailure(value),
    onEvent: input.events.subscribe,
  };
  const offLifetime = input.events.subscribe((event) => {
    if (event.type === "revoked") abort(event.binding);
  });
  const diagnostics = registerFoundationDiagnostics(bridge, () => ({
    owners: 0,
    bindings: 0,
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
    timers: intent.timerCount(),
    pendingInvocations: [...inflight.values()].reduce((sum, requests) => sum + requests.size, 0),
    actionTokens: input.actions.count() + (input.coreActionCount?.() ?? 0),
    resourceReaders: 0,
    workerJobs: 0,
  }));
  bridgeDisposals.set(bridge, () => {
    if (disposed) return;
    disposed = true;
    for (const requests of inflight.values()) for (const request of requests) request.abort();
    inflight.clear();
    pending.clear();
    holds.clear();
    offLifetime();
    intent.dispose();
    input.actions.dispose();
    diagnostics.dispose();
  });
  return bridge;
}

const handleSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const local = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const bindingSchema = z.strictObject({
  contributionId: namespacedIdSchema,
  panelInstance: handleSchema,
  kind: z.enum(["panel", "status"]),
  uiResourceGeneration: counter,
  generation: counter,
  hostEpoch: handleSchema,
  processEpoch: handleSchema,
});
const scalar = z.union([
  z
    .string()
    .max(8000)
    .refine(
      (value) =>
        Array.from(value).length <= 4000 &&
        !value.includes("\0") &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    ),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const formSchema = z
  .record(local, scalar)
  .refine(
    (value) =>
      Object.keys(value).length <= 32 && Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024,
  );
const actionInput = {
  binding: bindingSchema,
  nodeId: local,
  formRevision: counter,
  form: formSchema,
};
export function registerUiIpc(input: {
  handle: IpcHandle;
  bridge: PluginUiBridge;
  trusted(event: { sender: { id: number }; senderFrame: unknown }): boolean;
}): void {
  const register = <T>(channel: string, schema: z.ZodType<T>, action: (value: T) => unknown) => {
    input.handle(channel, (event, value: unknown) => {
      if (!input.trusted(event)) return stale();
      const parsed = schema.safeParse(value);
      return parsed.success ? action(parsed.data) : stale();
    });
  };
  register("plugins:ui:catalog", z.strictObject({ cursor: handleSchema.optional() }), (value) =>
    input.bridge.catalog(value.cursor === undefined ? {} : { cursor: value.cursor }),
  );
  register(
    "plugins:ui:resource",
    z.strictObject({
      sourceKey: sourceKeySchema,
      id: namespacedIdSchema,
      uiResourceGeneration: counter,
      resourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    (value) => input.bridge.resource(value),
  );
  register(
    "plugins:ui:open",
    z.strictObject({
      sourceKey: sourceKeySchema,
      id: namespacedIdSchema,
      uiResourceGeneration: counter,
    }),
    (value) => input.bridge.open(value),
  );
  register("plugins:ui:close", z.strictObject({ binding: bindingSchema }), (value) =>
    input.bridge.close(value),
  );
  register(
    "plugins:ui:visibility",
    z.strictObject({
      binding: bindingSchema,
      visible: z.boolean(),
      reason: z.enum(["tab", "sidebar", "collapse", "document", "window"]),
    }),
    (value) => input.bridge.visibility(value),
  );
  register("plugins:ui:invoke", z.strictObject(actionInput), (value) => input.bridge.invoke(value));
  register(
    "plugins:ui:hold",
    z.strictObject({
      ...actionInput,
      phase: z.enum(["begin", "end", "cancel"]),
      inputToken: handleSchema,
    }),
    (value) => input.bridge.hold(value),
  );
  register(
    "plugins:ui:pulse",
    z.strictObject({
      binding: bindingSchema,
      challenge: handleSchema,
      gesture: handleSchema.nullable(),
      inputToken: handleSchema.nullable(),
    }),
    (value) => input.bridge.pulse(value),
  );
  register("plugins:ui:snapshot", z.strictObject({ binding: bindingSchema }), (value) =>
    input.bridge.snapshot(value),
  );
  register(
    "plugins:ui:report-failure",
    z.strictObject({
      sourceKey: sourceKeySchema,
      id: namespacedIdSchema,
      uiResourceGeneration: counter,
      catalogRevision: counter,
      reason: z.enum(["validation", "renderer"]),
      fieldPath: z.string().max(512).optional(),
    }),
    (value) => {
      const { fieldPath, ...rest } = value;
      return input.bridge.reportFailure({
        ...rest,
        ...(fieldPath === undefined ? {} : { fieldPath }),
      });
    },
  );
}

const scheduledStateFlushes = new WeakSet<UiStateRegistry>();
/** Each preload listener receives its own atomic catalog/status replay. */
export function registerUiEventIpc(input: {
  handle: IpcHandle;
  bridge: Pick<PluginUiBridge, "onEvent">;
  trusted(event: { sender: { id: number }; senderFrame: unknown }): boolean;
  send(channel: string, event: UiBridgeEvent): void;
}): () => void {
  const listeners = new Map<number, () => void>();
  const valid = (id: unknown): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  // This is a local renderer observer bound, independent of plugin RPC streams.
  const limit = UI_LIMITS_V1.hostPanels + UI_LIMITS_V1.hostStatus;
  input.handle("plugins:ui:subscribe", (event, id: unknown) => {
    if (!input.trusted(event) || !valid(id)) return false;
    if (listeners.has(id)) return true;
    if (listeners.size >= limit) return false;
    const off = input.bridge.onEvent((value) => {
      if (input.trusted(event)) input.send(`plugins:ui:event:${id}`, value);
    });
    listeners.set(id, off);
    return true;
  });
  input.handle("plugins:ui:unsubscribe", (event, id: unknown) => {
    if (!input.trusted(event) || !valid(id)) return false;
    listeners.get(id)?.();
    listeners.delete(id);
    return true;
  });
  return () => {
    for (const off of listeners.values()) off();
    listeners.clear();
  };
}

function flushStateAfterReply(states: UiStateRegistry): void {
  if (scheduledStateFlushes.has(states)) return;
  scheduledStateFlushes.add(states);
  queueMicrotask(() => {
    scheduledStateFlushes.delete(states);
    states.flush();
  });
}

export function createUiChannelBinding(
  context: Stage3ChannelContext,
  input: {
    states: UiStateRegistry;
    subscriptions: UiSubscriptions;
    catalog: UiCatalog;
    runtime: UiRuntimeAttachment;
    attachment: DeviceChannelAttachment;
    scope(): CoreWindowScope;
  },
): Stage3ChannelBinding {
  let disposed = false,
    negotiated = false,
    initialized = false,
    ready = false;
  const lifetime = new AbortController();
  const checkOwner = () => {
    const principal = context.principal();
    if (
      disposed ||
      context.peer.closed ||
      principal.kind !== "plugin" ||
      !sameResourceOwner(principal.owner, context.owner) ||
      !sameResourceOwner(input.attachment.owner, context.owner) ||
      !input.runtime.current(context.owner)
    )
      throw new RpcError(RPC_ERRORS.invalidParams, "Stale UI channel owner.");
  };
  const check = (request: RequestContext) => {
    request.signal.throwIfAborted();
    checkOwner();
    if (!negotiated) throw new RpcError(RPC_ERRORS.invalidParams, "UI domain is not negotiated.");
  };
  context.peer.handle("ui/instances", (params, request) => {
    check(request);
    uiRequestSchemas["ui/instances"].params.parse(params);
    return uiRequestSchemas["ui/instances"].result.parse({
      ok: true,
      value: { instances: input.states.instances(context.owner) },
    });
  });
  context.peer.handle("ui/state", (params, request) => {
    check(request);
    const parsed = uiRequestSchemas["ui/state"].params.parse(params);
    return uiRequestSchemas["ui/state"].result.parse(
      input.states.state(context.owner, parsed.binding),
    );
  });
  context.peer.handle("ui/patch", (params, request) => {
    check(request);
    const parsed = uiRequestSchemas["ui/patch"].params.parse(params);
    const result = input.states.patch(context.owner, parsed);
    if (result.ok) {
      // Committed data must reach the renderer even if its RPC reply is abandoned.
      // One microtask per registry coalesces notifications without per-panel timers.
      const flush = () => flushStateAfterReply(input.states);
      request.afterReply(flush, flush);
    }
    return uiRequestSchemas["ui/patch"].result.parse(result);
  });
  context.peer.handle("ui/snapshot", (params, request) => {
    check(request);
    const parsed = uiRequestSchemas["ui/snapshot"].params.parse(params);
    return uiRequestSchemas["ui/snapshot"].result.parse(
      input.subscriptions.snapshot(context.owner, parsed.subscriptionId),
    );
  });
  context.peer.handle("ui/subscribe", (params, request) => {
    check(request);
    const parsed = uiRequestSchemas["ui/subscribe"].params.parse(params);
    const result = input.subscriptions.subscribe(context.owner, parsed);
    if (result.ok) {
      const id = result.value.subscriptionId;
      // Register abandon before validation/send; failed serialization and cancellation share it.
      request.afterReply(
        () => {
          try {
            check(request);
            input.attachment.activate(id);
          } catch {
            input.attachment.abandon(id);
          }
        },
        () => input.attachment.abandon(id),
      );
    }
    return uiRequestSchemas["ui/subscribe"].result.parse(result);
  });
  return {
    async initialized(signal) {
      checkOwner();
      signal.throwIfAborted();
      if (initialized) throw new Error("UI initialized twice.");
      initialized = true;
      if (!input.catalog.declaresUi(context.owner)) return;
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const initialBindings = input.states.initialBindingsReady(context.owner, combined);
      void initialBindings.catch(() => undefined);
      const result = uiRequestSchemas["ui/negotiate"].result.parse(
        await context.peer.request(
          "ui/negotiate",
          { commandEnvelopeVersions: [1], uiResourceVersions: [1] },
          { signal: combined, timeoutMs: remainingActivationMs(signal) },
        ),
      );
      checkOwner();
      combined.throwIfAborted();
      if (
        !result.ok ||
        !result.value.commandEnvelopeVersions.some((version) => version === 1) ||
        !result.value.uiResourceVersions.some((version) => version === 1)
      )
        throw new Error("Declared UI is unsupported by the negotiated SDK.");
      input.attachment.negotiated("ui", 1);
      negotiated = true;
      // A process was explicitly activated already. Bind its statuses to this
      // host-owned workbench before ready, without recursively starting it.
      const scope = input.scope();
      let cursor: string | undefined;
      let revision: number | undefined;
      do {
        const page = await input.catalog.catalog(cursor ? { cursor } : {});
        checkOwner();
        combined.throwIfAborted();
        if (!page.ok || (revision !== undefined && revision !== page.value.revision))
          throw new Error("UI catalog changed during initialization.");
        revision = page.value.revision;
        for (const entry of page.value.entries) {
          if (
            entry.kind !== "status" ||
            entry.availability !== "available" ||
            entry.sourceKey !== context.owner.sourceKey ||
            entry.pluginId !== context.owner.pluginId
          )
            continue;
          const resource = await input.catalog.resource({
            sourceKey: entry.sourceKey,
            id: entry.id,
            uiResourceGeneration: entry.uiResourceGeneration,
            resourceDigest: entry.resourceDigest,
          });
          checkOwner();
          combined.throwIfAborted();
          if (!resource.ok) throw new Error("Status resource unavailable during initialization.");
          const opened = await input.states.open({
            owner: resource.value.owner,
            id: entry.id,
            scope,
            resource: resource.value.resource,
            signal: combined,
            activateInitialized: async () => context,
          });
          if (!opened.ok) throw new Error("Status binding unavailable during initialization.");
        }
        cursor = page.value.nextCursor ?? undefined;
      } while (cursor);
      const currentScope = input.scope();
      if (
        scope.hostEpoch !== currentScope.hostEpoch ||
        scope.workbenchInstance !== currentScope.workbenchInstance
      )
        throw new Error("Workbench changed during UI initialization.");
      await initialBindings;
      checkOwner();
    },
    async ready(signal) {
      checkOwner();
      signal.throwIfAborted();
      if (!initialized || ready) throw new Error("Invalid UI ready phase.");
      ready = true;
      if (!input.catalog.declaresUi(context.owner)) return;
      if (!negotiated) throw new Error("UI negotiation is incomplete.");
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const result = uiRequestSchemas["ui/ready"].result.parse(
        await context.peer.request(
          "ui/ready",
          {},
          { signal: combined, timeoutMs: remainingActivationMs(signal) },
        ),
      );
      checkOwner();
      combined.throwIfAborted();
      if (!result.ok) throw new Error("Plugin UI ready failed.");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      negotiated = false;
      lifetime.abort(new Error("UI channel disposed."));
      input.states.cancelInitialBindings(context.owner);
      input.states.retireExecution(context.owner, "process-gone");
      input.subscriptions.retire(context.owner);
      // Existing void-returning handle API: replace with inert handlers, never remove shared routes.
      for (const method of [
        "ui/instances",
        "ui/state",
        "ui/patch",
        "ui/snapshot",
        "ui/subscribe",
      ] as const)
        context.peer.handle(method, () => {
          throw new RpcError(RPC_ERRORS.methodNotFound, "UI channel disposed.");
        });
    },
  };
}

export function createUiExecutionAdapter(input: {
  catalog: UiCatalog;
  states: UiStateRegistry;
  scope(): CoreWindowScope;
  runtime: UiRuntimeAttachment;
  core: UiExecutionAdapter["core"];
  now?: () => number;
}): UiExecutionAdapter {
  const openings = new Set<AbortController>();
  let disposed = false;
  const now = input.now ?? (() => performance.now());
  // A bounded completed-operation receipt allows lost-reply retries without
  // retaining resource trees or reviving a retired binding. It uses the existing
  // host completed-operation budget and 30-second retention window.
  const closed = new Map<
    string,
    {
      binding: UiBinding;
      owner: ResourceOwner;
      scope: CoreWindowScope;
      time: number;
    }
  >();
  const pruneClosed = () => {
    let scope: CoreWindowScope;
    try {
      scope = input.scope();
    } catch {
      closed.clear();
      return;
    }
    for (const [id, receipt] of closed) {
      if (
        now() - receipt.time >= UI_LIMITS_V1.invocationRetentionMs ||
        !input.runtime.current(receipt.owner) ||
        !input.catalog.isCurrent({
          ...receipt.owner,
          uiResourceGeneration: receipt.binding.uiResourceGeneration,
        }) ||
        receipt.scope.hostEpoch !== scope.hostEpoch ||
        receipt.scope.workbenchInstance !== scope.workbenchInstance
      )
        closed.delete(id);
    }
  };
  const offClosedCatalog = input.catalog.onEvent(pruneClosed);
  // Only binding metadata lives here. All data/form/visibility/revisions stay in T2's registry.
  const metadata = new Map<string, Omit<ResolvedUi, "state"> & { binding: UiBinding }>();
  const offMetadata = input.states.onEvent((_owner, event) => {
    if (event.kind === "ui.revoked") metadata.delete(event.data.binding.panelInstance);
  });
  const resolve = (binding: UiBinding): ResolvedUi | null => {
    const entry = metadata.get(binding.panelInstance);
    const scope = input.scope();
    if (
      !entry ||
      !sameUiBinding(entry.binding, binding) ||
      !input.runtime.current(entry.owner) ||
      entry.workbenchInstance !== scope.workbenchInstance ||
      entry.owner.hostEpoch !== scope.hostEpoch
    )
      return null;
    const snapshot = input.states.state(entry.owner, binding);
    if (!snapshot.ok) return null;
    return {
      owner: entry.owner,
      resource: entry.resource,
      workbenchInstance: entry.workbenchInstance,
      contextRef: input.runtime.context(entry.owner, scope)?.ref ?? null,
      commands: new Map(
        input.runtime.commands(entry.owner.sourceKey).map((command) => [command.id, command]),
      ),
      state: snapshot.value,
    };
  };
  return {
    resolve,
    invoke: (owner, invocation, signal) => input.runtime.invoke(owner, invocation, signal),
    core: input.core,
    dispose: () => {
      disposed = true;
      for (const opening of openings) opening.abort();
      openings.clear();
      offMetadata();
      offClosedCatalog();
      closed.clear();
      metadata.clear();
    },
    open: async (value) => {
      if (disposed) return stale();
      const opening = new AbortController();
      openings.add(opening);
      try {
        let cursor: string | undefined;
        for (;;) {
          const page = await input.catalog.catalog(cursor === undefined ? {} : { cursor });
          if (!page.ok) return page;
          const descriptor = page.value.entries.find(
            (entry) =>
              entry.sourceKey === value.sourceKey &&
              entry.id === value.id &&
              entry.uiResourceGeneration === value.uiResourceGeneration,
          );
          if (descriptor) {
            const resource = await input.catalog.resource({
              ...value,
              resourceDigest: descriptor.resourceDigest,
            });
            if (!resource.ok) return resource;
            const scope = input.scope();
            const state = await input.states.open({
              owner: resource.value.owner,
              id: value.id,
              scope,
              resource: resource.value.resource,
              signal: opening.signal,
              activateInitialized: (sourceKey, signal) =>
                input.runtime.activateInitialized(sourceKey, signal),
            });
            if (!state.ok) return state;
            const owner = input.states.executionOwner(state.value.binding);
            const currentScope = input.scope();
            if (
              disposed ||
              opening.signal.aborted ||
              !owner ||
              !input.runtime.current(owner) ||
              scope.hostEpoch !== currentScope.hostEpoch ||
              scope.workbenchInstance !== currentScope.workbenchInstance
            )
              return stale();
            metadata.set(state.value.binding.panelInstance, {
              owner,
              binding: state.value.binding,
              resource: resource.value.resource,
              workbenchInstance: scope.workbenchInstance,
              contextRef: input.runtime.context(owner, scope)?.ref ?? null,
              commands: new Map(
                input.runtime.commands(owner.sourceKey).map((command) => [command.id, command]),
              ),
            });
            await input.runtime.ready(owner, opening.signal);
            if (
              disposed ||
              opening.signal.aborted ||
              !input.runtime.current(owner) ||
              scope.hostEpoch !== input.scope().hostEpoch ||
              scope.workbenchInstance !== input.scope().workbenchInstance
            )
              return stale();
            return state;
          }
          if (page.value.nextCursor === null) return stale();
          cursor = page.value.nextCursor;
        }
      } catch {
        return stale();
      } finally {
        openings.delete(opening);
      }
    },
    close: async ({ binding }) => {
      if (disposed) return stale();
      pruneClosed();
      const previous = closed.get(binding.panelInstance);
      if (previous && sameUiBinding(previous.binding, binding))
        return { ok: true, value: { closed: true } };
      const value = resolve(binding);
      if (!value) return stale();
      const result = input.states.close(value.owner, binding);
      metadata.delete(binding.panelInstance);
      if (result.ok) {
        closed.set(binding.panelInstance, {
          binding: { ...binding },
          owner: { ...value.owner },
          scope: { ...input.scope() },
          time: now(),
        });
        while (closed.size > UI_LIMITS_V1.hostCompletedInvocations)
          closed.delete(closed.keys().next().value!);
      }
      return result;
    },
    visibility: async ({ binding, visible }) => {
      const value = resolve(binding);
      return value ? input.states.visibility(value.owner, binding, visible) : stale();
    },
    snapshot: async ({ binding }) => {
      const value = resolve(binding);
      if (value) return { ok: true, value: value.state };
      const status = currentStatusBindings(input.states, input.scope()).find((entry) =>
        sameUiBinding(entry.binding, binding),
      );
      if (!status) return stale();
      for (const owner of input.runtime.owners()) {
        if (
          !input.runtime.current(owner) ||
          owner.hostEpoch !== binding.hostEpoch ||
          owner.processEpoch !== binding.processEpoch ||
          owner.generation !== binding.generation
        )
          continue;
        const result = input.states.state(owner, binding);
        if (result.ok) return result;
      }
      return stale();
    },
    acceptForm: (binding, revision, values) => {
      const value = resolve(binding);
      if (!value) return false;
      return input.states.setForm(value.owner, binding, revision, values, true).ok;
    },
    reportFailure: (value) => input.catalog.reportFailure(value),
  };
}

export class UiBridgeEvents {
  readonly #listeners = new Set<(event: UiBridgeEvent) => void>();
  #disposed = false;
  constructor(private readonly replay: () => readonly UiBridgeEvent[]) {}
  publish = (event: UiBridgeEvent): void => {
    if (this.#disposed) return;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* observers cannot retain authority */
      }
    }
  };
  subscribe = (listener: (event: UiBridgeEvent) => void): (() => void) => {
    if (this.#disposed) return () => {};
    const pending: UiBridgeEvent[] = [];
    let replaying = true;
    const receive = (event: UiBridgeEvent) => {
      if (replaying) pending.push(event);
      else listener(event);
    };
    this.#listeners.add(receive);
    try {
      const initial = this.replay();
      for (const event of initial) listener(event);
      for (let i = 0; i < pending.length; i++) listener(pending[i]!);
      replaying = false;
    } catch (error) {
      this.#listeners.delete(receive);
      throw error;
    }
    return () => {
      this.#listeners.delete(receive);
    };
  };
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}

export function createUiRegistry(input: {
  hostEpoch: Handle;
  broker: { readonly events: CommonEventLedgerPort };
  now(): number;
  beforeDelivery(sourceKey: string): void;
  revokeIntent(owner: ResourceOwner, binding?: UiBinding): void;
}): { catalog: UiCatalog; states: UiStateRegistry; subscriptions: UiSubscriptions } {
  const catalog = new UiCatalog(input.hostEpoch, {
    now: input.now,
    beforeDelivery: input.beforeDelivery,
  });
  const states = new UiStateRegistry({
    now: input.now,
    current: (owner) => catalog.isCurrent(owner),
    eventCounters: () => input.broker.events.diagnostics(),
  });
  const ledger: UiEventLedgerPort = uiEventLedgerPort(input.broker.events);
  const subscriptions = new UiSubscriptions(states, ledger, input.revokeIntent);
  return { catalog, states, subscriptions };
}

const foundationDiagnostics = new WeakMap<object, FoundationDiagnostics>();
const diagnosticEmitters = new WeakMap<object, (event: FoundationDiagnosticEvent) => void>();
/** Host-only observer seam, not exported through runtime, preload or any RPC. */
export function observeUiSite(instance: object, event: FoundationDiagnosticEvent): void {
  diagnosticEmitters.get(instance)?.(event);
}
function registerFoundationDiagnostics(instance: object, read: () => FoundationCounters) {
  const listeners = new Set<(event: FoundationDiagnosticEvent) => void>();
  foundationDiagnostics.set(instance, {
    snapshot: () => Object.freeze({ ...read() }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const emit = (event: FoundationDiagnosticEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* observation only */
      }
    }
  };
  diagnosticEmitters.set(instance, emit);
  return {
    dispose() {
      listeners.clear();
      diagnosticEmitters.delete(instance);
    },
  };
}
export function diagnosticsFor(instance: object): FoundationDiagnostics {
  const value = foundationDiagnostics.get(instance);
  if (!value) throw new Error("Unknown foundation instance.");
  return value;
}

const bridgeDisposals = new WeakMap<PluginUiBridge, () => void>();
export function disposePluginUiBridge(bridge: PluginUiBridge): void {
  const dispose = bridgeDisposals.get(bridge);
  if (!dispose) throw new Error("Unknown UI bridge.");
  dispose();
}
