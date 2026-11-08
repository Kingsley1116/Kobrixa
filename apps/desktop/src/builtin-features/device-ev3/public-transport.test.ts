import { MessageChannel, type MessagePort } from "node:worker_threads";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
import {
  type MessageChannelLike,
  RpcPeer,
  canonicalDatasetV2Bytes,
  type UiStateSnapshot,
  type UiResourceV2,
  type UiEventEnvelopeV2,
  type DatasetRowV2,
  type SettingsSnapshot,
  type SettingsRequestMap,
} from "@kobrixa/plugin-protocol";
import { UiStateRegistry } from "@kobrixa/plugin-runtime";
import { runPlugin } from "@kobrixa/plugin-sdk";
import { createDevicePlugin } from "../../../../../plugins/device-ev3/src/controller.js";
import panel from "../../../../../plugins/device-ev3/ui/panel.json" with { type: "json" };
import prefs from "../../../../../plugins/device-ev3/settings/preferences.json" with { type: "json" };
import { createDeviceBroker } from "../../main/device-broker/broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "../../main/device-broker/fake-provider.js";
import { attachDeviceRpc } from "../../main/device-broker/rpc-router.js";
import { bindEventChannel } from "../../../../../packages/plugin-sdk-js/src/events.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const ok = <T>(value: T) => ({ ok: true as const, value });
async function setup(
  options: {
    usb?: boolean;
    modes?: boolean;
    remember?: boolean;
    initialWifi?: boolean;
    formPatchEvents?: boolean;
  } = {},
) {
  const h = operationHarness();
  if (options.usb) {
    const original = h.provider.discover.bind(h.provider);
    vi.spyOn(h.provider, "discover").mockImplementation(async (ctx) => {
      const result = await original(ctx);
      if (result.value)
        for (const c of result.value) c.descriptor = { ...c.descriptor, transport: "usb" };
      return result;
    });
  }
  if (options.modes) {
    const original = h.provider.sources.bind(h.provider);
    vi.spyOn(h.provider, "sources").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (result.value) for (const c of result.value.channels) c.portId = "input:0";
      return result;
    });
  }
  let authorized = true;

  const principal = pluginPrincipal();
  principal.owner.pluginId = "kobrixa.device-ev3";
  principal.owner.sourceKey = "builtin:kobrixa.device-ev3";
  const broker = createDeviceBroker({
    profile: h.dependencies.profile,
    journal: h.dependencies.journal,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: authorized ? "local" : "unsynced",
        roomBinding: null,
        connected: false,
        synced: authorized,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: { claim: () => true, isClaimed: () => true, complete() {} },
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ok(null),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  const registration = broker.registerProvider(h.provider);
  const { port1, port2 } = new MessageChannel();
  const adapter = (port: MessagePort): MessageChannelLike => ({
    send: (text) => port.postMessage(text),
    onMessage(listener) {
      port.on("message", listener);
      return () => {
        port.off("message", listener);
      };
    },
  });
  const a = adapter(port1),
    b = adapter(port2);
  // Also close ports if setup fails before the full fixture disposer is installed.
  cleanups.push(async () => {
    port1.close();
    port2.close();
  });
  const host = new RpcPeer(a);
  const plugin = await runPlugin(createDevicePlugin(), { channel: b, exit: vi.fn() });
  bindEventChannel(plugin, principal.owner);
  const off = attachDeviceRpc({ peer: host, principal: () => principal, broker });
  // Real generic form synchronization, with fixture UI/settings wire handlers below.
  const forms = new UiStateRegistry({ current: () => true, supportedResourceVersions: [2] });
  const opened = await forms.open({
    owner: {
      sourceKey: principal.owner.sourceKey,
      pluginId: principal.owner.pluginId,
      uiResourceGeneration: 1,
    },
    scope: { hostEpoch: ID, workbenchInstance: ID },
    id: "kobrixa.device-ev3.panel",
    version: 2,
    resource: panel as UiResourceV2,
    initialVisible: true,
    activateInitialized: async () => ({
      owner: principal.owner,
      peer: host,
      requirements: [],
      principal: () => principal,
    }),
  });
  if (!opened.ok) throw new Error("Fixture form open failed");
  const state: UiStateSnapshot = opened.value;
  const binding = state.binding;
  const uiSubs = new Map<string, { sequence: number; binding: boolean }>();
  const external = new Set<string>();
  let settings: SettingsSnapshot = {
    schemaVersion: 1,
    revision: null,
    values: prefs.fields.map((f) => ({
      key: f.key,
      value:
        f.key === "rememberWifiAddress" && options.remember
          ? true
          : f.key === "connectionMode" && options.initialWifi
            ? "wifi"
            : f.default,
    })),
  };
  const metadata = new Map<
    string,
    { revision: number; presentation: number; byteLength: number; sha256: string }
  >();
  const rows = new Map<string, DatasetRowV2[]>();
  const transfers = new Map<
    string,
    {
      dataset: string;
      presentation: number;
      byteLength: number;
      sha256: string;
      entries: DatasetRowV2[];
    }
  >();
  // Host UI/settings wire fixture. Device requests and common device events use the actual router/broker.
  host.handle("events/ack", (p) =>
    external.has(p.subscriptionId)
      ? ok({ acknowledged: p.sequence })
      : broker.events.ack(principal.owner, p.subscriptionId, p.sequence),
  );
  host.handle("events/unsubscribe", async (p) => {
    if (external.delete(p.subscriptionId)) {
      uiSubs.delete(p.subscriptionId);
      return ok({ removed: true });
    }
    return broker.request(principal, "events/unsubscribe", p, new AbortController().signal);
  });
  const snapshot = () => ({
    instances: [binding],
    states: [state],
    locale: "en" as const,
    theme: "light" as const,
    data: [],
  });
  host.handle("ui/instances", () => ok({ instances: [binding] }));
  host.handle("ui/state", () => ok(structuredClone(state)));
  host.handle("ui/subscribe", (p) => {
    const subscriptionId = randomUUID();
    external.add(subscriptionId);
    uiSubs.set(subscriptionId, { sequence: 0, binding: !!p.binding });
    return ok({ subscriptionId, sequence: 0 as const, snapshot: snapshot() });
  });
  host.handle("ui/snapshot", (p) =>
    ok({ sequence: uiSubs.get(p.subscriptionId)?.sequence ?? 0, snapshot: snapshot() }),
  );
  host.handle("ui/formPatch", (p) => {
    expect(p.baseFormRevision).toBe(state.formRevision);
    Object.assign(state.form, p.set);
    state.formRevision++;
    expect(forms.setForm(principal.owner, binding, state.formRevision, state.form, true).ok).toBe(
      true,
    );
    if (options.formPatchEvents)
      for (const [subscriptionId, sub] of uiSubs) {
        if (sub.binding)
          host.notify("events/deliver", {
            version: 1,
            owner: principal.owner,
            subscriptionId,
            sequence: ++sub.sequence,
            delivery: "control",
            kind: "ui.form",
            data: { binding, revision: state.formRevision, values: state.form },
          });
      }
    return ok({ formRevision: state.formRevision, form: state.form });
  });
  host.handle("ui/patch", (p) => {
    expect(p.baseRevision).toBe(state.revision);
    Object.assign(state.data, p.set);
    return ok({ revision: ++state.revision });
  });
  host.handle("ui/dataSnapshot", () =>
    ok({ datasets: [...metadata].map(([dataset, m]) => ({ dataset, ...m })) }),
  );
  host.handle("ui/dataBegin", (p) => {
    expect(p.baseRevision).toBe(metadata.get(p.dataset)?.revision ?? 0);
    const transfer = randomUUID();
    transfers.set(transfer, {
      dataset: p.dataset,
      presentation: p.presentation,
      byteLength: p.byteLength,
      sha256: p.sha256,
      entries: [],
    });
    return ok({ transfer, nextOffset: 0 as const, remainingMs: 10000 });
  });
  host.handle("ui/dataChunk", (p) => {
    const t = transfers.get(p.transfer)!;
    expect(p.chunk.kind).toBe("table");
    if (p.chunk.kind === "table") t.entries.push(...p.chunk.entries);
    return ok({ nextOffset: t.entries.length, remainingMs: 10000 });
  });
  host.handle("ui/dataCommit", (p) => {
    const t = transfers.get(p.transfer)!;
    const bytes = canonicalDatasetV2Bytes({ kind: "table" }, t.entries);
    expect(bytes.length).toBe(t.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(t.sha256);
    const m = {
      revision: (metadata.get(p.dataset)?.revision ?? 0) + 1,
      presentation: t.presentation,
      byteLength: t.byteLength,
      sha256: t.sha256,
    };
    metadata.set(p.dataset, m);
    rows.set(p.dataset, t.entries);
    transfers.delete(p.transfer);
    return ok(m);
  });
  host.handle("ui/dataAbort", (p) => ok({ aborted: transfers.delete(p.transfer) }));
  host.handle("settings/read", () => ok(settings));
  host.handle("settings/watch", () => {
    const subscriptionId = randomUUID();
    external.add(subscriptionId);
    return ok({ subscriptionId, sequence: 0 as const, snapshot: settings });
  });
  const updateSettings = vi.fn((p: SettingsRequestMap["settings/update"]["params"]) => {
    expect(p.expectedRevision).toBe(settings.revision);
    settings = {
      ...settings,
      revision: "r_" + "1".repeat(32),
      values: settings.values.map((v) => p.changes.find((c) => c.key === v.key) ?? v),
    };
    return ok({
      snapshot: settings,
      receipt: {
        revision: settings.revision!,
        commitId: randomUUID(),
        durability: "file-and-directory-sync" as const,
      },
    });
  });
  host.handle("settings/update", updateSettings);
  await host.request("initialize", {
    apiVersion: "1.8.0",
    pluginId: "kobrixa.device-ev3",
    locale: "en",
    grantedPermissions: [
      "devices.read",
      "devices.connect",
      "devices.control",
      "ui.panels",
      "settings.read",
      "settings.write",
    ],
  });
  await host.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [2] });
  await host.request("ui/ready", {});
  const invoke = (name: string, args: Record<string, string | number | null> = {}) =>
    host.request("command/invoke", {
      version: 1,
      invocationId: randomUUID(),
      command: "kobrixa.device-ev3." + name,
      arguments: args,
      context: {
        origin: "panel",
        locale: "en",
        contextRef: ID,
        binding,
        form: { revision: state.formRevision, values: state.form },
        trigger: { kind: "activate" },
      },
    });
  const event = (kind: "ui.visibility" | "ui.form", visible = true) => {
    for (const [subscriptionId, s] of uiSubs) {
      if (!s.binding) continue;
      host.notify("events/deliver", {
        version: 1,
        owner: principal.owner,
        subscriptionId,
        sequence: ++s.sequence,
        delivery: "control",
        kind,
        ...(kind === "ui.visibility"
          ? { data: { binding, visible } }
          : { data: { binding, revision: state.formRevision, values: state.form } }),
      } as UiEventEnvelopeV2);
    }
  };
  const form = (set: Record<string, string>) => {
    Object.assign(state.form, set);
    state.formRevision++;
    expect(forms.setForm(principal.owner, binding, state.formRevision, state.form, true).ok).toBe(
      true,
    );
    event("ui.form");
  };
  let editSequence = 0;
  const syncInvoke = (name: string, args: Record<string, string | number | null> = {}) => {
    const synced = forms.syncForm(principal.owner, {
      binding,
      baseFormRevision: state.formRevision,
      editSequence: ++editSequence,
      form: structuredClone(state.form),
    });
    if (!synced.ok) throw new Error("Actual generic form sync failed");
    state.formRevision = synced.value.formRevision;
    state.form = synced.value.form;
    // Same ordering as native host: ui.form delivery before command/invoke.
    event("ui.form");
    return invoke(name, args);
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await host.request("shutdown", {}).catch(() => {});
      off();
      await registration.retirement?.retire();
    } finally {
      host.close();
      plugin.close();
      port1.close();
      port2.close();
    }
  };
  cleanups.push(close);
  await vi.waitFor(() => expect(Number(state.data.presentation)).toBeGreaterThan(0));
  return {
    host,
    plugin,
    broker,
    provider: h.provider,
    state,
    rows,
    metadata,
    invoke,
    syncInvoke,
    form,
    event,
    external,
    terminal: () => {
      const affected = [...uiSubs.keys()];
      const subscriptionId = affected[0]!;
      host.notify("events/deliver", {
        version: 1,
        owner: principal.owner,
        subscriptionId,
        sequence: ++uiSubs.get(subscriptionId)!.sequence,
        kind: "events.resyncRequired",
        delivery: "control",
        data: { reason: "overflow", affected },
      });
    },
    close,
    settings: () => settings,
    updateSettings,
    deny: () => {
      authorized = false;
    },
  };
}
it("P03/P06: real SDK→router→broker startup observes only; shutdown releases observations without disconnect", async () => {
  const f = await setup();
  expect(f.provider.calls).toEqual([]);
  expect(f.broker.events.diagnostics().subscriptions).toBe(2);
  expect(f.state.data["session-id"]).toBeNull();
  await f.close();
  expect(f.provider.calls).not.toContain("disconnect");
  expect(f.external.size).toBe(0);
  expect(f.broker.events.diagnostics().subscriptions).toBe(0);
});
it("P01: explicit discovery is the only discovery trigger and filters mock candidates from USB", async () => {
  const f = await setup();
  await f.invoke("discover");
  expect(f.provider.calls.filter((x) => x === "discover")).toHaveLength(1);
  await vi.waitFor(() => expect(f.state.data.discovery).toContain("No devices"), { timeout: 2500 });
  expect(f.rows.get("candidates")).toEqual([]);
  await f.invoke("candidate", { key: ID, version: "0", dataset: 0 });
  expect(f.provider.calls).not.toContain("connect");
});
it("P02: explicit IP address is trimmed and invalid draft preserved without I/O", async () => {
  const f = await setup();
  f.form({ transport: "wifi", "wifi-address": " not-an-ip " });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  expect(f.provider.calls).not.toContain("connect");
  expect(f.state.form["wifi-address"]).toBe(" not-an-ip ");
  f.form({ "wifi-address": " 192.168.1.2 " });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  expect(f.provider.calls).toContain("connect");
  expect(f.settings().values.find((v) => v.key === "lastWifiAddress")?.value).toBe("");
});
it("P03/P08: hide releases only observers, show never discovers/connects", async () => {
  const f = await setup();
  f.state.visible = false;
  f.event("ui.visibility", false);
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(0));
  expect(f.provider.calls).toEqual([]);
  f.state.visible = true;
  f.event("ui.visibility", true);
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(2));
  expect(f.provider.calls).toEqual([]);
});
it("P01/P10: late discovery after hide cannot restore candidate rows", async () => {
  const f = await setup();
  let finish!: () => void;
  const original = f.provider.discover.bind(f.provider);
  vi.spyOn(f.provider, "discover").mockImplementation(async (ctx) => {
    const r = await original(ctx);
    await new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    return r;
  });
  const work = f.invoke("discover");
  await vi.waitFor(() => expect(finish).toBeDefined());
  f.state.visible = false;
  f.event("ui.visibility", false);
  finish();
  await work;
  expect(f.rows.get("candidates")).toEqual([]);
  expect(f.provider.calls).not.toContain("connect");
});

