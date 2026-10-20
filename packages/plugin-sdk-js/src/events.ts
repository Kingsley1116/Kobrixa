import {
  eventEnvelopeSchema,
  validateDeviceWire,
  type DeviceEvent,
  type ResourceOwner,
} from "@kobrixa/plugin-protocol";
type Listener = (event: DeviceEvent) => void | Promise<void>;
type Slot = {
  last: number;
  owner: string | null;
  queue: Array<{ event: DeviceEvent; gap: boolean }>;
  bytes: number;
  controls: number;
  running: boolean;
  listener: Listener;
  resync: () => Promise<void>;
};
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export class EventInbox {
  #enabled = false;
  #pending = 0;
  #early: DeviceEvent[] = [];
  #slots = new Map<string, Slot>();
  constructor(
    private readonly ack: (id: string, sequence: number) => Promise<void>,
    private readonly expectedOwner: ResourceOwner,
  ) {
    this.expectedOwner = Object.freeze(resourceOwnerSchema.parse(expectedOwner));
  }
  enable(): void {
    this.#enabled = true;
  }
  beginSubscription(): () => void {
    this.#pending++;
    return () => {
      this.#pending--;
      if (!this.#pending) this.#early = [];
    };
  }
  open(id: string, listener: Listener, resync: () => Promise<void>): void {
    if (this.#slots.size >= 32) throw new Error("Subscription queue full");
    this.#slots.set(id, {
      last: 0,
      owner: null,
      queue: [],
      bytes: 0,
      controls: 0,
      running: false,
      listener,
      resync,
    });
    const early = this.#early;
    this.#early = [];
    for (const event of early)
      if (event.subscriptionId === id) this.accept(event);
      else this.#early.push(event);
  }
  last(id: string): number {
    return this.#slots.get(id)?.last ?? 0;
  }
  close(id: string): void {
    this.#slots.delete(id);
  }
  accept(value: unknown): boolean {
    if (!this.#enabled) return false;
    const parsed = eventEnvelopeSchema.safeParse(value);
    if (!parsed.success) return false;
    try {
      validateDeviceWire("events/deliver.params", parsed.data);
    } catch {
      return false;
    }
    const event = parsed.data,
      slot = this.#slots.get(event.subscriptionId),
      n = size(event);
    if (JSON.stringify(event.owner) !== JSON.stringify(this.expectedOwner)) return false;
    if (!slot) {
      if (
        !this.#pending ||
        this.#early.length >= 8 ||
        this.#early.reduce((sum, e) => sum + size(e), 0) + n > 262144
      )
        return false;
      this.#early.push(event);
      return true;
    }
    const owner = JSON.stringify(event.owner);
    if ((slot.owner !== null && slot.owner !== owner) || event.sequence <= slot.last) return false;
    if (
      event.delivery === "control"
        ? [...this.#slots.values()].reduce((n, s) => n + s.controls, 0) >= 8
        : [...this.#slots.values()].reduce((n, s) => n + s.bytes, 0) +
            this.#early.reduce((n, e) => n + size(e), 0) +
            n >
          262144
    )
      return false;
    const gap = event.sequence !== slot.last + 1;
    slot.owner = owner;
    slot.queue.push({ event, gap });
    slot.bytes += n;
    if (event.delivery === "control") slot.controls++;
    slot.last = event.sequence;
    void this.ack(event.subscriptionId, event.sequence).catch(() => {});
    if (!slot.running) {
      slot.running = true;
      void this.#pump(slot);
    }
    return true;
  }
  async #pump(slot: Slot): Promise<void> {
    try {
      while (slot.queue.length) {
        const { event, gap } = slot.queue[0]!;
        try {
          if (gap || event.kind === "events.resyncRequired") await slot.resync();
          await slot.listener(event);
        } catch {
          /* Consumer failures do not replay device work. */
        }
        slot.queue.shift();
        slot.bytes -= size(event);
        if (event.delivery === "control") slot.controls--;
      }
    } finally {
      slot.running = false;
    }
  }
}
import { resourceOwnerSchema } from "@kobrixa/plugin-protocol";
const bindings = new WeakMap<RpcPeer, EventInbox>();
export function bindEventChannel(peer: RpcPeer, owner: ResourceOwner): void {
  if (peer.closed || bindings.has(peer)) throw new Error("Event channel already bound or closed");
  const immutable = Object.freeze(resourceOwnerSchema.parse(owner));
  const inbox = new EventInbox(async (subscriptionId, sequence) => {
    await peer.request("events/ack", { subscriptionId, sequence });
  }, immutable);
  bindings.set(peer, inbox);
  peer.onNotification("events/deliver", (value) => {
    if (!peer.closed) inbox.accept(value);
  });
}
export function eventChannelBound(peer: RpcPeer): boolean {
  return !peer.closed && bindings.has(peer);
}
export function eventInbox(peer: RpcPeer): EventInbox {
  const inbox = bindings.get(peer);
  if (!inbox) throw new Error("Trusted resource owner metadata is unavailable");
  return inbox;
}
import type {
  Handle,
  Counter,
  UiRequestMap,
  UiEventEnvelope,
  RpcPeer,
} from "@kobrixa/plugin-protocol";
export interface UiEventClientPort {
  adopt(input: {
    subscriptionId: Handle;
    sequence: Counter;
    snapshot: () => Promise<UiRequestMap["ui/snapshot"]["result"]>;
    listener: (event: UiEventEnvelope) => void | Promise<void>;
  }): void;
  forget(subscriptionId: Handle): void;
}
export declare function uiEventClientPort(peer: RpcPeer): UiEventClientPort;
