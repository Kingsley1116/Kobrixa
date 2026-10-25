import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UiClient,
  type ContextCommandContext,
  type ContextCommandHandler,
  type DevicesClient,
  type PluginContext,
} from "@kobrixa/plugin-sdk";
import {
  commandInvocationSchema,
  deviceRequestSchemas,
  deviceSessionSnapshotSchema,
  eventEnvelopeSchema,
  evaluateCondition,
  motionSnapshotSchema,
  panelResourceV1Schema,
  statusResourceV1Schema,
  validateUiData,
  sourceCatalogSchema,
  uiBindingSchema,
  uiEventEnvelopeSchema,
  uiRequestSchemas,
  type DeviceEvent,
  type DeviceListValue,
  type DeviceMethod,
  type DeviceParams,
  type DeviceResult,
  type DeviceSubscriptionParams,
  type MotionSnapshot,
  type UiBinding,
  type UiEventEnvelope,
  type UiRequestMap,
  type UiScalar,
} from "@kobrixa/plugin-protocol";
import { createMotorPlugin } from "./feature.js";
import { PORTS, initialForm } from "./model.js";

const panelResource = panelResourceV1Schema.parse(
  JSON.parse(readFileSync(new URL("../panel.json", import.meta.url), "utf8")),
);
const statusResource = statusResourceV1Schema.parse(
  JSON.parse(readFileSync(new URL("../status.json", import.meta.url), "utf8")),
);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = {
  sourceKey: "builtin:motor",
  pluginId: "kobrixa.motor-test",
  processEpoch: id(91),
  hostEpoch: id(90),
  generation: 1,
};
const binding = uiBindingSchema.parse({
  contributionId: "kobrixa.motor-test.panel",
  panelInstance: id(1),
  kind: "panel",
  uiResourceGeneration: 1,
  generation: 1,
  hostEpoch: id(90),
  processEpoch: id(91),
});
const status = uiBindingSchema.parse({
  ...binding,
  contributionId: "kobrixa.motor-test.status",
  panelInstance: id(2),
  kind: "status",
});
const snap = (changes: Partial<MotionSnapshot> = {}) =>
  motionSnapshotSchema.parse({
    operationId: id(10),
    sessionId: id(3),
    revision: 1,
    phase: "preparing",
    stage: "prepared",
    startAccepted: false,
    stopRequested: false,
    dispatch: "not-sent",
    movement: "not-started",
    stopConfirmation: "not-required",
    brakeRequired: false,
    elapsedMs: 0,
    angle: null,
    displacement: null,
    preparedRemainingMs: 5000,
    ...changes,
  });
