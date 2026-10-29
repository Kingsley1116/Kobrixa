import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginContext, ContextCommandContext } from "@kobrixa/plugin-sdk";
import {
  contextCommandDeclarationSchema,
  panelResourceV2Schema,
  statusResourceV2Schema,
  validateUiData,
  type CommandValue,
  type UiBinding,
  type UiStateSnapshot,
  type UiScalar,
  type UiEventEnvelopeV2,
  type ReadSnapshot,
  type RecordMeta,
  type DeviceEvent,
} from "@kobrixa/plugin-protocol";
import { UiInteractions } from "../../../../../packages/plugin-runtime/src/ui-interactions.js";
import {
  UiDataStore,
  type UiDataAuthority,
} from "../../../../../packages/plugin-runtime/src/ui-data.js";
import { UiDataClient } from "../../../../../packages/plugin-sdk-js/src/ui-data.js";
import {
  LabController,
  createLabPlugin,
} from "../../../../../plugins/sensor-lab/src/controller.js";
import { LabExport } from "../../../../../plugins/sensor-lab/src/export-actions.js";
import { LabLibrary } from "../../../../../plugins/sensor-lab/src/library.js";
import panelJson from "../../../../../plugins/sensor-lab/ui/panel.json" with { type: "json" };
import statusJson from "../../../../../plugins/sensor-lab/ui/status.json" with { type: "json" };
import manifest from "../../../../../plugins/sensor-lab/kobrixa-plugin.json" with { type: "json" };
import { setup, id, ok, deferred } from "./recorder-fixture.js";