it("P01: exact published candidate key/version/revision connects once; stale replay cannot connect", async () => {
  const f = await setup({ usb: true });
  await f.invoke("discover");
  await vi.waitFor(() => expect(f.rows.get("candidates")?.length).toBe(1), { timeout: 2500 });
  const row = f.rows.get("candidates")![0]!;
  const dataset = f.metadata.get("candidates")!.revision;
  await f.invoke("candidate", { key: row.key, version: row.version, dataset: dataset - 1 });
  expect(f.provider.calls).not.toContain("connect");
  await f.invoke("candidate", { key: row.key, version: row.version, dataset });
  expect(f.provider.calls.filter((x) => x === "connect")).toHaveLength(1);
  await f.invoke("candidate", { key: row.key, version: row.version, dataset });
  expect(f.provider.calls.filter((x) => x === "connect")).toHaveLength(1);
});
it("P02/P11: successful explicit Wi-Fi connection remembers only with the committed opt-in", async () => {
  const f = await setup({ remember: true });
  const connect = vi.spyOn(f.provider, "connect");
  f.form({ transport: "wifi", "wifi-address": " 192.168.1.2 " });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  expect(connect.mock.calls[0]?.[0]).toEqual({ wifiAddress: "192.168.1.2" });
  expect(f.settings().values.find((v) => v.key === "lastWifiAddress")?.value).toBe("192.168.1.2");
});
it("P09/P10: mode rows bind source/session/dataset; authority loss refuses mode writes", async () => {
  const f = await setup({ modes: true });
  const write = vi.spyOn(f.provider, "setInputMode");
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  await vi.waitFor(() => expect(f.state.data["session-id"]).not.toBeNull(), { timeout: 2500 });
  await f.invoke("modes");
  await vi.waitFor(() => expect(f.rows.get("modes")?.length).toBe(1), { timeout: 2500 });
  const row = f.rows.get("modes")![0]!;
  const dataset = f.metadata.get("modes")!.revision;
  await f.invoke("mode", { key: row.key, version: row.version, dataset: dataset - 1 });
  expect(write).not.toHaveBeenCalled();
  f.deny();
  await f.invoke("mode", { key: row.key, version: row.version, dataset });
  expect(write).not.toHaveBeenCalled();
});
it("P11: unavailable committed settings do not guess connection policy or start I/O", async () => {
  const f = await setup();
  f.host.handle("settings/read", () => {
    throw new Error("unavailable");
  });
  await f.invoke("refresh");
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  expect(f.provider.calls).not.toContain("connect");
});

