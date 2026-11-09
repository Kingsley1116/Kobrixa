import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryChannelPair,
  RpcPeer,
  type UiRequestMapV2,
  type UiEventEnvelopeV2,
} from "@kobrixa/plugin-protocol";
import { runPlugin, type PluginContext } from "./index.js";
import { bindEventChannel } from "./events.js";
import * as commonEvents from "./events.js";
import { UiClient } from "./ui.js";

const id = "00000000-0000-4000-8000-000000000001";
const owner = {
  sourceKey: "builtin:test.lab",
  pluginId: "test.lab",
  generation: 1,
  processEpoch: id,
  hostEpoch: id,
};
const binding = {
  contributionId: "test.lab.panel",
  kind: "panel" as const,
  panelInstance: id,
  generation: 1,
  uiResourceGeneration: 1,
  processEpoch: id,
  hostEpoch: id,
};
const offer: UiRequestMapV2["ui/negotiate"]["params"] = {
  commandEnvelopeVersions: [1],
  uiResourceVersions: [2],
};
const subscription = (): UiRequestMapV2["ui/subscribe"]["result"] => ({
  ok: true,
  value: {
    subscriptionId: id,
    sequence: 0,
    snapshot: {
      instances: [],
      states: [],
      locale: "en",
      theme: "light",
      data: [{ binding, datasets: [] }],
    },
  },
});
const event = (eventOwner = owner): UiEventEnvelopeV2 => ({
  version: 1,
  owner: eventOwner,
  subscriptionId: id,
  sequence: 1,
  delivery: "telemetry",
  kind: "ui.data",
  data: { binding, dataset: "code", revision: 1, presentation: 1 },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const peers: RpcPeer[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) peer.close();
  vi.restoreAllMocks();
});

async function connect(afterHostSend: (text: string) => void = () => {}) {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer({
    onMessage: a.onMessage.bind(a),
    send(text) {
      a.send(text);
      afterHostSend(text);
    },
  });
  let context!: PluginContext;
  const plugin = await runPlugin(
    {
      activate(ctx) {
        context = ctx;
      },
    },
    { channel: b, exit: vi.fn() },
  );
  peers.push(host, plugin);
  bindEventChannel(plugin, owner);
  await host.request("initialize", {
    apiVersion: "1.8.0",
    pluginId: "test.lab",
    locale: "en",
    grantedPermissions: [],
  });
  await host.request("ui/negotiate", offer);
  await host.request("ui/ready", {});
  host.handle("events/ack", ({ sequence }) => ({
    ok: true as const,
    value: { acknowledged: sequence },
  }));
  return { host, plugin, context };
}

it.each([
  ["delayed", "ui/negotiate"],
  ["delayed", "shutdown"],
  ["resolved", "ui/negotiate"],
  ["resolved", "shutdown"],
] as const)("rejects %s subscription across %s before adoption", async (timing, transition) => {
  let retire: Promise<unknown> | undefined;
  let armed = false;
  const { host, plugin, context } = await connect((text) => {
    if (armed && JSON.parse(text).result?.value?.subscriptionId) {
      armed = false;
      // Queue retirement immediately behind the reply, before subscribe's
      // awaiting continuation. RpcPeer accepts this reply in the old epoch.
      retire = stop();
    }
  });
  const stop = () =>
    transition === "shutdown" ? host.request("shutdown", {}) : host.request("ui/negotiate", offer);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.handle("ui/subscribe", async () => {
    await gate;
    return subscription();
  });
  const listener = vi.fn();
  const oldEpoch = plugin.uiSessionEpoch;
  const pending = context.ui.subscribe({ topics: ["data"], binding }, listener);
  const rejected = expect(pending).rejects.toThrow(/retired|cancelled/);
  await tick();
  if (timing === "delayed") await stop();
  else armed = true;
  release();
  await rejected;
  await retire;
  expect(plugin.uiSessionEpoch).toBeGreaterThan(oldEpoch);
  // Re-ready must not make the old listener live. A fresh subscription still works.
  await host.request("ui/negotiate", offer);
  await host.request("ui/ready", {});
  host.notify("events/deliver", event());
  await tick();
  expect(listener).not.toHaveBeenCalled();
  const current = vi.fn();
  await context.ui.subscribe({ topics: ["data"], binding }, current);
  host.notify("events/deliver", event());
  await tick();
  expect(current).toHaveBeenCalledTimes(1);
  expect(listener).not.toHaveBeenCalled();
});

it("rejects a retired/re-ready facade even when its request returns successfully", async () => {
  const finish = vi.fn();
  vi.spyOn(commonEvents, "beginUiSubscription").mockReturnValue(finish);
  const adopt = vi.fn();
  const request = vi.fn(async () => {
    ui.retire();
    ui.markReady();
    return subscription();
  });
  const ui = new UiClient(request as never, { adopt, forget: vi.fn() });
  ui.markReady();
  await expect(ui.subscribe({ topics: ["data"], binding }, vi.fn())).rejects.toThrow("retired");
  expect(adopt).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledTimes(1);
});

it("keeps exact original-owner event admission for a current subscription", async () => {
  const { host, context } = await connect();
  host.handle("ui/subscribe", subscription);
  const listener = vi.fn();
  await context.ui.subscribe({ topics: ["data"], binding }, listener);
  host.notify("events/deliver", event({ ...owner, generation: 2 }));
  await tick();
  expect(listener).not.toHaveBeenCalled();
  host.notify("events/deliver", event());
  await tick();
  expect(listener).toHaveBeenCalledTimes(1);
});
