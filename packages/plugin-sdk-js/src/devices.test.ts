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

it.each(["business", "rpc", "timeout"])(
  "retries %s negotiation failures and shares concurrent attempts",
  async (failure) => {
    vi.useFakeTimers();
    let receive: (text: string) => void = () => {};
    const negotiations: number[] = [];
    let listCalls = 0;
    const success = {
      ok: true,
      value: {
        devicesContractVersion: 1,
        eventVersion: 1,
        capabilities: [],
        requirementsSatisfied: true,
      },
    };
    const denied = {
      ok: false,
      error: {
        code: "PLUGIN_E_DEVICE_UNAVAILABLE",
        message: "Unavailable",
        detail: {
          kind: "device",
          reason: "provider-disabled",
          dispatch: "not-sent",
          stopConfirmation: "not-required",
        },
      },
    };
    const channel: MessageChannelLike = {
      send(text) {
        const message = JSON.parse(text);
        if (message.method === "devices/negotiate") negotiations.push(message.id);
        if (message.method === "devices/list") {
          listCalls++;
          queueMicrotask(() =>
            receive(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { ok: true, value: { revision: 0, providers: [], sessions: [] } },
              }),
            ),
          );
        }
      },
      onMessage(listener) {
        receive = listener;
        return () => {};
      },
    };
    const peer = new RpcPeer(channel);
    try {
      const devices = createDevicesClient(peer, Promise.resolve("1.5.0"));
      await Promise.resolve();
      const first = Promise.allSettled([devices.list({}), devices.list({})]);
      expect(negotiations).toHaveLength(1);
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(5000);
      else
        receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id: negotiations[0],
            ...(failure === "business"
              ? { result: denied }
              : { error: { code: -32603, message: "Failed" } }),
          }),
        );
      const failed = await first;
      for (const result of failed) {
        if (failure === "business") expect(result).toEqual({ status: "fulfilled", value: denied });
        else
          expect(result).toMatchObject({
            status: "rejected",
            reason: { code: failure === "timeout" ? -32001 : -32603 },
          });
      }
      expect(listCalls).toBe(0);
      const retry = Promise.allSettled([devices.list({}), devices.list({})]);
      // Attach handlers before asserting so a regression cannot leak rejected promises.
      expect(negotiations).toHaveLength(2);
      receive(JSON.stringify({ jsonrpc: "2.0", id: negotiations[1], result: success }));
      for (const result of await retry)
        expect(result).toMatchObject({ status: "fulfilled", value: { ok: true } });
      expect((await devices.list({})).ok).toBe(true);
      expect(negotiations).toHaveLength(2);
      expect(listCalls).toBe(3);
    } finally {
      peer.close();
      vi.useRealTimers();
    }
  },
);