it("P09: fresh exact mode row writes once and source change invalidates its replay", async () => {
  const f = await setup({ modes: true });
  const write = vi.spyOn(f.provider, "setInputMode");
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  await vi.waitFor(() => expect(f.state.data["session-id"]).not.toBeNull(), { timeout: 2500 });
  await f.invoke("modes");
  await vi.waitFor(() => expect(f.rows.get("modes")?.length).toBe(1), { timeout: 2500 });
  const row = f.rows.get("modes")![0]!;
  const dataset = f.metadata.get("modes")!.revision;
  await f.invoke("mode", { key: row.key, version: row.version, dataset });
  expect(write).toHaveBeenCalledOnce();
  await f.invoke("mode", { key: row.key, version: row.version, dataset });
  expect(write).toHaveBeenCalledOnce();
});
it("terminal UI observations release host observers; only explicit Refresh adopts new observers", async () => {
  const f = await setup();
  f.terminal();
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(0));
  await new Promise((r) => setTimeout(r, 1100));
  expect(f.broker.events.diagnostics().subscriptions).toBe(0);
  expect(f.provider.calls).toEqual([]);
  await f.invoke("refresh");
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(2));
  expect(f.provider.calls).toEqual([]);
});

it("P06/P08: hiding a connected view releases its sampler demand without disconnecting the shared session", async () => {
  const f = await setup();
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.invoke("connect");
  await vi.waitFor(() => expect(f.state.data["session-id"]).not.toBeNull(), { timeout: 2500 });
  const sessionId = f.state.data["session-id"];
  f.state.visible = false;
  f.event("ui.visibility", false);
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(0));
  expect(f.provider.calls).not.toContain("disconnect");
  f.state.visible = true;
  f.event("ui.visibility", true);
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(4), {
    timeout: 2500,
  });
  expect(f.state.data["session-id"]).toBe(sessionId);
  expect(f.provider.calls.filter((call) => call === "connect")).toHaveLength(1);
});

