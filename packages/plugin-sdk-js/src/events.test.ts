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
  expect(callback).toHaveBeenCalledTimes(1);
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
