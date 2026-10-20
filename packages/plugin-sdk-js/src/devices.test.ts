import { expect, it, vi } from "vitest";
import { RpcPeer, type MessageChannelLike } from "@kobrixa/plugin-protocol";
import { createDevicesClient } from "./devices.js";
it("F16 initialize remains usable and start timeout never replays", async () => {
  vi.useFakeTimers();
  let receive: (text: string) => void = () => {};
  const sent: Array<{ id?: number; method: string }> = [];
  const channel: MessageChannelLike = {
    send(text) {
      const m = JSON.parse(text);
      sent.push(m);
      if (m.method === "devices/negotiate")
        queueMicrotask(() =>
          receive(
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              result: {
                ok: true,
                value: {
                  devicesContractVersion: 1,
                  eventVersion: 1,
                  capabilities: [],
                  requirementsSatisfied: true,
                },
              },
            }),
          ),
        );
    },
    onMessage(fn) {
      receive = fn;
      return () => {};
    },
  };
  const peer = new RpcPeer(channel);
  let ready!: (v: string) => void;
  const initialized = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const devices = createDevicesClient(peer, initialized);
  expect((await devices.list({})).ok).toBe(false);
  expect(sent).toHaveLength(0);
  ready("1.5.0");
  await Promise.resolve();
  const call = devices.motion.start({ operationId: "00000000-0000-4000-8000-000000000001" });
  const rejected = expect(call).rejects.toMatchObject({ code: -32001 });
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(sent.filter((m) => m.method === "devices/motion/start")).toHaveLength(1);
  expect(sent.some((m) => m.method === "$/cancelRequest")).toBe(true);
  peer.close();
  vi.useRealTimers();
});