it("fix1: transport selection persists without requiring a connection", async () => {
  const f = await setup();
  f.form({ transport: "wifi" });
  await new Promise((r) => setTimeout(r, 30));
  expect(f.settings().values.find((v) => v.key === "connectionMode")?.value).toBe("wifi");
  expect(f.provider.calls).not.toContain("connect");
});
it("fix1: failed connection leaves a settled failure phase", async () => {
  const f = await setup();
  vi.spyOn(f.provider, "connect").mockRejectedValue(new Error("test connection refused"));
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  await new Promise((r) => setTimeout(r, 1100));
  expect(f.state.data.error).not.toBe("");
  expect(f.state.data.discovery).not.toBe("Connecting / 連線中");
});
it("fix1: successful connect with rejected preference CAS keeps connected phase", async () => {
  const f = await setup({ remember: true });
  f.host.handle("settings/update", () => ({
    ok: false,
    error: {
      code: "PLUGIN_E_SETTINGS_CONFLICT",
      message: "Preferences conflict",
      detail: { kind: "settings", reason: "revision-mismatch" },
    },
  }));
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await new Promise((r) => setTimeout(r, 20));
  await f.invoke("connect");
  await new Promise((r) => setTimeout(r, 1100));
  expect(f.state.data.discovery).toBe("Connected / 已連線");
  expect(f.state.data.error).toContain("Connected; preferences were not saved");
  expect(f.provider.calls.filter((x) => x === "connect")).toHaveLength(1);
});