const resources = {
  panel: panelResourceV2Schema.parse(panelJson),
  status: statusResourceV2Schema.parse(statusJson),
};
const cleanup: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function settle() {
  for (let i = 0; i < 160; i++) await Promise.resolve();
}
async function fixture(configure?: (context: PluginContext) => void) {
  const recorder = setup();
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: manifest.id,
    generation: 1,
    hostEpoch: id(10),
    processEpoch: id(11),
  };
  const binding: UiBinding & { kind: "panel" } = {
    kind: "panel",
    contributionId: "kobrixa.sensor-lab.panel",
    panelInstance: id(12),
    generation: 1,
    uiResourceGeneration: 1,
    hostEpoch: owner.hostEpoch,
    processEpoch: owner.processEpoch,
  };
  const statusBinding: UiBinding = {
    ...binding,
    kind: "status",
    contributionId: "kobrixa.sensor-lab.status",
    panelInstance: id(13),
  };
  const state: UiStateSnapshot = {
    binding,
    revision: 0,
    data: Object.fromEntries(Object.entries(resources.panel.data).map(([k, v]) => [k, v.initial])),
    formRevision: 0,
    form: Object.fromEntries(
      Object.entries(resources.panel.fields).map(([k, v]) => [k, v.initial]),
    ),
    valid: true,
    visible: true,
    locale: "en",
  };
  const status: UiStateSnapshot = {
    ...state,
    binding: statusBinding,
    form: {},
    data: Object.fromEntries(Object.entries(resources.status.data).map(([k, v]) => [k, v.initial])),
  };
  let bindings = [binding, statusBinding],
    subscription = 1000;
  const callbacks = new Map<
    string,
    { b?: UiBinding; listener: (e: UiEventEnvelopeV2) => unknown }
  >();
  let resync!: Parameters<PluginContext["ui"]["onResyncRequired"]>[0];
  const event = (event: UiEventEnvelopeV2) => {
    for (const { b, listener } of callbacks.values())
      if (!("binding" in event.data) ? !b : b?.panelInstance === event.data.binding.panelInstance)
        listener(event);
  };
  const emit = (kind: "form" | "visibility") =>
    event(
      kind === "form"
        ? {
            kind: "ui.form",
            data: { binding, revision: state.formRevision, values: structuredClone(state.form) },
            version: 1,
            delivery: "control",
            subscriptionId: id(1000),
            sequence: state.formRevision,
            owner,
          }
        : {
            kind: "ui.visibility",
            data: { binding, visible: state.visible },
            version: 1,
            delivery: "control",
            subscriptionId: id(1000),
            sequence: 1,
            owner,
          },
    );
  const authority: UiDataAuthority = {
    owner,
    binding: { ...binding, kind: "panel" },
    registration: {},
    version: 2,
    ready: true,
    panelsPermission: true,
    visible: true,
    presentation: 0,
    resource: resources.panel,
  };
  const store = new UiDataStore({
    now: () => performance.now(),
    resolve: () => ({
      ...authority,
      visible: state.visible,
      presentation: Number(state.data.presentation),
    }),
    admitCommit: () => "admitted",
    publish: () => {},
  });
  let request = 0;
  const data = new UiDataClient(
    async (method, params) =>
      JSON.parse(
        store.requestFrame(
          owner,
          JSON.stringify({ jsonrpc: "2.0", id: ++request, method, params }),
        ),
      ).result,
  );
  data.markReady();
  const stateOf = (b: UiBinding) => (b.kind === "panel" ? state : status);
  const ui = {
    data,
    instances: vi.fn(async () => ok({ instances: structuredClone(bindings) })),
    state: vi.fn(async (b: UiBinding) => ok(structuredClone(stateOf(b)))),
    patch: vi.fn(async (b: UiBinding, revision: number, set: Record<string, UiScalar>) => {
      const s = stateOf(b),
        resource = resources[b.kind];
      if (s.revision !== revision) throw new Error("CAS");
      const valid = validateUiData(
        resource.kind === "panel" ? { kind: "panel", data: resource.data, nodes: [] } : resource,
        { ...s.data, ...set },
      );
      if (!valid.ok) throw new Error(JSON.stringify(valid.error));
      s.data = valid.value;
      s.revision++;
      return ok({ revision: s.revision });
    }),
    formPatch: vi.fn(async (b: UiBinding, revision: number, set: Record<string, UiScalar>) => {
      if (
        b.panelInstance !== binding.panelInstance ||
        !state.visible ||
        revision !== state.formRevision
      )
        throw new Error("form CAS");
      Object.assign(state.form, set);
      state.formRevision++;
      emit("form");
      return ok({ formRevision: state.formRevision, form: structuredClone(state.form) });
    }),
    subscribe: vi.fn(
      async (q: { binding?: UiBinding }, listener: (e: UiEventEnvelopeV2) => unknown) => {
        const subscriptionId = id(++subscription);
        callbacks.set(subscriptionId, { ...(q.binding ? { b: q.binding } : {}), listener });
        return ok({
          subscriptionId,
          sequence: 0,
          snapshot: {
            instances: bindings,
            states: q.binding ? [structuredClone(stateOf(q.binding))] : [],
            locale: "en",
            theme: "light",
          },
        });
      },
    ),
    unsubscribe: vi.fn(async (subscriptionId: string) => {
      callbacks.delete(subscriptionId);
      return ok({ removed: true });
    }),
    onResyncRequired: vi.fn((callback: typeof resync) => {
      resync = callback;
      return () => {};
    }),
  };
  const handlers = new Map<
    string,
    (c: ContextCommandContext) => CommandValue | Promise<CommandValue>
  >();
  const registerContext = vi.fn<PluginContext["commands"]["registerContext"]>(
    (name, _args, handler) => {
      handlers.set(name, handler);
    },
  );
  const source = recorder.options.channels[0]!.source;
  if (source.origin !== "public") throw new Error("fixture");
  const session = {
    sessionId: source.provenance.sessionId,
    providerId: source.provenance.providerId,
    providerGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    name: "EV3",
    transport: "mock" as const,
    capabilities: ["telemetry.v1" as const],
    state: "connected" as const,
    foreground: "none" as const,
    recording: false,
  };
  const catalog = {
    sessionId: session.sessionId,
    sourceRevision: 1,
    channels: [structuredClone(source.channel)],
    actuators: [],
  };
  const deviceCallbacks: ((event: DeviceEvent) => unknown)[] = [];
  const devices = {
    ...recorder.devices,
    list: vi.fn(async () => ok({ revision: 1, providers: [], sessions: [session] })),
    session: vi.fn(async () => ok(structuredClone({ session, sources: catalog }))),
    read: vi.fn(async (): Promise<ReturnType<typeof ok<ReadSnapshot>>> =>
      ok({
        sessionId: session.sessionId,
        revision: 1,
        status: "fresh",
        ageMs: 0,
        frame: recorder.frame(10),
      }),
    ),
    subscribe: vi.fn<PluginContext["devices"]["subscribe"]>(async (_params, callback) => {
      deviceCallbacks.push(callback);
      return ok({
        subscriptionId: id(++subscription),
        snapshot: { revision: 1, providers: [], sessions: [session] },
        lastSequence: 0,
        dispose: vi.fn(async () => ok({ removed: true })),
      });
    }),
  } satisfies Partial<PluginContext["devices"]>;
  const copyText = vi.fn(async () => ok({ copied: true }));
  const context = {
    pluginId: manifest.id,
    locale: "en",
    commands: { register: vi.fn(), registerContext },
    ui,
    devices,
    storage: recorder.storage,
    actions: { copyText },
    settings: {},
  } as unknown as PluginContext;
  configure?.(context);
  const controller = new LabController(context);
  cleanup.push(() => {
    controller.dispose();
    store.retireHost(owner.hostEpoch);
    data.retire();
  });
  controller.register();
  controller.ready();
  await settle();
  const commands = new Map(
    manifest.contributes.commands.map((c) => {
      const d = contextCommandDeclarationSchema.parse(c);
      return [d.id, d];
    }),
  );
  const host = new UiInteractions({
    resolve: (b) =>
      bindings.some((candidate) => candidate.panelInstance === b.panelInstance)
        ? {
            owner,
            resource: resources[b.kind],
            state: structuredClone(stateOf(b)),
            workbenchInstance: "lab",
            contextRef: null,
            commands,
          }
        : null,
    snapshot: async (q) => store.snapshot(owner, q),
    read: async (q) => store.read(owner, q),
    currentData: (_b, expected) => {
      const r = store.snapshot(owner, { binding });
      return (
        r.ok &&
        expected.every((e) =>
          r.value.datasets.some(
            (d) =>
              d.dataset === e.dataset &&
              d.revision === e.revision &&
              d.presentation === e.presentation,
          ),
        )
      );
    },
    admit: () => null,
    acceptForm: (_b, revision, form) => {
      if (revision !== state.formRevision + 1) return false;
      state.formRevision = revision;
      state.form = structuredClone(form);
      emit("form");
      return true;
    },
    mintAction: () => id(80),
    now: () => performance.now(),
    dispatch: async (_r, invocation) =>
      ok(
        await handlers.get(invocation.command)!({
          ...invocation,
          signal: new AbortController().signal,
        }),
      ),
    core: async () => {
      await recorder.recording.release({ reservationId: id(1) });
      return ok({ output: {}, fieldErrors: [] });
    },
  });
  cleanup.push(() => host.dispose());
  const invoke = async (name: string, args: Record<string, UiScalar> = {}, increment = true) => {
    if (increment) {
      state.formRevision++;
      emit("form");
    }
    return handlers.get(`kobrixa.sensor-lab.${name}`)!({
      version: 1,
      invocationId: id(++subscription),
      command: `kobrixa.sensor-lab.${name}`,
      arguments: args,
      context: {
        origin: "panel",
        contextRef: null,
        actionRef: id(80),
        binding,
        form: { revision: state.formRevision, values: structuredClone(state.form) },
        locale: "en",
        trigger: { kind: "activate" },
      },
      signal: new AbortController().signal,
    });
  };
  const paint = async () => {
    await settle();
    await vi.advanceTimersByTimeAsync(1600);
    await settle();
  };
  const metadata = (dataset: string) => {
    const r = store.snapshot(owner, { binding });
    if (!r.ok) throw new Error("snapshot");
    return r.value.datasets.find((d) => d.dataset === dataset)!;
  };
  const read = (dataset: string) => {
    const m = metadata(dataset);
    const r = store.read(owner, { binding, dataset, revision: m.revision, offset: 0, limit: 50 });
    if (!r.ok) throw new Error("read");
    return r.value;
  };
  const edit = async (set: Record<string, UiScalar>) => {
    Object.assign(state.form, set);
    state.formRevision++;
    emit("form");
    await settle();
  };
  const choose = async () => {
    await invoke("select-current");
    await paint();
    await invoke("select-channel", {
      key: source.channel.channelId,
      revision: "1",
      dataset: metadata("available").revision,
    });
    await paint();
  };
  return {
    controller,
    context,
    recorder,
    source,
    session,
    catalog,
    ui,
    host,
    state,
    status,
    binding,
    statusBinding,
    handlers,
    devices,
    copyText,
    registerContext,
    invoke,
    paint,
    edit,
    choose,
    read,
    metadata,
    emit,
    event,
    deviceCallbacks,
    close: () => {
      bindings = [statusBinding];
      event({
        kind: "ui.instances",
        data: { instances: bindings },
        version: 1,
        delivery: "control",
        subscriptionId: id(1000),
        sequence: 1,
        owner,
      });
    },
    resync: async (affected: string[] = []) =>
      resync({
        event: {
          kind: "events.resyncRequired",
          version: 1,
          delivery: "control",
          subscriptionId: id(1000),
          sequence: 1,
          owner,
          data: { affected: [...callbacks.keys(), ...affected] },
        } as never,
        cleanup: Promise.resolve([ok({ removed: true })]),
        subscriptions: [],
      }),
  };
}

