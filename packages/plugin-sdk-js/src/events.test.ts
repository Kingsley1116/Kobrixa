import { expect, it, vi } from "vitest";
import { EventInbox } from "./events.js";
import type { DeviceEvent } from "@kobrixa/plugin-protocol";
const id = "00000000-0000-4000-8000-000000000001";
const owner = {
  sourceKey: "builtin:acme.test",
  pluginId: "acme.test",
  generation: 1,
  hostEpoch: id,
  processEpoch: id,
};
const event = (sequence: number): DeviceEvent => ({
  version: 1,
  subscriptionId: id,
  owner,
  sequence,
  delivery: "control",
  kind: "events.resyncRequired",
  data: { reason: "overflow", affected: [id] },
});
it("F13 ACK follows enqueue and precedes a hung callback; rejected data is not ACKed", async () => {
  const ack = vi.fn(async () => {}),
    callback = vi.fn(() => new Promise<void>(() => {}));
  const inbox = new EventInbox(ack, owner);
  inbox.enable();
  inbox.open(id, callback, async () => {});
  expect(inbox.accept(event(1))).toBe(true);
  expect(ack).toHaveBeenCalledWith(id, 1);
  expect(inbox.accept(event(1))).toBe(false);
  expect(
    inbox.accept({
      ...event(2),
      owner: { ...owner, processEpoch: "00000000-0000-4000-8000-000000000002" },
    }),
  ).toBe(false);
  for (let i = 2; i <= 8; i++) inbox.accept(event(i));
  expect(inbox.accept(event(9))).toBe(false);
  expect(ack).toHaveBeenCalledTimes(8);
  await Promise.resolve();
  await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
});
it("F13 no events before negotiation; pre-await reply race remains bounded", () => {
  const ack = vi.fn(async () => {}),
    inbox = new EventInbox(ack, owner);
  expect(inbox.accept(event(1))).toBe(false);
  inbox.enable();
  const finish = inbox.beginSubscription();
  expect(inbox.accept(event(1))).toBe(true);
  expect(ack).not.toHaveBeenCalled();
  inbox.open(
    id,
    () => {},
    async () => {},
  );
  finish();
  expect(ack).toHaveBeenCalledWith(id, 1);
});
import { RpcPeer } from "@kobrixa/plugin-protocol";
import { bindEventChannel, eventInbox } from "./events.js";
it("the first event must match trusted launch metadata and binding is one-shot", () => {
  const ack = vi.fn(async () => {}),
    inbox = new EventInbox(ack, owner);
  inbox.enable();
  inbox.open(
    id,
    () => {},
    async () => {},
  );
  expect(inbox.accept({ ...event(1), owner: { ...owner, generation: 2 } })).toBe(false);
  expect(ack).not.toHaveBeenCalled();
  expect(inbox.accept(event(1))).toBe(true);
  const peer = new RpcPeer({
    send() {},
    onMessage() {
      return () => {};
    },
  });
  bindEventChannel(peer, owner);
  expect(eventInbox(peer)).toBe(eventInbox(peer));
  expect(() => bindEventChannel(peer, owner)).toThrow();
  peer.close();
  expect(() => bindEventChannel(peer, { ...owner, generation: 2 })).toThrow();
});
it("normalizes and copies trusted owner metadata", () => {
  const trusted = {
    processEpoch: id,
    hostEpoch: id,
    generation: 1,
    pluginId: "acme.test",
    sourceKey: "builtin:acme.test",
  };
  const inbox = new EventInbox(async () => {}, trusted);
  trusted.generation = 2;
  inbox.enable();
  inbox.open(
    id,
    () => {},
    async () => {},
  );
  expect(inbox.accept(event(1))).toBe(true);
});

it("UI gap snapshot reconciles enqueues against the exact watermark", async () => {
  const calls: number[] = [];
  const ack: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inbox = new EventInbox(async (_id, sequence) => {
    ack.push(sequence);
  }, owner);
  inbox.enable();
  const id = "00000000-0000-4000-8000-000000000090";
  inbox.open(
    id,
    (event) => {
      calls.push(event.sequence);
    },
    async () => {
      await barrier;
      inbox.reconcile(id, 3);
    },
  );
  const event = (sequence: number) => ({
    version: 1,
    owner,
    subscriptionId: id,
    sequence,
    delivery: "control",
    kind: "ui.environment",
    data: { locale: "en", theme: "dark" },
  });
  expect(inbox.accept(event(2))).toBe(true);
  expect(inbox.accept(event(3))).toBe(true);
  expect(inbox.accept(event(4))).toBe(true);
  expect(ack).toEqual([2, 3, 4]);
  expect(calls).toEqual([]);
  release();
  await vi.waitFor(() => expect(calls).toEqual([4]));
  expect(inbox.accept(event(4))).toBe(false);
  inbox.close(id);
  expect(inbox.accept(event(5))).toBe(false);
});
it("device and UI slots share saturation and callback failure cannot hold ACK", async () => {
  const ack: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inbox = new EventInbox(async (_id, sequence) => {
    ack.push(sequence);
  }, owner);
  inbox.enable();
  const device = "00000000-0000-4000-8000-000000000091";
  const ui = "00000000-0000-4000-8000-000000000092";
  inbox.open(
    device,
    async () => {
      await barrier;
      throw new Error("consumer failure");
    },
    async () => {},
  );
  inbox.open(
    ui,
    async () => {
      await barrier;
    },
    async () => {},
  );
  for (let sequence = 1; sequence <= 4; sequence++) {
    expect(
      inbox.accept({
        version: 1,
        owner,
        subscriptionId: device,
        sequence,
        delivery: "control",
        kind: "devices.catalog",
        data: { revision: sequence, providers: [], sessions: [] },
      }),
    ).toBe(true);
    expect(
      inbox.accept({
        version: 1,
        owner,
        subscriptionId: ui,
        sequence,
        delivery: "control",
        kind: "ui.environment",
        data: { locale: "en", theme: "dark" },
      }),
    ).toBe(true);
  }
  expect(ack).toHaveLength(8);
  expect(
    inbox.accept({
      version: 1,
      owner,
      subscriptionId: ui,
      sequence: 5,
      delivery: "control",
      kind: "ui.environment",
      data: { locale: "en", theme: "dark" },
    }),
  ).toBe(false);
  expect(ack).toHaveLength(8);
  release();
  inbox.close(device);
  inbox.close(ui);
});
