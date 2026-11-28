import { afterEach, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer, type UiEventEnvelopeV2 } from "@kobrixa/plugin-protocol";
import { runPlugin, type PluginContext } from "./index.js";
import { bindEventChannel } from "./events.js";
const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  contributionId: "test.lab.panel",
  kind: "panel" as const,
  panelInstance: id,
  generation: 1,
  uiResourceGeneration: 1,
  processEpoch: id,
  hostEpoch: id,
};
const owner = {
  sourceKey: "builtin:test.lab",
  pluginId: "test.lab",
  generation: 1,
  processEpoch: id,
  hostEpoch: id,
};
const peers: RpcPeer[] = [];
afterEach(() => {
  for (const p of peers.splice(0)) p.close();
});
async function connect(version = "1.8.0", ready?: (context: PluginContext) => Promise<void>) {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a);
  peers.push(host);
  let context!: PluginContext;
  const plugin = await runPlugin(
    {
      activate: (ctx) => {
        context = ctx;
      },
      ...(ready ? { ready } : {}),
    },
    { channel: b, exit: vi.fn() },
  );
  peers.push(plugin);
  await host.request("initialize", {
    apiVersion: version,
    pluginId: "test.lab",
    locale: "en",
    grantedPermissions: [],
  });
  return { host, plugin, context };
}
it.each(["1.6.0", "1.7.0"])("keeps %s sessions v1 and data denied", async (version) => {
  const { host, context } = await connect(version);
  const result = await host.request("ui/negotiate", {
    commandEnvelopeVersions: [1],
    uiResourceVersions: [1, 2],
  });
  expect(result).toEqual({
    ok: true,
    value: { commandEnvelopeVersions: [1], uiResourceVersions: [1] },
  });
  await host.request("ui/ready", {});
  await expect(context.ui.data.snapshot(binding)).rejects.toThrow("not ready");
});
it.each([[], [1], [2], [1, 2]].map((v) => [v]))(
  "intersects candidate offer %j and attaches data only for ready v2",
  async (versions) => {
    const { host, context } = await connect();
    const offer = versions as [] | [1] | [2] | [1, 2];
    const result = await host.request("ui/negotiate", {
      commandEnvelopeVersions: [1],
      uiResourceVersions: offer,
    });
    expect(result).toEqual({
      ok: true,
      value: { commandEnvelopeVersions: offer.length ? [1] : [], uiResourceVersions: offer },
    });
    await expect(context.ui.data.snapshot(binding)).rejects.toThrow("not ready");
    const called = vi.fn(() => ({ ok: true as const, value: { datasets: [] } }));
    host.handle("ui/dataSnapshot", called);
    await host.request("ui/ready", {});
    if (versions!.includes(2)) {
      await expect(context.ui.data.snapshot(binding)).resolves.toEqual({
        ok: true,
        value: { datasets: [] },
      });
      expect(called).toHaveBeenCalledTimes(1);
    } else await expect(context.ui.data.snapshot(binding)).rejects.toThrow("not ready");
    await host.request("shutdown", {});
    await expect(context.ui.data.snapshot(binding)).rejects.toThrow("not ready");
  },
);
it("admits data during the ready callback and retires on failed readiness", async () => {
  const { host, context } = await connect("1.8.0", async (ctx) => {
    await ctx.ui.data.snapshot(binding);
    throw new Error("ready failed");
  });
  const called = vi.fn(() => ({ ok: true as const, value: { datasets: [] } }));
  host.handle("ui/dataSnapshot", called);
  await host.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [2] });
  await host.request("ui/ready", {}).catch(() => {});
  expect(called).toHaveBeenCalledTimes(1);
  await expect(context.ui.data.snapshot(binding)).rejects.toThrow("not ready");
});
it("delivers ui.data through the existing subscription inbox with metadata snapshots", async () => {
  const { host, plugin, context } = await connect();
  bindEventChannel(plugin, owner);
  await host.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [2] });
  await host.request("ui/ready", {});
  host.handle("ui/subscribe", () => ({
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
  }));
  host.handle("events/ack", ({ sequence }) => ({
    ok: true as const,
    value: { acknowledged: sequence },
  }));
  const events: UiEventEnvelopeV2[] = [];
  const subscribed = await context.ui.subscribe({ topics: ["data"], binding }, (event) => {
    events.push(event);
  });
  expect(subscribed.ok).toBe(true);
  host.notify("events/deliver", {
    version: 1,
    owner,
    subscriptionId: id,
    sequence: 1,
    delivery: "telemetry",
    kind: "ui.data",
    data: { binding, dataset: "code", revision: 1, presentation: 1 },
  });
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]?.kind).toBe("ui.data");
  await host.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [2] });
  await host.request("ui/ready", {});
  host.notify("events/deliver", {
    version: 1,
    owner,
    subscriptionId: id,
    sequence: 2,
    delivery: "telemetry",
    kind: "ui.data",
    data: { binding, dataset: "code", revision: 2, presentation: 2 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(events).toHaveLength(1);
});