it("registers exactly the shipped context commands and publishes all eight bounded datasets tagged with the original form revision", async () => {
  const f = await fixture();
  await f.paint();
  expect(f.registerContext.mock.calls.map(([name, args]) => ({ name, args }))).toEqual(
    manifest.contributes.commands.map((c) => ({ name: c.id, args: c.arguments })),
  );
  expect(f.state.data["derived-form-revision"]).toBe(f.state.formRevision);
  expect(f.read("available").chunk.entries).toEqual([]);
  expect(f.devices.list).not.toHaveBeenCalled(); // explicit select-current only
  await f.choose();
  expect(f.read("available").chunk.entries).toHaveLength(1);
  expect(f.read("code").chunk.entries.join("")).toContain("Sensor.ReadSIValue(1, 0)");
  expect(f.state.data.summary).not.toContain("draft:");
});
it("Capture/Zero update the full canonical draft; hidden numeric values and applied calibration stay independent", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "source-a": "broken", "zero-offset": "broken" });
  await f.invoke("capture-a");
  expect(f.state.form["source-a"]).toBe("10");
  await f.invoke("zero");
  expect(f.state.form["zero-offset"]).toBe("10");
  await f.invoke("clear-zero");
  expect(f.state.form["zero-offset"]).toBe("0");
  await f.edit({
    "two-point": true,
    "source-a": "0",
    "source-b": "100",
    "target-a": "0",
    "target-b": "200",
  });
  await f.invoke("apply");
  await f.edit({ "target-b": "300", "recording-name": "Trial" });
  await f.invoke("start");
  const initial = [...f.recorder.writes.values()][0]!;
  const recording = JSON.parse(initial.bytes.toString());
  expect(recording.channels[0].calibration.targetB).toBe(200);
  expect(f.state.form["target-b"]).toBe("300");
});
it("drops late Capture on edit, hide, or changed source; stale readings never patch", async () => {
  const f = await fixture();
  await f.choose();
  const late = deferred<Awaited<ReturnType<typeof f.devices.read>>>();
  f.devices.read.mockImplementationOnce(() => late.promise);
  const job = f.invoke("capture-a");
  const assertion = expect(job).rejects.toThrow("changed");
  await settle();
  await f.edit({ "source-a": "42" });
  late.resolve(
    ok({
      sessionId: f.session.sessionId,
      revision: 1,
      status: "fresh",
      ageMs: 0,
      frame: f.recorder.frame(10),
    }),
  );
  await assertion;
  expect(f.state.form["source-a"]).toBe("42");
  f.devices.read.mockResolvedValueOnce(
    ok({
      sessionId: f.session.sessionId,
      revision: 1,
      status: "fresh",
      ageMs: 2501,
      frame: f.recorder.frame(10),
    }),
  );
  await expect(f.invoke("capture-a")).rejects.toThrow("Fresh");
  f.session.sourceRevision = 2;
  f.catalog.sourceRevision = 2;
  await expect(f.invoke("capture-a")).rejects.toThrow("detached");
});
it("actual host code-copy increments form revision once, accepts identical full form and rejects changed content", async () => {
  const f = await fixture();
  await f.choose();
  const view = await f.host.interact({ kind: "viewState", binding: f.binding });
  if (!view.ok || view.value.kind !== "view") throw new Error(JSON.stringify(view));
  const original = f.state.formRevision,
    m = f.metadata("code");
  const result = await f.host.interact({
    kind: "codeCopy",
    binding: f.binding,
    nodeId: "code",
    dataset: "code",
    revision: m.revision,
    presentation: Number(f.state.data.presentation),
    viewGeneration: view.value.view.generation,
    formRevision: original + 1,
    form: structuredClone(f.state.form),
  });
  expect(result.ok).toBe(true);
  expect(f.state.formRevision).toBe(original + 1);
  expect(f.copyText).toHaveBeenCalledOnce();
  await f.edit({ "zero-offset": "3" });
  await expect(f.invoke("copy-code")).rejects.toThrow("current draft code");
  expect(f.copyText).toHaveBeenCalledOnce();
});
it("selected-channel bound is four and stale table revisions cannot change selection", async () => {
  const f = await fixture();
  f.catalog.channels = Array.from({ length: 5 }, (_, i) => ({
    ...f.source.channel,
    channelId: id(30 + i),
    component: i,
  }));
  await f.invoke("select-current");
  await f.paint();
  for (let i = 0; i < 4; i++) {
    await f.invoke("select-channel", {
      key: id(30 + i),
      revision: "1",
      dataset: f.metadata("available").revision,
    });
    await f.paint();
  }
  await expect(
    f.invoke("select-channel", {
      key: id(34),
      revision: "1",
      dataset: f.metadata("available").revision,
    }),
  ).rejects.toThrow("four");
  await expect(
    f.invoke("select-channel", { key: id(30), revision: "1", dataset: 0 }),
  ).rejects.toThrow("Stale");
});
it("hiding/closing a panel leaves the real recorder alive; original host drain alone submits final writes", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "recording-name": "Background" });
  await f.invoke("start");
  await f.paint();
  expect(f.status.data.reservation).toBe(id(1));
  f.state.visible = false;
  f.emit("visibility");
  f.close();
  await settle();
  expect(f.recorder.recording.release).not.toHaveBeenCalled();
  f.recorder.append(f.recorder.frame(11));
  expect(
    (await f.host.interact({ kind: "core", binding: f.statusBinding, actionId: "stop" })).ok,
  ).toBe(true);
  const drained = await f.controller.drain(f.recorder.drain());
  expect(drained).toMatchObject({ ok: true, value: { status: "submitted" } });
  await f.paint();
  expect(f.status.data.reservation).toBeNull();
  expect(f.status.data.summary).toContain("durable save not confirmed");
});
it("submitted remains locked until explicit Refresh reconciles original final metadata; foreign revision never unlocks", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "recording-name": "First" });
  await f.invoke("start");
  f.recorder.end("released");
  await f.controller.drain(f.recorder.drain());
  await expect(f.invoke("reset")).rejects.toThrow("locked");
  await expect(f.invoke("start")).rejects.toThrow("locked");
  const meta = [...f.recorder.writes.values()].at(-1)!.record!;
  vi.mocked(f.recorder.storage.stat).mockResolvedValueOnce(
    ok({ record: { ...meta, revision: "foreign" } }),
  );
  await expect(f.invoke("refresh")).rejects.toThrow("not reconciled");
  await expect(f.invoke("reset")).rejects.toThrow("locked");
  vi.mocked(f.recorder.storage.stat).mockResolvedValueOnce(ok({ record: meta }));
  await f.invoke("refresh");
  await f.invoke("reset");
});
it("profile pages are filtered by semantic source compatibility and retain Next without silently trimming", async () => {
  const f = await fixture();
  const meta = (n: number): RecordMeta => ({
    id: id(n),
    revision: "r1",
    kind: "sensor-lab.calibration",
    schemaVersion: 2,
    label: `Profile ${n}`,
    mediaType: "application/json",
    byteLength: 100,
    sha256: "a".repeat(64),
    createdAt: 0,
    updatedAt: 0,
    checkpoint: "none",
    interrupted: false,
  });
  vi.mocked(f.recorder.storage.list).mockImplementation(async (q) =>
    ok(
      q.kind === "sensor-lab.calibration"
        ? { entries: [meta(50), meta(51)], nextCursor: id(90) }
        : { entries: [] },
    ),
  );
  vi.spyOn(LabLibrary.prototype, "read").mockImplementation(async (m) => ({
    schemaVersion: 2,
    id: m.id,
    name: m.label,
    source:
      m.id === id(50)
        ? f.source
        : { ...f.source, channel: { ...f.source.channel, typeId: "ev3:31" } },
    calibration: f.recorder.options.channels[0]!.calibration,
  }));
  await f.choose();
  await f.invoke("refresh");
  await f.paint();
  expect(f.read("profiles").chunk.entries).toEqual([
    { key: id(50), version: "r1", cells: ["Profile 50"] },
  ]);
  expect(f.state.data.summary).toContain("more pages available");
});
it("rebinds UI subscriptions after explicit terminal resync without replaying commands or recording", async () => {
  const f = await fixture();
  await f.choose();
  const calls = f.devices.list.mock.calls.length;
  await f.resync();
  await f.paint();
  expect(f.ui.onResyncRequired).toHaveBeenCalledOnce();
  expect(f.devices.list).toHaveBeenCalledTimes(calls);
  expect(f.recorder.recording.reserve).not.toHaveBeenCalled();
  expect(f.state.data["derived-form-revision"]).toBe(f.state.formRevision);
});
it("definition attaches activate/ready/drain/deactivate without a desktop dependency", () => {
  const plugin = createLabPlugin();
  expect(Object.keys(plugin).sort()).toEqual(["activate", "deactivate", "drain", "ready"]);
});