function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
// Drain only the bounded promise chains in this fixture; no wall-clock polling.
async function drain() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function fixture() {
  let serial = 100;
  let session = deviceSessionSnapshotSchema.parse({
    sessionId: id(3),
    providerId: "kobrixa.ev3",
    providerGeneration: 1,
    revision: 1,
    name: "EV3",
    transport: "usb",
    capabilities: ["finiteMotion.v1"],
    state: "connected",
    foreground: "none",
    recording: false,
    sourceRevision: 1,
  });
  let sources = sourceCatalogSchema.parse({
    sessionId: session.sessionId,
    sourceRevision: 1,
    channels: [],
    actuators: [{ actuatorId: id(4), portId: "A", name: "Motor", typeId: "large", state: "ready" }],
  });
  let operation = snap();
  let visible = true;
  let instances: UiBinding[] = [binding, status];
  const revisions = new Map<string, number>();
  const resourceData = new Map<string, Record<string, UiScalar>>();
  function data(b: UiBinding) {
    const k = JSON.stringify(b);
    if (!resourceData.has(k)) {
      const resource = b.kind === "panel" ? panelResource : statusResource;
      resourceData.set(
        k,
        Object.fromEntries(
          Object.entries(resource.data).map(([name, slot]) => [name, slot.initial]),
        ),
      );
    }
    return resourceData.get(k)!;
  }
  const handlers = new Map<string, ContextCommandHandler>();
  const deviceListeners = new Map<
    string,
    {
      params: DeviceSubscriptionParams;
      listener: (event: DeviceEvent) => void | Promise<void>;
      sequence: number;
    }
  >();
  const uiListeners = new Map<
    string,
    {
      binding?: UiBinding;
      listener: (event: UiEventEnvelope) => void | Promise<void>;
      sequence: number;
    }
  >();
  const disposed: string[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const patches: { binding: UiBinding; set: Record<string, UiScalar>; time: number }[] = [];
  const overrides = new Map<DeviceMethod, (params: unknown) => Promise<unknown>>();
  const list = (): DeviceListValue => ({
    revision: 1,
    providers: [
      { providerId: session.providerId, state: "available", capabilities: ["finiteMotion.v1"] },
    ],
    sessions: [session],
  });
  async function call<M extends DeviceMethod>(
    method: M,
    params: DeviceParams<M>,
  ): Promise<DeviceResult<M>> {
    deviceRequestSchemas[method].params.parse(params);
    requests.push({ method, params });
    let value: unknown;
    if (overrides.has(method))
      return deviceRequestSchemas[method].result.parse(
        await overrides.get(method)!(params),
      ) as DeviceResult<M>;
    switch (method) {
      case "devices/negotiate":
        value = {
          devicesContractVersion: 1,
          eventVersion: 1,
          capabilities: [
            { capability: "finiteMotion.v1", state: "available", providerId: session.providerId },
          ],
          requirementsSatisfied: true,
        };
        break;
      case "devices/list":
        value = list();
        break;
      case "devices/session":
        value = { session, sources };
        break;
      case "devices/context":
        value = { contextRef: id(5), revision: 1, state: "local", reason: "local" };
        break;
      case "devices/motion/prepare":
        operation = snap();
        value = { operation };
        break;
      case "devices/motion/start":
        operation = snap({
          revision: 2,
          phase: "running",
          stage: "moving",
          startAccepted: true,
          dispatch: "sent",
          stopConfirmation: "pending",
        });
        value = { operation };
        break;
      case "devices/motion/query":
        value = { operation };
        break;
      case "devices/motion/stop":
        operation = snap({
          revision: operation.revision + 1,
          phase: "stopped",
          stage: "terminal",
          stopRequested: true,
          stopConfirmation: "confirmed",
        });
        value = { operation };
        break;
      default:
        throw new Error(`Unexpected public request ${method}`);
    }
    return deviceRequestSchemas[method].result.parse({ ok: true, value }) as DeviceResult<M>;
  }
  const method =
    <M extends DeviceMethod>(name: M) =>
    (params: DeviceParams<M>) =>
      call(name, params);
  const devices: DevicesClient = {
    negotiate: () => call("devices/negotiate", {}),
    context: method("devices/context"),
    list: method("devices/list"),
    session: method("devices/session"),
    discover: method("devices/discover"),
    connect: method("devices/connect"),
    disconnect: method("devices/disconnect"),
    read: method("devices/read"),
    inputModes: {
      query: method("devices/inputModes/query"),
      set: method("devices/inputModes/set"),
    },
    recording: {
      reserve: method("devices/recording/reserve"),
      query: method("devices/recording/query"),
      read: method("devices/recording/read"),
      release: method("devices/recording/release"),
    },
    motion: {
      prepare: method("devices/motion/prepare"),
      start: method("devices/motion/start"),
      query: method("devices/motion/query"),
      stop: method("devices/motion/stop"),
    },
    async subscribe(params, listener) {
      deviceRequestSchemas["devices/subscribe"].params.parse(params);
      const subscriptionId = id(serial++);
      const snapshot =
        params.topic === "catalog"
          ? list()
          : params.topic === "motion"
            ? operation
            : params.topic === "authority"
              ? { contextRef: id(5), revision: 1, state: "local", reason: "local" }
              : { session, sources };
      const result = deviceRequestSchemas["devices/subscribe"].result.parse({
        ok: true,
        value: { subscriptionId, sequence: 0, snapshot },
      });
      if (!result.ok) throw new Error("fixture");
      deviceListeners.set(subscriptionId, { params, listener, sequence: 0 });
      return {
        ok: true,
        value: {
          subscriptionId,
          snapshot: result.value.snapshot,
          lastSequence: 0,
          async dispose() {
            disposed.push(subscriptionId);
            deviceListeners.delete(subscriptionId);
            return { ok: true, value: { removed: true } };
          },
        },
      };
    },
  };
  const ui = new UiClient(
    async () => {
      throw new Error("Unused raw UI request");
    },
    { adopt() {}, forget() {} },
  );
  const state = (b: UiBinding) => ({
    binding: b,
    revision: revisions.get(JSON.stringify(b)) ?? 0,
    data: { ...data(b) },
    formRevision: 1,
    form: initialForm(),
    valid: true,
    visible,
    locale: "en" as const,
  });
  function checked<M extends keyof UiRequestMap>(
    method: M,
    params: UiRequestMap[M]["params"],
    value: unknown,
  ): UiRequestMap[M]["result"] {
    uiRequestSchemas[method].params.parse(params);
    requests.push({ method, params });
    return uiRequestSchemas[method].result.parse({ ok: true, value }) as UiRequestMap[M]["result"];
  }
  vi.spyOn(ui, "instances").mockImplementation(async () =>
    checked("ui/instances", {}, { instances }),
  );
  vi.spyOn(ui, "state").mockImplementation(async (b) =>
    checked("ui/state", { binding: b }, state(b)),
  );
  vi.spyOn(ui, "patch").mockImplementation(async (b, baseRevision, set) => {
    const merged = { ...data(b), ...set };
    expect(validateUiData(b.kind === "panel" ? panelResource : statusResource, merged).ok).toBe(
      true,
    );
    resourceData.set(JSON.stringify(b), merged);
    patches.push({ binding: b, set, time: performance.now() });
    revisions.set(JSON.stringify(b), baseRevision + 1);
    return checked("ui/patch", { binding: b, baseRevision, set }, { revision: baseRevision + 1 });
  });
  vi.spyOn(ui, "subscribe").mockImplementation(async (params, listener) => {
    const subscriptionId = id(serial++);
    uiListeners.set(subscriptionId, {
      ...(params.binding ? { binding: params.binding } : {}),
      listener,
      sequence: 0,
    });
    return checked("ui/subscribe", params, {
      subscriptionId,
      sequence: 0,
      snapshot: {
        instances,
        states: params.binding ? [state(params.binding)] : [],
        locale: "en",
        theme: "light",
      },
    });
  });
  vi.spyOn(ui, "unsubscribe").mockImplementation(async (subscriptionId) => {
    deviceRequestSchemas["events/unsubscribe"].params.parse({ subscriptionId });
    disposed.push(subscriptionId);
    uiListeners.delete(subscriptionId);
    return { ok: true, value: { removed: true } };
  });
  const context: PluginContext = {
    pluginId: "kobrixa.motor-test",
    locale: "en",
    devices,
    ui,
    commands: {
      register() {
        throw new Error("Use registerContext");
      },
      registerContext(name, _schema, handler) {
        if (handlers.has(name)) throw new Error("duplicate registration");
        handlers.set(name, handler);
      },
    },
  };
  const plugin = createMotorPlugin();
  async function boot() {
    await plugin.activate(context);
    await plugin.ready?.(context);
    await drain();
    await vi.advanceTimersByTimeAsync(0);
  }
  function invocation(
    name = "start",
    changes: Partial<ContextCommandContext["context"]> = {},
    args: Record<string, UiScalar> = {},
  ): ContextCommandContext {
    const wire = commandInvocationSchema.parse({
      version: 1,
      invocationId: id(serial++),
      command: `kobrixa.motor-test.${name}`,
      arguments: args,
      context: {
        contextRef: id(5),
        origin: "panel",
        locale: "en",
        binding,
        motionScopeRef: id(6),
        form: {
          revision: 1,
          values: { ...initialForm(), "a-mode": name === "jog" ? "jog" : "timed" },
        },
        trigger: { kind: "activate" },
        ...changes,
      },
    });
    return { ...wire, signal: new AbortController().signal };
  }
  async function invoke(c = invocation()) {
    return handlers.get(c.command)!(c);
  }
  async function select() {
    await invoke(invocation("select-current"));
    await drain();
  }
  function uiEvent(kind: UiEventEnvelope["kind"], data: unknown, gap = false) {
    for (const [subscriptionId, slot] of [...uiListeners]) {
      const eventBinding = (data as { binding?: UiBinding }).binding;
      if (
        eventBinding ? JSON.stringify(slot.binding) !== JSON.stringify(eventBinding) : slot.binding
      )
        continue;
      slot.sequence += gap ? 2 : 1;
      const event = uiEventEnvelopeSchema.parse({
        version: 1,
        subscriptionId,
        owner,
        sequence: slot.sequence,
        delivery: "control",
        kind,
        data,
      });
      void slot.listener(event);
    }
  }
  function deviceEvent(
    topic: DeviceSubscriptionParams["topic"],
    kind: DeviceEvent["kind"],
    data: unknown,
    gap = false,
  ) {
    for (const [subscriptionId, slot] of [...deviceListeners])
      if (slot.params.topic === topic) {
        slot.sequence += gap ? 2 : 1;
        void slot.listener(
          eventEnvelopeSchema.parse({
            version: 1,
            subscriptionId,
            owner,
            sequence: slot.sequence,
            delivery: "control",
            kind,
            data,
          }),
        );
      }
  }
  const calls = (method: string) => requests.filter((r) => r.method === method);
  return {
    plugin,
    context,
    boot,
    select,
    invoke,
    invocation,
    uiEvent,
    deviceEvent,
    calls,
    requests,
    patches,
    data,
    overrides,
    deviceListeners,
    uiListeners,
    disposed,
    list,
    get session() {
      return session;
    },
    set session(value) {
      session = value;
    },
    get sources() {
      return sources;
    },
    set sources(value) {
      sources = value;
    },
    get operation() {
      return operation;
    },
    set operation(value) {
      operation = value;
    },
    set visible(value: boolean) {
      visible = value;
    },
    set instances(value: UiBinding[]) {
      instances = value;
    },
  };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers();
  f = fixture();
});
afterEach(() => {
  f.plugin.deactivate?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("public motor process", () => {
  // Evaluate the shipped resource against data accepted by actual ui.patch validation.
  const enabled = (nodeId: string, b = binding) => {
    const node = panelResource.nodes.find((node) => node.id === nodeId)!;
    return !node.enabledWhen || evaluateCondition(node.enabledWhen, f.data(b), initialForm());
  };
  const holdIds = panelResource.nodes
    .filter((node) => node.type === "holdAction")
    .map((node) => node.id);
  const startIds = panelResource.nodes
    .filter((node) => node.id.endsWith("-start"))
    .map((node) => node.id);

  it.each(PORTS.flatMap((port) => ([1, -1] as const).map((direction) => ({ port, direction }))))(
    "$port direction $direction keeps only the original bound hold enabled through prepare, start and running",
    async ({ port, direction }) => {
      const other = uiBindingSchema.parse({ ...binding, panelInstance: id(40) });
      f.instances = [binding, other, status];
      f.sources = {
        ...f.sources,
        actuators: PORTS.map((port, i) => ({
          actuatorId: id(4 + i),
          portId: port,
          name: "Motor",
          typeId: "large",
          state: "ready",
        })),
      };
      await f.boot();
      await f.select();
      const prepare = barrier<DeviceResult<"devices/motion/prepare">>();
      const start = barrier<DeviceResult<"devices/motion/start">>();
      const stop = barrier<DeviceResult<"devices/motion/stop">>();
      f.overrides.set("devices/motion/prepare", () => prepare.promise);
      f.overrides.set("devices/motion/start", () => start.promise);
      f.overrides.set("devices/motion/stop", () => stop.promise);
      const trigger = { kind: "hold", phase: "begin", gestureRef: id(20) } as const;
      const form = {
        revision: 1,
        values: { ...initialForm(), port, [`${port.toLowerCase()}-mode`]: "jog" },
      };
      const nodeId = `${port.toLowerCase()}-${direction === 1 ? "forward" : "reverse"}`;
      const checkBusy = async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect(f.data(binding)["can-start"]).toBe(false);
        expect(holdIds.filter((id) => enabled(id))).toEqual([nodeId]);
        expect(holdIds.filter((id) => enabled(id, other))).toEqual([]);
        expect(startIds.filter((id) => enabled(id))).toEqual([]);
      };
      await f.invoke(f.invocation("jog", { trigger, form }, { direction: String(direction) }));
      await drain();
      await checkBusy();
      // Even direct invocations of the still-enabled node cannot bypass the synchronous lock.
      await f.invoke(f.invocation("jog", { trigger, form }, { direction: String(direction) }));
      await f.invoke(
        f.invocation(
          "jog",
          { trigger: { ...trigger, gestureRef: id(21) }, form },
          { direction: String(-direction) },
        ),
      );
      await f.invoke(
        f.invocation(
          "jog",
          {
            trigger,
            form: { revision: 2, values: { ...initialForm(), port: port === "A" ? "B" : "A" } },
          },
          { direction: "1" },
        ),
      );
      await f.invoke();
      expect(f.calls("devices/motion/prepare")).toHaveLength(1);
      prepare.resolve({ ok: true, value: { operation: snap() } });
      await drain();
      expect(f.calls("devices/motion/start")).toHaveLength(1);
      await checkBusy();
      f.operation = snap({
        revision: 2,
        phase: "running",
        stage: "moving",
        startAccepted: true,
        dispatch: "sent",
        stopConfirmation: "pending",
      });
      start.resolve({ ok: true, value: { operation: f.operation } });
      await drain();
      await checkBusy();
      // A foreign binding or gesture cannot release the original operation.
      await f.invoke(
        f.invocation(
          "jog",
          { binding: other, trigger: { ...trigger, phase: "end" } },
          { direction: String(direction) },
        ),
      );
      await f.invoke(
        f.invocation(
          "jog",
          { trigger: { ...trigger, phase: "end", gestureRef: id(22) } },
          { direction: String(direction) },
        ),
      );
      expect(f.calls("devices/motion/stop")).toHaveLength(0);
      const phase = direction === 1 ? "end" : "cancel";
      await f.invoke(
        f.invocation(
          "jog",
          { trigger: { ...trigger, phase }, form: { revision: 3, values: {} } },
          { direction: String(direction) },
        ),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(f.calls("devices/motion/stop").map((call) => call.params)).toEqual([
        { operationId: id(10), stopMode: phase === "end" ? "configured" : "brake" },
      ]);
      expect(holdIds.filter((id) => enabled(id))).toEqual([]);
      expect(startIds.filter((id) => enabled(id))).toEqual([]);
      const terminal = snap({
        revision: 3,
        phase: "stopped",
        stage: "terminal",
        stopRequested: true,
        dispatch: "sent",
        stopConfirmation: "confirmed",
      });
      stop.resolve({ ok: true, value: { operation: terminal } });
      await drain();
      await vi.advanceTimersByTimeAsync(100);
      expect(f.data(binding)["active-hold"]).toBeNull();
      expect(f.data(binding)["can-start"]).toBe(true);
    },
  );

  it.each(["connection", "source", "authority", "hidden", "replacement", "unconfirmed"] as const)(
    "%s loss removes active hold eligibility while unresolved work stays locked",
    async (loss) => {
      await f.boot();
      await f.select();
      f.overrides.set("devices/motion/stop", () => barrier<unknown>().promise);
      await f.invoke(
        f.invocation(
          "jog",
          { trigger: { kind: "hold", phase: "begin", gestureRef: id(20) } },
          { direction: "1" },
        ),
      );
      await drain();
      await vi.advanceTimersByTimeAsync(100);
      expect(enabled("a-forward")).toBe(true);
      if (loss === "connection") {
        f.session = { ...f.session, state: "disconnected" };
        f.deviceEvent("catalog", "devices.catalog", f.list());
      } else if (loss === "source") {
        f.sources = { ...f.sources, sourceRevision: 2, actuators: [] };
        f.session = { ...f.session, sourceRevision: 2 };
        f.deviceEvent("session", "devices.session", { session: f.session, sourcesChanged: true });
      } else if (loss === "authority") {
        f.deviceEvent("authority", "devices.authority", {
          contextRef: id(5),
          revision: 2,
          state: "restricted",
          reason: "viewer",
        });
      } else if (loss === "hidden") {
        f.visible = false;
        f.uiEvent("ui.visibility", { binding, visible: false });
      } else if (loss === "replacement") {
        const replacement = uiBindingSchema.parse({ ...binding, uiResourceGeneration: 2 });
        f.instances = [replacement, status];
        f.uiEvent("ui.instances", { instances: [replacement, status] });
        await drain();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.data(replacement)["active-hold"]).toBeNull();
        expect(holdIds.filter((id) => enabled(id, replacement))).toEqual([]);
        expect(f.calls("devices/motion/stop")[0]?.params).toEqual({
          operationId: id(10),
          stopMode: "brake",
        });
        return;
      } else {
        f.deviceEvent(
          "motion",
          "devices.motion",
          snap({
            revision: 3,
            phase: "unconfirmed",
            stage: "terminal",
            dispatch: "sent",
            stopConfirmation: "unconfirmed",
          }),
        );
      }
      await drain();
      await vi.advanceTimersByTimeAsync(100);
      expect(f.data(binding)["active-hold"]).toBeNull();
      expect(holdIds.filter((id) => enabled(id))).toEqual([]);
      expect(startIds.filter((id) => enabled(id))).toEqual([]);
      await f.invoke();
      expect(f.calls("devices/motion/prepare")).toHaveLength(1);
      if (loss !== "unconfirmed")
        expect(f.calls("devices/motion/stop")[0]?.params).toEqual({
          operationId: id(10),
          stopMode: "brake",
        });
    },
  );
  it.each(["devices/list", "devices/context"] as const)(
    "hidden cancellation drains patches while %s is held and after settling before prepare",
    async (method) => {
      await f.boot();
      await f.select();
      const held = barrier<unknown>();
      f.overrides.set(method, () => held.promise);
      await f.invoke();
      await drain();
      // Discover hidden state through ui.state, without a visibility event.
      f.visible = false;
      const before = f.patches.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.patches.length - before).toBeLessThanOrEqual(4);
      expect(vi.getTimerCount()).toBe(0);
      f.overrides.delete(method);
      held.resolve({
        ok: true,
        value:
          method === "devices/list"
            ? f.list()
            : {
                contextRef: id(5),
                revision: 1,
                state: "local",
                reason: "local",
              },
      });
      await drain();
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.getTimerCount()).toBe(0);
      const settled = f.patches.length;
      f.uiEvent("ui.environment", { locale: "en", theme: "dark" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.patches.length - settled).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.calls("devices/motion/prepare")).toHaveLength(0);
      expect(f.calls("devices/motion/start")).toHaveLength(0);
      expect(f.calls("devices/motion/stop")).toHaveLength(0);
    },
  );
  it("hidden lost prepare drains presentation timers while retaining uncertainty and the admission lock", async () => {
    await f.boot();
    await f.select();
    f.overrides.set("devices/motion/prepare", async () => {
      throw new Error("lost");
    });
    await f.invoke();
    await drain();
    f.visible = false;
    f.uiEvent("ui.visibility", { binding, visible: false });
    const before = f.patches.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.patches.length - before).toBeLessThanOrEqual(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.data(binding)).toMatchObject({
      operation: null,
      confirmation: "Unknown",
      "can-start": false,
      "has-error": true,
      phase: "Stopping",
      "stop-requested": "Yes",
    });
    f.visible = true;
    f.uiEvent("ui.visibility", { binding, visible: true });
    await f.invoke();
    await drain();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
    for (const method of ["start", "query", "stop"])
      expect(f.calls(`devices/motion/${method}`)).toHaveLength(0);
  });
  it("does not cancel a confirmed settled operation on hide or hidden state reads", async () => {
    await f.boot();
    await f.select();
    await f.invoke();
    await drain();
    f.deviceEvent(
      "motion",
      "devices.motion",
      snap({
        revision: 5,
        phase: "completed",
        stage: "terminal",
        movement: "completed",
        dispatch: "sent",
        stopConfirmation: "confirmed",
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    f.visible = false;
    f.uiEvent("ui.visibility", { binding, visible: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls("devices/motion/stop")).toHaveLength(0);
    expect(f.data(binding)).toMatchObject({ phase: "Completed", confirmation: "Confirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["en", "zh-TW"] as const)(
    "resets merged operation presentation in %s for a delayed then lost second prepare",
    async (locale) => {
      await f.boot();
      f.uiEvent("ui.environment", { locale, theme: "light" });
      await f.select();
      await f.invoke();
      await drain();
      f.deviceEvent(
        "motion",
        "devices.motion",
        snap({
          revision: 5,
          phase: "completed",
          stage: "terminal",
          movement: "completed",
          dispatch: "sent",
          stopConfirmation: "confirmed",
          elapsedMs: 1000,
          angle: 360,
          displacement: 90,
        }),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(f.data(binding)).toMatchObject({
        operation: id(10),
        progress: 1,
        confirmation: locale === "en" ? "Confirmed" : "已確認",
      });
      const prepare = barrier<unknown>();
      f.overrides.set("devices/motion/prepare", () => prepare.promise);
      await f.invoke();
      await drain();
      await vi.advanceTimersByTimeAsync(100);
      const pending = {
        operation: null,
        phase: locale === "en" ? "Preparing" : "準備中",
        stage: "—",
        movement: locale === "en" ? "Unknown" : "未知",
        dispatch: locale === "en" ? "Unknown" : "未知",
        confirmation: locale === "en" ? "Unknown" : "未知",
        "stop-requested": locale === "en" ? "No" : "否",
        angle: locale === "en" ? "No reading" : "無讀值",
        displacement: locale === "en" ? "No reading" : "無讀值",
        elapsed: "—",
        progress: null,
        "can-start": false,
      };
      expect(f.data(binding)).toMatchObject({ ...pending, error: "", "has-error": false });
      expect(f.data(status).summary).toBe(pending.phase);
      prepare.reject(new Error("lost prepare reply"));
      await drain();
      await vi.advanceTimersByTimeAsync(100);
      expect(f.data(binding)).toMatchObject({ ...pending, "has-error": true });
      expect(f.data(binding).error).not.toBe("");
      await f.invoke();
      await drain();
      expect(f.calls("devices/motion/prepare")).toHaveLength(2);
      expect(f.calls("devices/motion/start")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["selection", "new attempt"])(
    "clears merged transport error flags after successful explicit %s",
    async (recovery) => {
      await f.boot();
      await f.select();
      const held = barrier<unknown>();
      f.overrides.set("devices/context", () => held.promise);
      await f.invoke();
      await drain();
      held.reject(new Error("context read failed"));
      await drain();
      await vi.advanceTimersByTimeAsync(100);
      expect(f.data(binding)["has-error"]).toBe(true);
      expect(f.data(binding).error).not.toBe("");
      f.overrides.delete("devices/context");
      if (recovery === "selection") await f.select();
      else {
        f.overrides.set("devices/context", () => barrier<unknown>().promise);
        await f.invoke();
        await drain();
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(f.data(binding)).toMatchObject({ error: "", "has-error": false });
    },
  );
  it("initializes without connect/motion, registers once, and presents truthful availability in both locales", async () => {
    await f.boot();
    await f.plugin.activate(f.context);
    expect(
      f.requests.filter(
        (r) => r.method.startsWith("devices/motion") || r.method === "devices/connect",
      ),
    ).toEqual([]);
    expect(f.patches.find((p) => p.binding.kind === "status")?.set.summary).toBe("Available");
    f.uiEvent("ui.environment", { locale: "zh-TW", theme: "dark" });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.at(-1)?.set.summary).toBe("可使用");
  });
  it("requires explicit selection, a live context, and rejects null active fields while ignoring masked fields", async () => {
    await f.boot();
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    await f.select();
    const invalid = f.invocation("start", {
      form: { revision: 1, values: { ...initialForm(), "a-mode": "timed", "a-power": null } },
    });
    expect((await f.invoke(invalid)).fieldErrors[0]?.field).toBe("a-power");
    const c = f.invocation();
    delete c.context.motionScopeRef;
    await f.invoke(c);
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    await f.invoke(
      f.invocation("start", {
        form: {
          revision: 1,
          values: { ...initialForm(), "a-mode": "timed", "a-degrees": null, "b-power": null },
        },
      }),
    );
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
    expect(f.calls("devices/motion/prepare")[0]?.params).toMatchObject({
      motion: { mode: "timed", durationMs: 1000, actuatorId: id(4) },
    });
  });
  it("locks duplicate activate/begin, uses the invocation gesture, and cancels a held prepare before its ID arrives", async () => {
    await f.boot();
    await f.select();
    const held = barrier<DeviceResult<"devices/motion/prepare">>();
    f.overrides.set("devices/motion/prepare", () => held.promise);
    const trigger = { kind: "hold", phase: "begin", gestureRef: id(20) } as const;
    await f.invoke(f.invocation("jog", { trigger }, { direction: "-1" }));
    await drain();
    await f.invoke(f.invocation("jog", { trigger }, { direction: "-1" }));
    await f.invoke();
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
    expect(f.calls("devices/motion/prepare")[0]?.params).toMatchObject({
      gestureRef: id(20),
      motion: { mode: "jog", direction: -1 },
    });
    await f.invoke(
      f.invocation(
        "jog",
        { trigger: { ...trigger, phase: "cancel" }, form: { revision: 2, values: {} } },
        { direction: "-1" },
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(f.data(binding)["active-hold"]).toBeNull();
    expect(holdIds.filter((id) => enabled(id))).toEqual([]);
    expect(f.data(binding)["can-start"]).toBe(false);
    held.resolve({ ok: true, value: { operation: snap() } });
    await drain();
    expect(f.calls("devices/motion/start")).toHaveLength(0);
    expect(f.calls("devices/motion/stop")[0]?.params).toEqual({
      operationId: id(10),
      stopMode: "brake",
    });
  });
  it("queries the original ID after a lost start reply, never resubmits, and retains uncertainty on lost query/stop", async () => {
    await f.boot();
    await f.select();
    const start = barrier<unknown>();
    f.overrides.set("devices/motion/start", () => start.promise);
    f.overrides.set("devices/motion/query", async () => {
      throw new Error("lost query");
    });
    f.overrides.set("devices/motion/stop", async () => {
      throw new Error("lost stop");
    });
    await f.invoke();
    await drain();
    start.reject(new Error("lost start"));
    await drain();
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/start")).toHaveLength(1);
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
    expect(
      f
        .calls("devices/motion/query")
        .every((r) => JSON.stringify(r.params) === JSON.stringify({ operationId: id(10) })),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set).toMatchObject({
      "can-start": false,
      "has-error": true,
    });
  });
  it("release uses configured stop and cancel escalates to brake independently of pending start/stop", async () => {
    await f.boot();
    await f.select();
    const start = barrier<unknown>();
    const coast = barrier<unknown>();
    f.overrides.set("devices/motion/start", () => start.promise);
    f.overrides.set("devices/motion/stop", async (params) =>
      (params as { stopMode: string }).stopMode === "configured"
        ? coast.promise
        : {
            ok: true,
            value: {
              operation: snap({
                revision: 4,
                phase: "stopped",
                stage: "terminal",
                stopRequested: true,
                stopConfirmation: "confirmed",
              }),
            },
          },
    );
    const trigger = { kind: "hold", phase: "begin", gestureRef: id(20) } as const;
    await f.invoke(f.invocation("jog", { trigger }, { direction: "1" }));
    await drain();
    await f.invoke(
      f.invocation(
        "jog",
        { trigger: { ...trigger, phase: "end" }, form: { revision: 2, values: {} } },
        { direction: "1" },
      ),
    );
    await drain();
    f.uiEvent("ui.revoked", { binding, reason: "hidden" });
    await drain();
    expect(f.calls("devices/motion/stop").map((r) => r.params)).toEqual([
      { operationId: id(10), stopMode: "configured" },
      { operationId: id(10), stopMode: "brake" },
    ]);
    start.resolve({ ok: true, value: { operation: snap({ revision: 2, phase: "running" }) } });
    coast.resolve({ ok: true, value: { operation: snap({ revision: 3, phase: "stopping" }) } });
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set.phase).toBe("Stopped");
  });
  it.each(["session", "actuator"])(
    "stops and invalidates selection on %s replacement, with no automatic resume",
    async (kind) => {
      await f.boot();
      await f.select();
      await f.invoke();
      await drain();
      if (kind === "session") {
        f.session = { ...f.session, sessionId: id(30) };
        f.sources = { ...f.sources, sessionId: id(30) };
        f.deviceEvent("catalog", "devices.catalog", f.list());
      } else {
        f.sources = {
          ...f.sources,
          sourceRevision: 2,
          actuators: f.sources.actuators.map((a) => ({ ...a, actuatorId: id(31) })),
        };
        f.session = { ...f.session, sourceRevision: 2 };
        f.deviceEvent("session", "devices.session", { session: f.session, sourcesChanged: true });
      }
      await drain();
      await f.invoke();
      await drain();
      expect(f.calls("devices/motion/stop").length).toBeGreaterThan(0);
      expect(f.calls("devices/motion/start")).toHaveLength(1);
      await f.select();
      await f.invoke();
      await drain();
      expect(f.calls("devices/motion/start")).toHaveLength(2);
    },
  );
  it("resyncs motion gaps with query, ignores stale snapshots and preserves the original operation", async () => {
    await f.boot();
    await f.select();
    await f.invoke();
    await drain();
    f.operation = snap({
      revision: 5,
      phase: "running",
      stage: "moving",
      dispatch: "sent",
      stopConfirmation: "pending",
      elapsedMs: 500,
    });
    f.deviceEvent("motion", "devices.motion", snap({ revision: 3, elapsedMs: 100 }), true);
    await drain();
    f.deviceEvent("motion", "devices.motion", snap({ revision: 4, elapsedMs: 1 }));
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls("devices/motion/query").length).toBeGreaterThan(1);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set.elapsed).toBe("500 ms");
    expect(f.calls("devices/motion/start")).toHaveLength(1);
  });
  it("bounds/coalesces presentation at ten patches/sec/instance without an idle polling loop", async () => {
    await f.boot();
    await f.select();
    await f.invoke();
    await drain();
    for (let i = 3; i < 103; i++)
      f.deviceEvent(
        "motion",
        "devices.motion",
        snap({ revision: i, phase: "running", elapsedMs: i }),
      );
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    for (const b of [binding, status]) {
      const times = f.patches
        .filter((p) => p.binding.panelInstance === b.panelInstance)
        .map((p) => p.time);
      expect(times.length).toBeLessThanOrEqual(2);
      expect(times.every((t, i) => i === 0 || t - times[i - 1]! >= 100)).toBe(true);
    }
    const count = f.patches.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.patches).toHaveLength(count);
  });
  it("retries a revision conflict only as presentation and does not replay motion", async () => {
    await f.boot();
    await f.select();
    await f.invoke();
    await drain();
    const patch = vi.mocked(f.context.ui.patch);
    const original = patch.getMockImplementation()!;
    let conflict = true;
    patch.mockImplementation(async (...args) => {
      if (conflict) {
        conflict = false;
        await original(...args);
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_STALE_RESOURCE",
            message: "stale revision",
            detail: { kind: "resource", reason: "stale", resource: "ui-binding" },
          },
        };
      }
      return original(...args);
    });
    f.uiEvent("ui.environment", { locale: "zh-TW", theme: "dark" });
    await vi.advanceTimersByTimeAsync(300);
    expect(patch.mock.calls.length).toBeGreaterThan(2);
    expect(f.calls("devices/motion/start")).toHaveLength(1);
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
  });
  it("retires bindings during late state/patch replies, cancels held work, and unsubscribes on deactivate", async () => {
    await f.boot();
    await f.select();
    const heldState = barrier<UiRequestMap["ui/state"]["result"]>();
    vi.mocked(f.context.ui.state).mockImplementation(() => heldState.promise);
    const prepared = barrier<DeviceResult<"devices/motion/prepare">>();
    f.overrides.set("devices/motion/prepare", () => prepared.promise);
    await f.invoke();
    await drain();
    f.uiEvent("ui.environment", { locale: "en", theme: "dark" });
    await vi.advanceTimersByTimeAsync(100);
    f.instances = [status];
    f.uiEvent("ui.instances", { instances: [status] });
    const before = f.patches.length;
    heldState.resolve({
      ok: true,
      value: {
        binding,
        revision: 0,
        data: {},
        formRevision: 0,
        form: {},
        valid: true,
        visible: true,
        locale: "en",
      },
    });
    prepared.resolve({ ok: true, value: { operation: snap() } });
    await drain();
    expect(f.calls("devices/motion/start")).toHaveLength(0);
    expect(f.patches.slice(before).some((p) => p.binding.kind === "panel")).toBe(false);
    await f.plugin.deactivate?.();
    await drain();
    expect(f.deviceListeners.size).toBe(0);
    expect(f.uiListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("authors relative-angle with no duration, rejects a start in jog mode and a jog in timed mode", async () => {
    await f.boot();
    await f.select();
    await f.invoke(f.invocation("start", { form: { revision: 1, values: initialForm() } }));
    await f.invoke(f.invocation("jog", { trigger: { kind: "activate" } }, { direction: "1" }));
    await f.invoke(
      f.invocation(
        "jog",
        {
          trigger: { kind: "hold", phase: "begin", gestureRef: id(20) },
          form: { revision: 1, values: { ...initialForm(), "a-mode": "timed" } },
        },
        { direction: "1" },
      ),
    );
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    await f.invoke(
      f.invocation("start", {
        form: {
          revision: 1,
          values: {
            ...initialForm(),
            "a-mode": "relative-angle",
            "a-seconds": null,
            "a-direction": "-1",
            "a-degrees": 360,
          },
        },
      }),
    );
    await drain();
    expect(f.calls("devices/motion/prepare")[0]?.params).toEqual({
      sessionId: id(3),
      contextRef: id(5),
      motionScopeRef: id(6),
      motion: {
        mode: "relative-angle",
        actuatorId: id(4),
        power: 20,
        direction: -1,
        brake: true,
        degrees: 360,
      },
    });
  });
  it("lost prepare keeps uncertainty and refuses another prepare without inventing an ID", async () => {
    await f.boot();
    await f.select();
    f.overrides.set("devices/motion/prepare", async () => {
      throw new Error("reply lost");
    });
    await f.invoke();
    await drain();
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
    expect(f.calls("devices/motion/start")).toHaveLength(0);
    expect(f.calls("devices/motion/query")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set).toMatchObject({
      "can-start": false,
      "has-error": true,
    });
  });
  it("a current-source read held across replacement cannot prepare stale actuator IDs", async () => {
    await f.boot();
    await f.select();
    const held = barrier<DeviceResult<"devices/session">>();
    const old = { session: f.session, sources: f.sources };
    f.overrides.set("devices/session", () => held.promise);
    await f.invoke();
    await drain();
    f.session = { ...f.session, sourceRevision: 2 };
    f.sources = { ...f.sources, sourceRevision: 2, actuators: [] };
    f.deviceEvent("session", "devices.session", { session: f.session, sourcesChanged: true });
    held.resolve({ ok: true, value: old });
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    expect(f.calls("devices/motion/start")).toHaveLength(0);
  });
  it("authority loss stops without waiting for a held start and terminal cleanup removes observation timers", async () => {
    await f.boot();
    await f.select();
    const held = barrier<DeviceResult<"devices/motion/start">>();
    f.overrides.set("devices/motion/start", () => held.promise);
    await f.invoke();
    await drain();
    f.deviceEvent("authority", "devices.authority", {
      contextRef: id(5),
      revision: 2,
      state: "restricted",
      reason: "viewer",
    });
    await drain();
    expect(f.calls("devices/motion/stop")[0]?.params).toEqual({
      operationId: id(10),
      stopMode: "brake",
    });
    held.resolve({ ok: true, value: { operation: snap({ revision: 1, phase: "running" }) } });
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(
      [...f.deviceListeners.values()].some(
        (s) => s.params.topic === "motion" || s.params.topic === "authority",
      ),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a newer motion event wins over a late query reply and a query failure keeps the snapshot uncertain", async () => {
    await f.boot();
    await f.select();
    const query = barrier<DeviceResult<"devices/motion/query">>();
    f.overrides.set("devices/motion/query", () => query.promise);
    await f.invoke();
    await drain();
    f.deviceEvent(
      "motion",
      "devices.motion",
      snap({
        revision: 9,
        phase: "running",
        dispatch: "sent",
        stopConfirmation: "pending",
        elapsedMs: 900,
      }),
    );
    query.resolve({ ok: true, value: { operation: snap({ revision: 3, elapsedMs: 5 }) } });
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set.elapsed).toBe("900 ms");
    f.overrides.set("devices/motion/query", async () => {
      throw new Error("lost");
    });
    await f.invoke(f.invocation("refresh"));
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set).toMatchObject({
      confirmation: "Pending",
      "can-start": false,
      "has-error": true,
    });
  });
  it("UI gaps resync instances and resource replacement stops the old binding with no resume", async () => {
    await f.boot();
    await f.select();
    await f.invoke();
    await drain();
    const replacement = {
      ...binding,
      generation: 2,
      uiResourceGeneration: 2,
      panelInstance: id(41),
    };
    f.instances = [replacement, status];
    f.uiEvent("ui.instances", { instances: [replacement, status] }, true);
    await drain();
    await f.invoke();
    await drain();
    expect(f.calls("ui/instances").length).toBeGreaterThan(1);
    expect(f.calls("devices/motion/stop").length).toBeGreaterThan(0);
    expect(f.calls("devices/motion/start")).toHaveLength(1);
    const before = f.patches.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(
      f.patches.slice(before).some((p) => p.binding.panelInstance === binding.panelInstance),
    ).toBe(false);
  });
  it("a late UI state cannot restore visibility after hide", async () => {
    await f.boot();
    await f.select();
    const original = vi.mocked(f.context.ui.state).getMockImplementation()!;
    const held = barrier<UiRequestMap["ui/state"]["result"]>();
    const old = await original(binding);
    vi.mocked(f.context.ui.state).mockImplementation((b) =>
      b.kind === "panel" ? held.promise : original(b),
    );
    f.uiEvent("ui.environment", { locale: "en", theme: "dark" });
    await vi.advanceTimersByTimeAsync(100);
    f.visible = false;
    f.uiEvent("ui.visibility", { binding, visible: false });
    held.resolve(old);
    await drain();
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
  });
  it("late prepare after deactivate can only stop the original ID, and late patch replies schedule no work", async () => {
    await f.boot();
    await f.select();
    const prepare = barrier<DeviceResult<"devices/motion/prepare">>();
    const patch = barrier<UiRequestMap["ui/patch"]["result"]>();
    f.overrides.set("devices/motion/prepare", () => prepare.promise);
    vi.mocked(f.context.ui.patch).mockImplementation(() => patch.promise);
    await f.invoke();
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    await f.plugin.deactivate?.();
    await drain();
    const before = f.calls("ui/state").length;
    prepare.resolve({ ok: true, value: { operation: snap() } });
    patch.resolve({ ok: true, value: { revision: 5 } });
    await drain();
    expect(f.calls("devices/motion/start")).toHaveLength(0);
    expect(f.calls("devices/motion/stop")[0]?.params).toEqual({
      operationId: id(10),
      stopMode: "brake",
    });
    expect(f.calls("ui/state")).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.deviceListeners.size + f.uiListeners.size).toBe(0);
  });
  it("observation has one finite deadline, coalesces held queries, and leaves core uncertainty intact", async () => {
    await f.boot();
    await f.select();
    const query = barrier<DeviceResult<"devices/motion/query">>();
    f.overrides.set("devices/motion/query", () => query.promise);
    f.overrides.set("devices/motion/stop", async () => {
      throw new Error("unconfirmed");
    });
    await f.invoke();
    await drain();
    for (let i = 0; i < 50; i++)
      f.deviceEvent("motion", "events.resyncRequired", { reason: "overflow", affected: [id(10)] });
    await drain();
    expect(f.calls("devices/motion/query")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(16000);
    expect(f.calls("devices/motion/stop")).toHaveLength(1);
    expect([...f.deviceListeners.values()].some((s) => s.params.topic === "motion")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    query.reject(new Error("lost query"));
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
  });
  it("ready returns while a snapshot is held; provider recovery follows current catalog without auto-resume", async () => {
    const held = barrier<DeviceResult<"devices/list">>();
    f.overrides.set("devices/list", () => held.promise);
    f.overrides.set("devices/negotiate", async () => ({
      ok: true,
      value: {
        devicesContractVersion: 1,
        eventVersion: 1,
        capabilities: [
          {
            capability: "finiteMotion.v1",
            state: "provider-unavailable",
            providerId: "kobrixa.ev3",
          },
        ],
        requirementsSatisfied: false,
      },
    }));
    await f.boot(); // Must settle without resolving the list barrier.
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    held.resolve({
      ok: true,
      value: {
        ...f.list(),
        providers: f.list().providers.map((p) => ({ ...p, state: "disabled" })),
        sessions: [],
      },
    });
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set).toMatchObject({
      available: false,
      "can-start": false,
    });
    await f.select();
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    f.overrides.delete("devices/list");
    await f.invoke(f.invocation("refresh"));
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(0);
    await f.select();
    await f.invoke();
    await drain();
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
  });
  it("preserves uncertain prepare Result details and does not interpret a business failure as confirmed stop", async () => {
    await f.boot();
    await f.select();
    f.overrides.set("devices/motion/prepare", async () => ({
      ok: false,
      error: {
        code: "PLUGIN_E_DEVICE_OPERATION",
        message: "Unknown dispatch",
        detail: {
          kind: "device",
          reason: "deadline",
          dispatch: "unknown",
          stopConfirmation: "unconfirmed",
        },
      },
    }));
    await f.invoke();
    await drain();
    await f.invoke();
    await drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls("devices/motion/prepare")).toHaveLength(1);
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set.error).toContain(
      "PLUGIN_E_DEVICE_OPERATION",
    );
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set.error).toContain(
      "unconfirmed",
    );
    expect(f.patches.filter((p) => p.binding.kind === "panel").at(-1)?.set["can-start"]).toBe(
      false,
    );
  });
});