it("fix1: initialization formPatch echo never writes a transport preference", async () => {
  const f = await setup({ initialWifi: true, formPatchEvents: true });
  await new Promise((r) => setTimeout(r, 30));
  expect(f.state.form.transport).toBe("wifi");
  expect(f.updateSettings).not.toHaveBeenCalled();
});
it("fix1: rapid transport choices coalesce while a CAS is pending", async () => {
  const f = await setup();
  let entered = false;
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  f.host.handle("settings/update", async (p) => {
    if (!entered) {
      entered = true;
      await blocked;
    }
    return f.updateSettings(p);
  });
  f.form({ transport: "wifi" });
  await vi.waitFor(() => expect(entered).toBe(true));
  f.form({ transport: "usb" });
  f.form({ transport: "wifi" });
  f.form({ transport: "usb" });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await vi.waitFor(() => {
    expect(f.updateSettings).toHaveBeenCalledTimes(2);
    expect(f.settings().values.find((v) => v.key === "connectionMode")?.value).toBe("usb");
  });
  expect(f.provider.calls).not.toContain("connect");
});
it("fix1: failed transport CAS retains the choice for explicit Refresh without reconnect", async () => {
  const f = await setup();
  f.host.handle("settings/update", () => ({
    ok: false,
    error: {
      code: "PLUGIN_E_SETTINGS_CONFLICT",
      message: "Preferences conflict",
      detail: { kind: "settings", reason: "revision-mismatch" },
    },
  }));
  f.form({ transport: "wifi" });
  await vi.waitFor(() => expect(String(f.state.data.error)).toContain("preference was not saved"), {
    timeout: 2500,
  });
  expect(f.settings().values.find((v) => v.key === "connectionMode")?.value).toBe("usb");
  f.host.handle("settings/update", f.updateSettings);
  await f.invoke("refresh");
  await vi.waitFor(() =>
    expect(f.settings().values.find((v) => v.key === "connectionMode")?.value).toBe("wifi"),
  );
  expect(f.provider.calls).not.toContain("connect");
});