it("an edit during dataset transfer keeps the original derived revision and prevents copying stale code", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ unit: "cm" });
  const original = f.state.formRevision;
  const commit = f.context.ui.data.commit.bind(f.context.ui.data);
  vi.spyOn(f.context.ui.data, "commit").mockImplementationOnce(async (...args) => {
    await f.edit({ "zero-offset": "5" });
    return commit(...args);
  });
  await f.paint();
  const panelPatches = f.ui.patch.mock.calls.filter(([b]) => b.kind === "panel");
  expect(panelPatches.at(-1)?.[2]["derived-form-revision"]).toBe(original);
  expect(f.state.data["derived-form-revision"]).not.toBe(f.state.formRevision);
  await expect(f.invoke("copy-code")).rejects.toThrow("current draft code");
  await f.paint();
  expect(f.state.data["derived-form-revision"]).toBe(f.state.formRevision);
});
it("hiding while Capture is pending prevents form backfill and does not replay on show", async () => {
  const f = await fixture();
  await f.choose();
  const pending = deferred<Awaited<ReturnType<typeof f.devices.read>>>();
  f.devices.read.mockImplementationOnce(() => pending.promise);
  const job = f.invoke("capture-a");
  const rejected = expect(job).rejects.toThrow("unavailable");
  await settle();
  f.state.visible = false;
  f.emit("visibility");
  pending.resolve(
    ok({
      sessionId: f.session.sessionId,
      revision: 1,
      status: "fresh",
      ageMs: 0,
      frame: f.recorder.frame(10),
    }),
  );
  await rejected;
  expect(f.state.form["source-a"]).toBe("0");
  f.state.visible = true;
  f.emit("visibility");
  await f.paint();
  expect(f.state.form["source-a"]).toBe("0");
});
it("worst-case available labels fit canonical byte bounds; oversized catalogs fail explicitly without silent truncation", async () => {
  const f = await fixture();
  f.catalog.channels = Array.from({ length: 38 }, (_, i) => ({
    ...f.source.channel,
    channelId: id(100 + i),
    name: "界".repeat(80),
    modeName: "界".repeat(80),
    unit: "界".repeat(32),
  }));
  await f.invoke("select-current");
  await f.paint();
  const page = f.read("available");
  expect(page.chunk.entries).toHaveLength(38);
  expect(page.byteLength).toBeLessThan(49152);
  f.catalog.channels = Array.from({ length: 51 }, (_, i) => ({
    ...f.source.channel,
    channelId: id(100 + i),
  }));
  await f.invoke("refresh");
  await f.paint();
  expect(f.read("available").revision).toBe(page.revision);
  // No valid presentation of a silently truncated catalog is published.
  expect(f.state.data.error).toContain("50-row");
});
it("status core Stop uses its own host path while a slow calibration command is pending", async () => {
  const f = await fixture();
  await f.choose();
  f.status.data.reservation = id(1);
  const pending = deferred<Awaited<ReturnType<typeof f.devices.read>>>();
  f.devices.read.mockImplementationOnce(() => pending.promise);
  const capture = f.invoke("capture-a");
  await settle();
  const stop = await f.host.interact({ kind: "core", binding: f.statusBinding, actionId: "stop" });
  expect(stop.ok).toBe(true);
  expect(f.recorder.recording.release).toHaveBeenCalledOnce();
  pending.resolve(
    ok({
      sessionId: f.session.sessionId,
      revision: 1,
      status: "fresh",
      ageMs: 0,
      frame: f.recorder.frame(10),
    }),
  );
  await capture;
});

