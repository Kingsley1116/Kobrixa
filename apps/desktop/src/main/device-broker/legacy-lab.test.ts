import { expect, it, vi } from "vitest";
import type { LegacyDevice, LegacyMonitorFeed } from "./legacy-device.js";
import { LegacyLab } from "./legacy-lab.js";
it("F12/F19 pins selected channels, publishes first frame and releases the original reservation once", async () => {
  const channel = {
    channelId: "c",
    kind: "input",
    portId: "input:0",
    typeId: "ev3:29",
    modeId: "mode:0",
    component: 0,
    name: "Touch",
    modeName: "Touch",
    unit: "raw",
    decimals: 0,
    state: "ready",
  };
  const frame = {
    sequence: 1,
    sampledAt: 1,
    elapsedMs: 0,
    sourceRevision: 1,
    status: "ok",
    program: "stopped",
    values: [{ channelId: "c", value: 1 }],
  };
  const request = vi.fn(async (method: string) => {
    if (method === "devices/session")
      return { sources: { sessionId: "s", sourceRevision: 1, channels: [channel], actuators: [] } };
    if (method === "devices/recording/reserve")
      return {
        reservation: { reservationId: "r", sessionId: "s", channels: [channel] },
        firstFrame: frame,
      };
    if (method === "devices/recording/release")
      return { reservation: { reservationId: "r", lastSequence: 1 } };
    if (method === "devices/recording/read")
      return { frames: [], gap: null, nextSequence: 1, hasMore: false };
    throw new Error(method);
  });
  const remove = vi.fn(async () => {}),
    publish = vi.fn();
  const lab = new LegacyLab(
    {
      request,
      watch: async () => remove,
      descriptor: () => ({ id: "s", name: "EV3", transport: "usb" }),
    } as unknown as LegacyDevice,
    publish,
  );
  await lab.acquire("s", [
    {
      id: "old",
      kind: "input",
      port: 0,
      type: 29,
      mode: 0,
      channel: 0,
      name: "Touch",
      modeName: "Touch",
      unit: "raw",
      decimals: 0,
    },
  ]);
  expect(request).toHaveBeenCalledWith("devices/recording/reserve", {
    sessionId: "s",
    channelIds: ["c"],
    expectedSourceRevision: 1,
  });
  expect(publish).toHaveBeenCalledOnce();
  await lab.release("s");
  await lab.release("s");
  expect(
    request.mock.calls.filter(([method]) => method === "devices/recording/release"),
  ).toHaveLength(1);
  expect(remove).toHaveBeenCalledOnce();
});
it.each(["coalesced", "overflow", "unavailable"])(
  "F12/F19 consumes original ring evidence on %s without a second sampling timer",
  async (kind) => {
    const channel = {
      channelId: "c",
      kind: "input" as const,
      portId: "input:0",
      typeId: "ev3:29",
      modeId: "mode:0",
      component: 0,
      name: "Touch",
      modeName: "Touch",
      unit: "raw",
      decimals: 0,
      state: "ready" as const,
    };
    const sources = { sessionId: "s", sourceRevision: 1, channels: [channel], actuators: [] };
    const frame = (sequence: number) => ({
      sequence,
      sampledAt: sequence * 500,
      elapsedMs: sequence * 500,
      sourceRevision: 1,
      status: "ok" as const,
      program: "stopped" as const,
      values: [{ channelId: "c", value: sequence }],
    });
    const lastSequence = kind === "unavailable" ? 1 : kind === "overflow" ? 4 : 3;
    let receive!: Parameters<LegacyMonitorFeed["subscribe"]>[0]["receive"];
    const request = vi.fn(async (method: string) => {
      if (method === "devices/session") return { sources };
      if (method === "devices/recording/reserve")
        return { reservation: { reservationId: "r", channels: [channel] }, firstFrame: frame(1) };
      if (method === "devices/recording/release")
        return { reservation: { reservationId: "r", lastSequence } };
      if (method === "devices/recording/read")
        return {
          reservation: { reservationId: "r", lastSequence },
          frames: kind === "overflow" ? [frame(4)] : [frame(2), frame(3)],
          gap: kind === "overflow" ? { fromSequence: 2, toSequence: 3, reason: "overflow" } : null,
          nextSequence: lastSequence,
          hasMore: false,
        };
      throw new Error(method);
    });
    const publish = vi.fn(),
      remove = vi.fn(async () => {});
    const lab = new LegacyLab(
      {
        request,
        watch: async (_id: string, _interval: number, listener: typeof receive) => {
          receive = listener;
          return remove;
        },
        descriptor: () => ({ id: "s", name: "EV3", transport: "usb" }),
      } as unknown as LegacyDevice,
      publish,
    );
    await lab.acquire("s", [
      {
        id: "old",
        kind: "input",
        port: 0,
        type: 29,
        mode: 0,
        channel: 0,
        name: "Touch",
        modeName: "Touch",
        unit: "raw",
        decimals: 0,
      },
    ]);
    receive(
      {
        sessionId: "s",
        revision: 2,
        status: kind === "unavailable" ? "unavailable" : "fresh",
        ageMs: 0,
        frame: kind === "unavailable" ? null : frame(lastSequence),
      },
      sources,
    );
    await lab.release("s");
    const updates = publish.mock.calls.map(([update]) => update);
    expect(updates.map((value) => value.status)).toEqual(
      kind === "unavailable"
        ? ["live", "paused"]
        : kind === "overflow"
          ? ["live", "waiting", "live"]
          : ["live", "live", "live"],
    );
    if (kind !== "unavailable")
      expect(request).toHaveBeenCalledWith("devices/recording/read", {
        reservationId: "r",
        afterSequence: 1,
        limit: 64,
      });
    expect(remove).toHaveBeenCalledOnce();
  },
);