it("fix1: hide fences a pending transport read before any settings publication", async () => {
  const f = await setup();
  let entered = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.host.handle("settings/read", async () => {
    entered = true;
    await blocked;
    return ok(f.settings());
  });
  f.form({ transport: "wifi" });
  await vi.waitFor(() => expect(entered).toBe(true));
  f.state.visible = false;
  f.event("ui.visibility", false);
  await vi.waitFor(() => expect(f.broker.events.diagnostics().subscriptions).toBe(0));
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.updateSettings).not.toHaveBeenCalled();
  expect(f.settings().values.find((v) => v.key === "connectionMode")?.value).toBe("usb");
});

it("E6: actual unchanged form sync before candidate command retains exact row identity", async () => {
  const f = await setup({ usb: true });
  await f.syncInvoke("discover");
  await vi.waitFor(() => expect(f.rows.get("candidates")?.length).toBe(1), { timeout: 2500 });
  const row = f.rows.get("candidates")![0]!;
  const dataset = f.metadata.get("candidates")!.revision;
  const revision = f.state.formRevision;
  await f.syncInvoke("candidate", { key: row.key, version: row.version, dataset });
  expect(f.state.formRevision).toBe(revision + 1);
  expect(f.provider.calls.filter((x) => x === "connect")).toHaveLength(1);
  await f.syncInvoke("candidate", { key: row.key, version: row.version, dataset });
  expect(f.provider.calls.filter((x) => x === "connect")).toHaveLength(1);
});
it("E6: actual unchanged form sync before mode command retains source/row identity", async () => {
  const f = await setup({ modes: true });
  const write = vi.spyOn(f.provider, "setInputMode");
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await f.syncInvoke("connect");
  await vi.waitFor(() => expect(f.state.data["session-id"]).not.toBeNull(), { timeout: 2500 });
  await f.syncInvoke("modes");
  await vi.waitFor(() => expect(f.rows.get("modes")?.length).toBe(1), { timeout: 2500 });
  const row = f.rows.get("modes")![0]!;
  const dataset = f.metadata.get("modes")!.revision;
  await f.syncInvoke("mode", { key: row.key, version: row.version, dataset });
  expect(write).toHaveBeenCalledOnce();
  await f.syncInvoke("mode", { key: row.key, version: row.version, dataset });
  expect(write).toHaveBeenCalledOnce();
});
it.each([{ transport: "wifi" }, { "wifi-address": "192.168.1.2" }])(
  "E6: changed connection draft %j rejects the previously published candidate",
  async (change) => {
    const f = await setup({ usb: true });
    await f.syncInvoke("discover");
    await vi.waitFor(() => expect(f.rows.get("candidates")?.length).toBe(1), { timeout: 2500 });
    const row = f.rows.get("candidates")![0]!;
    const dataset = f.metadata.get("candidates")!.revision;
    f.form(change);
    await f.syncInvoke("candidate", { key: row.key, version: row.version, dataset });
    expect(f.provider.calls).not.toContain("connect");
  },
);
it("E6: changed port invalidates a published mode even after returning to the original port", async () => {
  const f = await setup({ modes: true });
  const write = vi.spyOn(f.provider, "setInputMode");
  f.form({ transport: "wifi", "wifi-address": "192.168.1.2" });
  await f.syncInvoke("connect");
  await vi.waitFor(() => expect(f.state.data["session-id"]).not.toBeNull(), { timeout: 2500 });
  await f.syncInvoke("modes");
  await vi.waitFor(() => expect(f.rows.get("modes")?.length).toBe(1), { timeout: 2500 });
  const row = f.rows.get("modes")![0]!;
  const dataset = f.metadata.get("modes")!.revision;
  f.form({ port: "input:1" });
  f.form({ port: "input:0" });
  await f.syncInvoke("mode", { key: row.key, version: row.version, dataset });
  expect(write).not.toHaveBeenCalled();
});