function storeProfiles(
  f: Awaited<ReturnType<typeof fixture>>,
  count = 2,
  sharedModel = true,
  first = 50,
) {
  const rows = Array.from({ length: count }, (_, i) => first + i).map((n) => {
    const raw = {
      schemaVersion: 2,
      id: id(sharedModel ? 99 : 1000 + n),
      name: `Profile ${n}`,
      source: f.source,
      calibration: { ...f.recorder.options.channels[0]!.calibration, zeroOffset: n },
    };
    const bytes = Buffer.from(JSON.stringify(raw));
    const meta: RecordMeta = {
      id: id(n),
      revision: "r1",
      kind: "sensor-lab.calibration",
      schemaVersion: 2,
      label: raw.name,
      mediaType: "application/json",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: 0,
      updatedAt: 0,
      checkpoint: "none",
      interrupted: false,
    };
    return { raw, bytes, meta };
  });
  vi.mocked(f.recorder.storage.list).mockImplementation(async (q) => {
    if (q.kind !== "sensor-lab.calibration") return ok({ entries: [] });
    const offset = q.cursor ? Number(q.cursor.slice(-12)) : 0;
    return ok({
      entries: rows.slice(offset, offset + 50).map((r) => r.meta),
      ...(offset + 50 < rows.length ? { nextCursor: id(offset + 50) } : {}),
    });
  });
  vi.mocked(f.recorder.storage.openRead).mockImplementation(async (q) =>
    ok({ read: q.id, record: rows.find((r) => r.meta.id === q.id)!.meta, expiresAt: 10000 }),
  );
  vi.mocked(f.recorder.storage.readChunk).mockImplementation(async (q) => {
    const bytes = rows.find((r) => r.meta.id === q.read)!.bytes;
    return ok({
      offset: q.offset,
      nextOffset: bytes.length,
      eof: true,
      data: bytes.subarray(q.offset).toString("base64"),
    });
  });
  vi.mocked(f.recorder.storage.closeRead).mockImplementation(async () => ok({}));
  return rows;
}
it.each([true, false])(
  "explicit reselection replaces stale source pin (select-current=%s)",
  async (selectCurrent) => {
    const f = await fixture();
    await f.choose();
    f.session.sourceRevision = 2;
    f.catalog.sourceRevision = 2; // unaffected channel ID stays the same, as actual provider does
    await f.invoke("refresh");
    await f.paint();
    expect(f.state.data["can-start"]).toBe(false); // Refresh must never auto-rebind.
    if (selectCurrent) await f.invoke("select-current");
    await f.paint();
    await f.invoke("select-channel", {
      key: f.source.channel.channelId,
      revision: "2",
      dataset: f.metadata("available").revision,
    });
    await f.paint();
    expect(f.state.data["can-start"]).toBe(true);
    await f.invoke("remove-channel");
    await f.paint();
    await f.invoke("select-channel", {
      key: f.source.channel.channelId,
      revision: "2",
      dataset: f.metadata("available").revision,
    });
    await f.paint();
    expect(f.state.data["can-start"]).toBe(true); // explicit remove + fresh select is a passing control
  },
);
it("duplicate payload model IDs block profile selection", async () => {
  const f = await fixture();
  await f.choose();
  const rows = storeProfiles(f);
  await f.invoke("refresh");
  await f.paint();
  expect(f.read("profiles").chunk.entries).toHaveLength(2);
  await expect(
    f.invoke("apply-profile", {
      key: rows[0]!.meta.id,
      revision: "r1",
      dataset: f.metadata("profiles").revision,
    }),
  ).rejects.toThrow();
});
it("recovered host-interrupted metadata projects terminal evidence into exported CSV", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "recording-name": "Original checkpoint" });
  await f.invoke("start");
  const original = [...f.recorder.writes.values()].at(-1)!;
  const bytes = Buffer.from(original.bytes);
  const raw = JSON.parse(bytes.toString());
  expect(raw.reason).toBeUndefined();
  const meta = { ...original.record!, id: id(70), interrupted: true };
  vi.mocked(f.recorder.storage.list).mockImplementation(async (q) =>
    ok({ entries: q.kind === "sensor-lab.recording" ? [meta] : [] }),
  );
  vi.mocked(f.recorder.storage.openRead).mockImplementation(async () =>
    ok({ read: id(70), record: meta, expiresAt: 10000 }),
  );
  vi.mocked(f.recorder.storage.readChunk).mockImplementation(async (q) =>
    ok({
      offset: q.offset,
      nextOffset: bytes.length,
      eof: true,
      data: bytes.subarray(q.offset).toString("base64"),
    }),
  );
  vi.mocked(f.recorder.storage.closeRead).mockImplementation(async () => ok({}));
  await f.invoke("refresh");
  await f.paint();
  await f.invoke("view-record", {
    key: meta.id,
    revision: meta.revision,
    dataset: f.metadata("history").revision,
  });
  const start = vi.spyOn(LabExport.prototype, "start").mockResolvedValue(undefined);
  await f.invoke("export");
  const csv = start.mock.calls[0]![1].bytes.toString("utf8");
  expect(original.bytes.equals(bytes)).toBe(true);
  expect(csv).toContain("interrupted");
  const row = csv.split("\r\n")[1]!.split(",");
  expect(row[3]).toBe(new Date(raw.frames.at(-1).sampledAt).toISOString());
  expect(row[4]).toBe("interrupted");
});

