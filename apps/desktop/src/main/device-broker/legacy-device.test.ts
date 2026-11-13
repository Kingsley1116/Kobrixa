import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { DeviceBrokerPort } from "./broker-port.js";
import type { Principal } from "@kobrixa/plugin-runtime";
import { LegacyDevice, monitorProjection } from "./legacy-device.js";
it("F14 core principal comes from host binding; foreign native descriptors never connect", async () => {
  const request = vi.fn(
    async (_principal: Principal, _method: string, _params: unknown, _signal: AbortSignal) => ({
      ok: true,
      value: { candidates: [] },
    }),
  );
  const principal: Principal = {
    kind: "core",
    adapter: "monitor",
    hostEpoch: randomUUID(),
    workbenchInstance: randomUUID(),
    authorityContext: null,
  };
  const legacy = new LegacyDevice({
    broker: { request } as unknown as DeviceBrokerPort,
    principal: () => principal,
    disconnect: async () => {},
    stop: async () => {},
    feed: { subscribe: async () => async () => {} },
  });
  expect(await legacy.discover()).toEqual([]);
  await expect(
    legacy.connect({
      id: "forged",
      name: "EV3",
      transport: "usb",
      metadata: { path: "/dev/forged" },
    }),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe(principal);
});
it("F07 absent/busy frames never manufacture fresh values", () => {
  expect(
    monitorProjection(
      { sessionId: "s", sourceRevision: 1, channels: [], actuators: [] },
      {
        sequence: 1,
        sampledAt: 10,
        elapsedMs: 1,
        sourceRevision: 1,
        status: "busy",
        values: [],
        program: "unknown",
      },
    ).program.status,
  ).toBe("unknown");
});
import { createLegacyMonitorFeed } from "./legacy-device.js";
import type { CorePrincipal, CoreTelemetrySubscription } from "./broker-port.js";
import type { ReadSnapshot, SourceCatalog } from "@kobrixa/plugin-protocol";
function feedFixture() {
  const principal: CorePrincipal = {
    kind: "core",
    adapter: "monitor",
    hostEpoch: randomUUID(),
    workbenchInstance: randomUUID(),
    authorityContext: null,
  };
  const snapshot: ReadSnapshot = {
    sessionId: "s",
    revision: 0,
    status: "busy",
    ageMs: null,
    frame: null,
  };
  const sources: SourceCatalog = { sessionId: "s", sourceRevision: 1, channels: [], actuators: [] };
  const trace: string[] = [];
  const demands: Array<{
    input: Parameters<DeviceBrokerPort["subscribeCoreTelemetry"]>[0];
    subscription: CoreTelemetrySubscription;
  }> = [];
  const broker = {
    request: vi.fn(async () => ({ ok: true, value: { sources } })),
    subscribeCoreTelemetry: vi.fn(
      async (input: Parameters<DeviceBrokerPort["subscribeCoreTelemetry"]>[0]) => {
        const index = demands.length;
        const subscription: CoreTelemetrySubscription = {
          initial: { snapshot, sources },
          activate: () => {
            trace.push(`activate:${index}`);
          },
          ack: (sequence) => {
            trace.push(`ack:${index}:${sequence}`);
          },
          dispose: vi.fn(async () => {
            trace.push(`dispose:${index}`);
          }),
        };
        demands.push({ input, subscription });
        return subscription;
      },
    ),
  } as unknown as DeviceBrokerPort;
  return {
    principal,
    snapshot,
    sources,
    trace,
    demands,
    broker,
    feed: createLegacyMonitorFeed(broker),
  };
}
it("AM-07 initial delivery precedes activation; ACK precedes consumer callback", async () => {
  const f = feedFixture();
  const dispose = await f.feed.subscribe({
    principal: f.principal,
    sessionId: "s",
    intervalMs: 500,
    receive(snapshot) {
      f.trace.push(`receive:${snapshot.revision}`);
    },
  });
  expect(f.trace).toEqual(["receive:0", "activate:0"]);
  f.demands[0]!.input.receive({
    sequence: 1,
    snapshot: { ...f.snapshot, revision: 1 },
    sources: f.sources,
  });
  expect(f.trace.at(-1)).toBe("ack:0:1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.trace.at(-1)).toBe("receive:1");
  await dispose();
  await dispose();
  expect(f.demands[0]!.subscription.dispose).toHaveBeenCalledOnce();
});
it("AM-07 throwing monitor removes only its demand while battery and Lab remain", async () => {
  const f = feedFixture();
  for (const adapter of ["battery", "monitor", "lab"] as const)
    await f.feed.subscribe({
      principal: { ...f.principal, adapter },
      sessionId: "s",
      intervalMs: adapter === "battery" ? 30000 : 500,
      receive(snapshot) {
        if (adapter === "monitor" && snapshot.revision) throw new Error("consumer");
      },
    });
  for (const demand of f.demands)
    demand.input.receive({
      sequence: 1,
      snapshot: { ...f.snapshot, revision: 1 },
      sources: f.sources,
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.demands[0]!.subscription.dispose).not.toHaveBeenCalled();
  expect(f.demands[1]!.subscription.dispose).toHaveBeenCalledOnce();
  expect(f.demands[2]!.subscription.dispose).not.toHaveBeenCalled();
});
it("AM-07 bounded enqueue overflow never ACKs rejected data", async () => {
  const f = feedFixture();
  await f.feed.subscribe({ principal: f.principal, sessionId: "s", intervalMs: 500, receive() {} });
  for (let sequence = 1; sequence <= 65; sequence++)
    f.demands[0]!.input.receive({ sequence, snapshot: f.snapshot, sources: f.sources });
  expect(f.trace).toContain("ack:0:64");
  expect(f.trace).not.toContain("ack:0:65");
  expect(f.demands[0]!.subscription.dispose).toHaveBeenCalledOnce();
});
it("AM-08 uses the host serial-match reconnect seam and never replays legacy mutations", async () => {
  const principal: Principal = {
    kind: "core",
    adapter: "recovery",
    hostEpoch: randomUUID(),
    workbenchInstance: randomUUID(),
    authorityContext: null,
  };
  const reconnectForRecovery = vi.fn(async () => ({ ok: true, value: { sessionId: "fresh" } }));
  const request = vi.fn(async () => ({
    ok: true,
    value: { session: { sessionId: "fresh", name: "Brick", transport: "usb" } },
  }));
  const legacyCall = vi.fn();
  const broker = {
    reconnectForRecovery,
    request,
    legacy: legacyCall,
  } as unknown as DeviceBrokerPort;
  const legacy = new LegacyDevice({
    broker,
    principal: () => principal,
    stop: async () => {},
    disconnect: async () => {},
    feed: createLegacyMonitorFeed(broker),
  });
  const signal = new AbortController().signal;
  expect(await legacy.reconnectForRecovery("previous", signal)).toBe("fresh");
  expect(reconnectForRecovery).toHaveBeenCalledWith({ previousSessionId: "previous", signal });
  expect(request).toHaveBeenCalledWith(
    principal,
    "devices/session",
    { sessionId: "fresh" },
    signal,
  );
  expect(legacy.descriptor("fresh").transport).toBe("usb");
  expect(() => legacy.descriptor("previous")).toThrow();
  expect(legacyCall).not.toHaveBeenCalled();
  reconnectForRecovery.mockResolvedValueOnce({
    ok: false,
    error: { message: "identity-ambiguous" },
  } as never);
  await expect(legacy.reconnectForRecovery("previous", signal)).rejects.toThrow(
    "identity-ambiguous",
  );
  expect(request).toHaveBeenCalledOnce();
  expect(legacyCall).not.toHaveBeenCalled();
});

it("T5fix source revision changes replace channel demand inside the original disposer", async () => {
  const f = feedFixture();
  const receive = vi.fn();
  const dispose = await f.feed.subscribe({
    principal: f.principal,
    sessionId: "s",
    intervalMs: 500,
    receive,
  });
  const sources: SourceCatalog = {
    ...f.sources,
    sourceRevision: 2,
    channels: [
      {
        channelId: "new",
        kind: "input",
        portId: "input:0",
        typeId: "ev3:29",
        modeId: "mode:1",
        component: 0,
        name: "Light",
        modeName: "Ambient",
        unit: "%",
        decimals: 0,
        state: "ready",
      },
    ],
  };
  f.demands[0]!.input.receive({ sequence: 1, snapshot: f.snapshot, sources });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.demands).toHaveLength(2);
  expect(f.demands[1]!.input.channelIds).toEqual(["new"]);
  const frame = {
    sequence: 2,
    sampledAt: 2,
    elapsedMs: 2,
    sourceRevision: 2,
    status: "ok" as const,
    program: "stopped" as const,
    values: [{ channelId: "new", value: 73 }],
  };
  f.demands[1]!.input.receive({
    sequence: 1,
    snapshot: { ...f.snapshot, revision: 2, status: "fresh", frame, ageMs: 0 },
    sources,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const [snapshot, catalog] = receive.mock.calls.at(-1)!;
  expect(monitorProjection(catalog, snapshot.frame).inputs[0]!.values).toEqual([73]);
  await dispose();
  expect(f.demands.map((d) => vi.mocked(d.subscription.dispose).mock.calls.length)).toEqual([1, 1]);
});
it.each(["overflow", "consumer-error", "invalid-sequence"])(
  "T5fix %s reports closure exactly once; caller disposal is silent",
  async (reason) => {
    const f = feedFixture();
    const onClosed = vi.fn();
    const dispose = await f.feed.subscribe({
      principal: f.principal,
      sessionId: "s",
      intervalMs: 500,
      onClosed,
      receive(snapshot) {
        if (reason === "consumer-error" && snapshot.revision) throw new Error("consumer");
      },
    });
    for (let sequence = 1; sequence <= (reason === "overflow" ? 65 : 1); sequence++)
      f.demands[0]!.input.receive({
        sequence: reason === "invalid-sequence" ? 0 : sequence,
        snapshot: { ...f.snapshot, revision: 1 },
        sources: f.sources,
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(reason);
    await dispose();
    expect(onClosed).toHaveBeenCalledOnce();
    const callerClosed = vi.fn();
    const remove = await f.feed.subscribe({
      principal: f.principal,
      sessionId: "s",
      intervalMs: 500,
      onClosed: callerClosed,
      receive() {},
    });
    await remove();
    expect(callerClosed).not.toHaveBeenCalled();
  },
);

import { MonitorService } from "../device/monitor-service.js";
import { LegacyLab } from "./legacy-lab.js";
it.each(["overflow", "throwing-consumer"])(
  "T5fix real feed %s lets Monitor restart",
  async (reason) => {
    const f = feedFixture();
    const device = new LegacyDevice({
      broker: f.broker,
      principal: () => f.principal,
      disconnect: async () => {},
      stop: async () => {},
      feed: f.feed,
    });
    const publish = vi.fn();
    const service = new MonitorService(device, publish);
    await service.watch("s", true, 7);
    if (reason === "throwing-consumer")
      publish.mockImplementationOnce(() => {
        throw new Error("renderer failed");
      });
    for (let sequence = 1; sequence <= (reason === "overflow" ? 65 : 1); sequence++)
      f.demands[0]!.input.receive({ sequence, snapshot: f.snapshot, sources: f.sources });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.latest("s")?.status).toBe("paused");
    await service.watch("s", true, 7);
    expect(f.demands).toHaveLength(2);
    await service.dispose();
  },
);
it("T5fix real feed overflow pauses Lab for the recorder's disconnected auto-stop", async () => {
  const f = feedFixture();
  const device = new LegacyDevice({
    broker: f.broker,
    principal: () => ({ ...f.principal, adapter: "lab" }),
    disconnect: async () => {},
    stop: async () => {},
    feed: f.feed,
  });
  vi.spyOn(device, "request").mockImplementation(async (method) => {
    if (method === "devices/session") return { sources: f.sources } as never;
    if (method === "devices/recording/reserve")
      return {
        reservation: { reservationId: "r", channels: [] },
        firstFrame: {
          sequence: 1,
          sampledAt: 1,
          elapsedMs: 0,
          sourceRevision: 1,
          status: "ok",
          program: "stopped",
          values: [],
        },
      } as never;
    return {
      reservation: { lastSequence: 1 },
      frames: [],
      hasMore: false,
      gap: null,
      nextSequence: 1,
    } as never;
  });
  const lab = new LegacyLab(device, () => {});
  await lab.acquire("s", []);
  for (let sequence = 1; sequence <= 65; sequence++)
    f.demands[0]!.input.receive({ sequence, snapshot: f.snapshot, sources: f.sources });
  expect(lab.latest("s")?.status).toBe("paused");
  await lab.release("s");
  expect(f.demands[0]!.subscription.dispose).toHaveBeenCalledOnce();
});