it("source refresh never rebinds an active recording, and explicit reselection stays locked", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "recording-name": "Pinned source" });
  await f.invoke("start");
  const original = [...f.recorder.writes.values()][0]!;
  const bytes = Buffer.from(original.bytes);
  f.session.sourceRevision = 2;
  f.catalog.sourceRevision = 2;
  await f.invoke("refresh");
  await f.paint();
  await expect(f.invoke("select-current")).rejects.toThrow("locked");
  await expect(
    f.invoke("select-channel", {
      key: f.source.channel.channelId,
      revision: "2",
      dataset: f.metadata("available").revision,
    }),
  ).rejects.toThrow("locked");
  expect(original.bytes.equals(bytes)).toBe(true);
  expect(JSON.parse(bytes.toString()).channels[0].source.provenance.sourceRevision).toBe(1);
  expect(f.recorder.recording.reserve).toHaveBeenCalledOnce();
});
it("profile ambiguity survives paging and refresh; same host revision changes alone are allowed", async () => {
  const f = await fixture();
  await f.choose();
  const rows = storeProfiles(f);
  const list = vi.mocked(f.recorder.storage.list);
  list.mockImplementation(async (q) =>
    ok(
      q.kind === "sensor-lab.calibration"
        ? { entries: [rows[q.cursor ? 1 : 0]!.meta], ...(!q.cursor ? { nextCursor: id(91) } : {}) }
        : { entries: [] },
    ),
  );
  await f.invoke("refresh");
  await f.paint();
  const apply = (n: number) =>
    f.invoke("apply-profile", {
      key: rows[n]!.meta.id,
      revision: rows[n]!.meta.revision,
      dataset: f.metadata("profiles").revision,
    });
  await apply(0); // Only one model/host association has been discovered.
  rows[0]!.meta.revision = "r2";
  await f.invoke("refresh");
  await f.paint();
  await apply(0); // A new revision of the same host record is not a duplicate.
  await f.invoke("profiles-next");
  await f.paint();
  await expect(apply(1)).rejects.toThrow("Ambiguous");
  await f.invoke("refresh");
  await f.paint();
  await expect(apply(0)).rejects.toThrow("Ambiguous");
});
it("256 discovered identities are retained; unseen identities fail closed without eviction", async () => {
  const f = await fixture();
  await f.choose();
  storeProfiles(f, 256, false);
  await f.invoke("refresh");
  await f.paint();
  for (let page = 1; page < 6; page++) {
    await f.invoke("profiles-next");
    await f.paint();
  }
  // Simulate deleting old rows then creating another profile, not an oversized
  // current host inventory. The process must not forget past discoveries.
  const fresh = storeProfiles(f, 1, false, 500)[0]!;
  await f.invoke("refresh");
  await f.paint();
  expect(f.state.data.error).toContain("identity capacity");
  expect(f.read("profiles").chunk.entries).toEqual([]);
  const known = storeProfiles(f, 1, false)[0]!;
  await f.invoke("refresh");
  await f.paint();
  await f.invoke("apply-profile", {
    key: known.meta.id,
    revision: known.meta.revision,
    dataset: f.metadata("profiles").revision,
  });
  expect(f.state.form["zero-offset"]).toBe("50");
  expect(fresh.raw.id).not.toBe(known.raw.id);
});
it("history ambiguity blocks comparison and export, while equal model IDs in different kinds remain independent", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "recording-name": "History identity" });
  await f.invoke("start");
  const written = [...f.recorder.writes.values()].at(-1)!;
  const raw = JSON.parse(written.bytes.toString());
  const profile = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      id: raw.id,
      name: "Separate kind",
      source: f.source,
      calibration: f.recorder.options.channels[0]!.calibration,
    }),
  );
  const first = { meta: { ...written.record!, id: id(70) }, bytes: Buffer.from(written.bytes) };
  const second = { meta: { ...written.record!, id: id(71) }, bytes: Buffer.from(written.bytes) };
  const other = {
    meta: {
      ...written.record!,
      id: id(72),
      kind: "sensor-lab.calibration",
      checkpoint: "none" as const,
      byteLength: profile.length,
      sha256: createHash("sha256").update(profile).digest("hex"),
    },
    bytes: profile,
  };
  const rows = [first, other];
  vi.mocked(f.recorder.storage.list).mockImplementation(async (q) =>
    ok({ entries: rows.filter((r) => r.meta.kind === q.kind).map((r) => r.meta) }),
  );
  vi.mocked(f.recorder.storage.openRead).mockImplementation(async (q) =>
    ok({ read: q.id, record: rows.find((r) => r.meta.id === q.id)!.meta, expiresAt: 10000 }),
  );
  vi.mocked(f.recorder.storage.readChunk).mockImplementation(async (q) => {
    const bytes = rows.find((r) => r.meta.id === q.read)!.bytes;
    return ok({
      offset: q.offset,
      nextOffset: bytes.length,
      eof: true,
      data: bytes.subarray(q.offset).toString("base64"),
    });
  });
  vi.mocked(f.recorder.storage.closeRead).mockImplementation(async () => ok({}));
  await f.invoke("refresh");
  await f.paint();
  expect(f.read("profiles").chunk.entries).toHaveLength(1);
  const select = (name: string, meta: RecordMeta) =>
    f.invoke(name, {
      key: meta.id,
      revision: meta.revision,
      dataset: f.metadata("history").revision,
    });
  await select("view-record", first.meta); // Same model ID in calibration kind is not ambiguous.
  rows.push(second);
  await f.invoke("refresh");
  await f.paint();
  await expect(select("compare-record", second.meta)).rejects.toThrow("Ambiguous");
  const start = vi.spyOn(LabExport.prototype, "start").mockResolvedValue(undefined);
  await expect(f.invoke("export")).rejects.toThrow("Ambiguous");
  expect(start).not.toHaveBeenCalled();
  await expect(select("view-record", first.meta)).rejects.toThrow("Ambiguous");
});
it("a duplicate discovered during profile backfill cannot apply calibration to the recording source", async () => {
  const f = await fixture();
  await f.choose();
  const rows = storeProfiles(f);
  const pendingRead = deferred<Awaited<ReturnType<typeof f.recorder.storage.readChunk>>>();
  const read = vi.mocked(f.recorder.storage.readChunk).getMockImplementation()!;
  vi.mocked(f.recorder.storage.readChunk).mockImplementation((q) =>
    q.read === rows[1]!.meta.id ? pendingRead.promise : read(q),
  );
  await f.invoke("refresh");
  await f.paint();
  expect(f.read("profiles").chunk.entries).toHaveLength(1);
  const pendingPatch = deferred<Awaited<ReturnType<typeof f.ui.formPatch>>>();
  const patch = f.ui.formPatch.getMockImplementation()!;
  let receipt: Awaited<ReturnType<typeof f.ui.formPatch>> | undefined;
  f.ui.formPatch.mockImplementationOnce(async (...args) => {
    receipt = await patch(...args);
    return pendingPatch.promise;
  });
  const applying = f.invoke("apply-profile", {
    key: rows[0]!.meta.id,
    revision: rows[0]!.meta.revision,
    dataset: f.metadata("profiles").revision,
  });
  const rejected = expect(applying).rejects.toThrow("Ambiguous");
  await settle();
  expect(receipt).toBeDefined();
  pendingRead.resolve(
    ok({
      offset: 0,
      nextOffset: rows[1]!.bytes.length,
      eof: true,
      data: rows[1]!.bytes.toString("base64"),
    }),
  );
  await settle();
  pendingPatch.resolve(receipt!);
  await rejected;
  await f.edit({ "recording-name": "Applied stays original" });
  await f.invoke("start");
  expect(
    JSON.parse([...f.recorder.writes.values()][0]!.bytes.toString()).channels[0].calibration
      .zeroOffset,
  ).toBe(0);
});

it("numeric unapplied draft preview shares the guarded code dataset and never Applies to recording", async () => {
  const f = await fixture();
  await f.choose();
  const text = () => f.read("code").chunk.entries.join("");
  expect(text()).toContain("raw=10; result=10 cm");
  await f.edit({ "zero-offset": "3" });
  await f.paint();
  expect(text()).toContain("raw=10; result=7 cm");
  expect(f.state.data["derived-form-revision"]).toBe(f.state.formRevision);
  expect(Object.keys(panelJson.datasets)).toHaveLength(8);
  await f.edit({ "recording-name": "Unapplied preview" });
  await f.invoke("start");
  expect(
    JSON.parse([...f.recorder.writes.values()][0]!.bytes.toString()).channels[0].calibration
      .zeroOffset,
  ).toBe(0);
  await f.edit({ "source-a": "-" });
  await f.paint();
  expect(text()).toContain("raw=10; invalid calibration draft");
  f.devices.read.mockResolvedValue(
    ok({
      sessionId: f.session.sessionId,
      revision: 1,
      status: "stale",
      ageMs: 3000,
      frame: f.recorder.frame(11),
    }),
  );
  await f.paint();
  expect(text()).toContain("stale or unavailable reading");
  expect(text()).not.toContain("result=7");
});
it("numeric preview keeps its original form correlation across an edit during transfer", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "zero-offset": "2" });
  const original = f.state.formRevision;
  const commit = f.context.ui.data.commit.bind(f.context.ui.data);
  vi.spyOn(f.context.ui.data, "commit").mockImplementationOnce(async (...args) => {
    await f.edit({ "zero-offset": "4" });
    return commit(...args);
  });
  await f.paint();
  expect(f.read("code").chunk.entries.join("")).toContain("result=8 cm");
  expect(f.state.data["derived-form-revision"]).toBe(original);
  expect(f.state.data["derived-form-revision"]).not.toBe(f.state.formRevision);
  await f.paint();
  expect(f.read("code").chunk.entries.join("")).toContain("result=6 cm");
  expect(f.state.data["derived-form-revision"]).toBe(f.state.formRevision);
});
it("stale cursor rejects per request without overwriting a feature error or painting", async () => {
  const f = await fixture();
  await f.choose();
  await f.edit({ "source-a": "-" });
  await expect(f.invoke("apply")).rejects.toThrow();
  await f.paint();
  const error = f.state.data.error;
  const patches = f.ui.patch.mock.calls.length;
  await expect(f.invoke("cursor", { time: 0, presentation: -1 }, false)).rejects.toThrow(
    "Stale cursor",
  );
  await settle();
  expect(f.state.data.error).toBe(error);
  expect(f.ui.patch).toHaveBeenCalledTimes(patches);
});
import { createRecordService } from "../../main/plugins/persistence/record-service.js";
import type { RecordDependencies } from "../../main/plugins/persistence/record-port.js";
it("actual RecordService one-list/source gate admits serialized startup plus overlapping Refresh", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const unused = () => {
    throw new Error("Unexpected non-list record service port");
  };
  const deps: RecordDependencies = {
    now: () => 0,
    wall: () => 0,
    live: () => true,
    permission: () => true,
    engine: new Proxy({} as RecordDependencies["engine"], { get: () => unused }),
    evidence: new Proxy({} as RecordDependencies["evidence"], { get: () => unused }),
    checkpoint: new Proxy({} as RecordDependencies["checkpoint"], { get: () => unused }),
    read: {
      settings: unused,
      stat: unused,
      open: unused,
      read: unused,
      close: unused,
      list: async () => {
        calls++;
        if (calls === 1) await gate.promise;
        return { entries: [] };
      },
    },
  };
  const service = createRecordService(deps);
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: manifest.id,
    generation: 1,
    hostEpoch: id(10),
    processEpoch: id(11),
  };
  const principal = { kind: "plugin" as const, owner, authorityContext: null };
  const results: boolean[] = [];
  const f = await fixture((context) => {
    context.storage.list = vi.fn(async (q, signal) => {
      const result = await service.request(
        principal,
        "storage/list",
        q,
        signal ?? new AbortController().signal,
      );
      results.push(result.ok);
      return result;
    });
  });
  const refresh = f.invoke("refresh");
  await settle();
  expect(calls).toBe(1);
  // Control proves this is the actual host rule, not a permissive mock.
  expect(
    await service.request(
      principal,
      "storage/list",
      { kind: "sensor-lab.calibration", limit: 50 },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  gate.resolve();
  await refresh;
  await f.paint();
  expect(results).toEqual([true, true, true, true]);
  expect(f.state.data["has-error"]).toBe(false);
  await service.close();
});
function terminalEvent(subscriptionId: string, affected: string[]): DeviceEvent {
  return {
    version: 1,
    owner: {
      sourceKey: "builtin:kobrixa.sensor-lab",
      pluginId: manifest.id,
      generation: 1,
      hostEpoch: id(10),
      processEpoch: id(11),
    },
    subscriptionId,
    sequence: 1,
    delivery: "control",
    kind: "events.resyncRequired",
    data: { reason: "overflow", affected },
  };
}
it("common terminal reattaches only observations, disposes old handles and fences their callbacks", async () => {
  const f = await fixture();
  await f.choose();
  const old = await Promise.all(f.devices.subscribe.mock.results.map((r) => r.value));
  const ids = old.map((r) => {
    if (!r.ok) throw Error();
    return r.value.subscriptionId;
  });
  const callbacks = [...f.deviceCallbacks];
  callbacks[0]!(terminalEvent(ids[0]!, ids));
  await settle();
  expect(f.devices.subscribe).toHaveBeenCalledTimes(4);
  for (const r of old) if (r.ok) expect(r.value.dispose).toHaveBeenCalledOnce();
  const queries = f.devices.session.mock.calls.length;
  callbacks[1]!(terminalEvent(ids[1]!, ids)); // retired callback cannot restart again
  await settle();
  expect(f.devices.subscribe).toHaveBeenCalledTimes(4);
  expect(f.devices.session).toHaveBeenCalledTimes(queries);
  expect(f.recorder.recording.reserve).not.toHaveBeenCalled();
  expect(f.recorder.recording.release).not.toHaveBeenCalled();
  expect(f.devices.list).toHaveBeenCalledTimes(2); // explicit select + catalog observation query
  f.session.sourceRevision = 2;
  f.catalog.sourceRevision = 2;
  const current = await Promise.all(f.devices.subscribe.mock.results.slice(2).map((r) => r.value));
  await f.resync(current.flatMap((r) => (r.ok ? [r.value.subscriptionId] : [])));
  await f.paint();
  expect(f.state.data["can-start"]).toBe(false); // resync does not rebind selected sources
  expect(f.devices.subscribe).toHaveBeenCalledTimes(6);
});
it("terminal before adoption is cleaned, bounded at three reattachments, then waits explicit Refresh", async () => {
  const f = await fixture();
  let n = 5000;
  const disposed: ReturnType<typeof vi.fn>[] = [];
  f.devices.subscribe.mockImplementation(async (_q, callback) => {
    const subscriptionId = id(++n),
      dispose = vi.fn(async () => ok({ removed: false }));
    disposed.push(dispose);
    callback(terminalEvent(subscriptionId, [subscriptionId]));
    return ok({
      subscriptionId,
      snapshot: { revision: 1, providers: [], sessions: [] },
      lastSequence: 0,
      dispose,
    });
  });
  const initial = await f.devices.subscribe.mock.results[0]!.value;
  if (!initial.ok) throw Error();
  f.deviceCallbacks[0]!(
    terminalEvent(initial.value.subscriptionId, [initial.value.subscriptionId]),
  );
  await settle();
  await f.paint();
  expect(f.devices.subscribe).toHaveBeenCalledTimes(4); // initial + three bounded fresh requests
  for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
  expect(f.state.data.error).toContain("resync limit");
  await f.paint();
  expect(f.devices.subscribe).toHaveBeenCalledTimes(4);
  f.devices.subscribe.mockImplementation(async () =>
    ok({
      subscriptionId: id(++n),
      snapshot: { revision: 1, providers: [], sessions: [] },
      lastSequence: 0,
      dispose: vi.fn(async () => ok({ removed: true })),
    }),
  );
  await f.invoke("refresh");
  expect(f.devices.subscribe).toHaveBeenCalledTimes(5);
});
it("dispose fences a late observation subscribe receipt and disposes it without a new loop", async () => {
  const f = await fixture();
  const late = deferred<Awaited<ReturnType<typeof f.devices.subscribe>>>();
  f.devices.subscribe.mockImplementationOnce(() => late.promise);
  const initial = await f.devices.subscribe.mock.results[0]!.value;
  if (!initial.ok) throw Error();
  f.deviceCallbacks[0]!(
    terminalEvent(initial.value.subscriptionId, [initial.value.subscriptionId]),
  );
  await settle();
  expect(f.devices.subscribe).toHaveBeenCalledTimes(2);
  f.controller.dispose();
  const dispose = vi.fn(async () => ok({ removed: true }));
  late.resolve(
    ok({
      subscriptionId: id(6000),
      snapshot: { revision: 1, providers: [], sessions: [] },
      lastSequence: 0,
      dispose,
    }),
  );
  await settle();
  expect(dispose).toHaveBeenCalledOnce();
  expect(f.devices.subscribe).toHaveBeenCalledTimes(2);
});
import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
import { createDevicesClient } from "../../../../../packages/plugin-sdk-js/src/devices.js";
import {
  bindEventChannel,
  uiEventClientPort,
} from "../../../../../packages/plugin-sdk-js/src/events.js";
import { UiClient } from "../../../../../packages/plugin-sdk-js/src/ui.js";
import { EventLedger } from "../../main/device-broker/registry.js";
it("actual SDK/EventLedger terminal ACK precedes query and controller observation reattachment", async () => {
  const f = await fixture();
  await f.choose();
  const [a, b] = createMemoryChannelPair(),
    host = new RpcPeer(a),
    peer = new RpcPeer(b);
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: manifest.id,
    generation: 1,
    hostEpoch: id(10),
    processEpoch: id(11),
  };
  const trace: string[] = [];
  const ledger = new EventLedger(
    () => performance.now(),
    (event) => host.notify("events/deliver", event),
    () => {},
  );
  const handles: string[] = [];
  host.handle("devices/negotiate", () =>
    ok({
      devicesContractVersion: 1,
      eventVersion: 1,
      capabilities: [],
      requirementsSatisfied: true,
    }),
  );
  host.handle("devices/subscribe", (q) => {
    const created = ledger.create(owner);
    if (!created.ok) return created;
    const subscriptionId = created.value.subscriptionId;
    handles.push(subscriptionId);
    ledger.activate(owner, subscriptionId);
    trace.push("subscribe");
    return ok({
      subscriptionId,
      snapshot:
        q.topic === "catalog"
          ? { revision: 1, providers: [], sessions: [f.session] }
          : { session: f.session, sources: f.catalog },
      sequence: 0 as const,
    });
  });
  host.handle("devices/list", () => {
    trace.push("query");
    return ok({ revision: 1, providers: [], sessions: [f.session] });
  });
  host.handle("devices/session", () => {
    trace.push("query");
    return ok({ session: f.session, sources: f.catalog });
  });
  host.handle("events/ack", (q) => {
    trace.push("ack");
    return ledger.ack(owner, q.subscriptionId, q.sequence);
  });
  host.handle("events/unsubscribe", (q) => {
    trace.push("unsubscribe");
    return ledger.unsubscribe(owner, q.subscriptionId);
  });
  bindEventChannel(peer, owner);
  const ui = new UiClient(peer.request.bind(peer), uiEventClientPort(peer));
  const devices = createDevicesClient(peer, Promise.resolve("1.8.0"));
  cleanup.push(() => {
    ui.retire();
    ledger.dispose();
    host.close();
    peer.close();
  });
  await settle();
  const initial = await Promise.all(f.devices.subscribe.mock.results.map((r) => r.value));
  f.devices.subscribe.mockImplementation(devices.subscribe);
  const ids = initial.flatMap((r) => (r.ok ? [r.value.subscriptionId] : []));
  f.deviceCallbacks[0]!(terminalEvent(ids[0]!, ids));
  await settle();
  expect(handles).toHaveLength(2);
  trace.length = 0;
  expect(ledger.resync(owner, handles[0]!).ok).toBe(true);
  await settle();
  expect(handles).toHaveLength(4);
  expect(trace.indexOf("ack")).toBeGreaterThanOrEqual(0);
  expect(trace.indexOf("ack")).toBeLessThan(trace.indexOf("query"));
  expect(trace.indexOf("unsubscribe")).toBeLessThan(trace.indexOf("subscribe"));
  expect(ledger.owns(owner, handles[0]!)).toBe(false);
  expect(ledger.owns(owner, handles[1]!)).toBe(false);
  expect(f.recorder.recording.reserve).not.toHaveBeenCalled();
  expect(f.recorder.recording.release).not.toHaveBeenCalled();
  f.controller.dispose();
  await settle();
  expect(ledger.owns(owner, handles[2]!)).toBe(false);
  expect(ledger.owns(owner, handles[3]!)).toBe(false);
});
