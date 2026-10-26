import {
  eventEnvelopeSchema,
  validateDeviceWire,
  type Stage3EventEnvelope,
  uiEventEnvelopeSchemaV2,
  type ResourceOwner,
} from "@kobrixa/plugin-protocol";
export type ResyncRequiredEvent = Extract<Stage3EventEnvelope, { kind: "events.resyncRequired" }>;
type TerminalJob = {
  event: ResyncRequiredEvent;
  run: () => Promise<void>;
  late: (() => Promise<void>)[];
  wake?: () => void;
  carrier?: Slot;
  carrierReady?: () => void;
};
type Listener = (event: Stage3EventEnvelope) => void | Promise<void>;
type Slot = {
  last: number;
  watermark: number;
  owner: string | null;
  queue: Array<{ event: Stage3EventEnvelope; gap: boolean }>;
  bytes: number;
  controls: number;
  running: boolean;
  terminal: boolean;
  drained: Set<() => void>;
  listener: Listener;
  resync: () => Promise<void>;
};
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export class EventInbox {
  #enabled = false;
  #pending = 0;
  #early: Stage3EventEnvelope[] = [];
  #slots = new Map<string, Slot>();
  #terminalJobs: TerminalJob[] = [];
  #earlyTerminal = new Map<string, ResyncRequiredEvent>();
  #cancelledEarly = new Set<string>();
  cancelled(id: string): boolean {
    return this.#cancelledEarly.has(id);
  }
  #terminalHandler?: (event: ResyncRequiredEvent) => (() => Promise<void>) | undefined;
  // One UI projection per channel. This is internal, not a user callback registry.
  terminalHandler(
    handler: (event: ResyncRequiredEvent) => (() => Promise<void>) | undefined,
  ): void {
    this.#terminalHandler = handler;
  }
  adoptTerminal(
    event: ResyncRequiredEvent,
    prepare: () => (() => Promise<void>) | undefined,
  ): void {
    const job = this.#terminalJobs.find((job) => job.event === event);
    if (!job) throw new Error("Terminal adoption expired");
    const run = prepare();
    if (run) job.late.push(run);
    job.wake?.();
  }
  pendingTerminal(id: string): ResyncRequiredEvent | undefined {
    return this.#earlyTerminal.get(id);
  }
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
      if (!this.#pending) {
        this.#early = [];
        this.#earlyTerminal.clear();
        this.#cancelledEarly.clear();
        for (const job of this.#terminalJobs) {
          job.wake?.();
          job.carrierReady?.();
        }
      }
    };
  }
  open(id: string, listener: Listener, resync: () => Promise<void>, sequence = 0): void {
    if (this.#slots.size >= 32) throw new Error("Subscription queue full");
    this.#slots.set(id, {
      last: sequence,
      watermark: sequence,
      owner: null,
      queue: [],
      bytes: 0,
      controls: 0,
      running: false,
      terminal: false,
      drained: new Set(),
      listener,
      resync,
    });
    const terminal = this.#earlyTerminal.get(id);
    if (terminal) {
      const slot = this.#slots.get(id)!;
      slot.terminal = true;
      const job = this.#terminalJobs.find((job) => job.event === terminal);
      if (job && terminal.subscriptionId === id) {
        job.carrier = slot;
        job.carrierReady?.();
      }
    }
    const early = this.#early;
    this.#early = [];
    for (const event of early)
      if (event.subscriptionId === id) this.accept(event);
      else this.#early.push(event);
  }
  reconcile(id: Handle, sequence: Counter): void {
    const slot = this.#slots.get(id);
    if (!slot || sequence < slot.watermark) return;
    slot.watermark = sequence;
    slot.last = Math.max(slot.last, sequence);
  }

  last(id: string): number {
    return this.#slots.get(id)?.last ?? 0;
  }
  close(id: string): void {
    if (this.#earlyTerminal.has(id)) this.#cancelledEarly.add(id);
    const slot = this.#slots.get(id);
    this.#slots.delete(id);
    if (slot) for (const resolve of slot.drained) resolve();
    this.#early = this.#early.filter((event) => event.subscriptionId !== id);
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
    if (event.kind === "events.resyncRequired" && this.#terminalHandler) {
      if (
        (!slot && !this.#pending) ||
        (slot && (slot.terminal || event.sequence <= slot.last)) ||
        this.#terminalJobs.some((job) => job.event.subscriptionId === event.subscriptionId) ||
        this.#earlyTerminal.has(event.subscriptionId)
      )
        return false;
      const affected = new Set([
        ...this.#terminalJobs.flatMap((job) => job.event.data.affected),
        ...this.#earlyTerminal.keys(),
        ...event.data.affected,
      ]);
      if (
        affected.size > 32 ||
        this.#terminalJobs.length + [...this.#slots.values()].reduce((n, s) => n + s.controls, 0) >=
          8 ||
        (!slot && this.#early.length + this.#terminalJobs.length >= 8)
      )
        return false;
      // Reserve the actual control item before ACK. Do not await user work.
      const job: TerminalJob = { event, run: async () => {}, late: [] };
      if (slot) job.carrier = slot;
      this.#terminalJobs.push(job);
      if (slot) slot.last = event.sequence;
      for (const id of event.data.affected) {
        const affectedSlot = this.#slots.get(id);
        if (affectedSlot) affectedSlot.terminal = true;
      }
      if (this.#pending) for (const id of event.data.affected) this.#earlyTerminal.set(id, event);
      void this.ack(event.subscriptionId, event.sequence).catch(() => {});
      const ui = this.#terminalHandler(event);
      job.run = async () => {
        const legacy = async () => {
          if (!job.carrier && this.#pending)
            await new Promise<void>((resolve) => {
              job.carrierReady = resolve;
            });
          delete job.carrierReady;
          const slot = job.carrier;
          if (!slot || this.#slots.get(event.subscriptionId) !== slot) return;
          if (slot.running) await new Promise<void>((resolve) => slot.drained.add(resolve));
          if (this.#slots.get(event.subscriptionId) !== slot) return;
          // Device/settings adapters retain serial callback order and resource queries.
          await slot.resync();
          if (this.#slots.get(event.subscriptionId) === slot) await slot.listener(event);
        };
        const deliverUi = async () => {
          await Promise.allSettled([ui?.()]);
          while (true) {
            const next = job.late.shift();
            if (next) {
              await Promise.allSettled([next()]);
              continue;
            }
            if (!this.#pending) break;
            await new Promise<void>((resolve) => {
              job.wake = resolve;
            });
            delete job.wake;
          }
        };
        await Promise.allSettled([legacy(), deliverUi()]);
      };
      queueMicrotask(() => {
        void job.run().finally(() => {
          const at = this.#terminalJobs.indexOf(job);
          if (at >= 0) this.#terminalJobs.splice(at, 1);
        });
      });
      return true;
    }
    if (!slot) {
      if (
        !this.#pending ||
        this.#early.length + this.#terminalJobs.length >= 8 ||
        this.#early.reduce((sum, e) => sum + size(e), 0) + n > 262144
      )
        return false;
      this.#early.push(event);
      return true;
    }
    if (slot.terminal) return false;
    const owner = JSON.stringify(event.owner);
    if ((slot.owner !== null && slot.owner !== owner) || event.sequence <= slot.last) return false;
    if (
      event.delivery === "control"
        ? [...this.#slots.values()].reduce((n, s) => n + s.controls, 0) +
            this.#terminalJobs.length >=
          8
        : [...this.#slots.values()].reduce((n, s) => n + s.bytes, 0) +
            this.#early.reduce((n, e) => n + size(e), 0) +
            this.#terminalJobs.reduce((n, job) => n + size(job.event), 0) +
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
      queueMicrotask(() => {
        void this.#pump(slot);
      });
    }
    return true;
  }
  async #pump(slot: Slot): Promise<void> {
    try {
      while (slot.queue.length) {
        const { event, gap } = slot.queue[0]!;
        if (this.#slots.get(event.subscriptionId) !== slot) return;
        try {
          if (gap || event.kind === "events.resyncRequired") await slot.resync();
          if (this.#slots.get(event.subscriptionId) !== slot) return;
          if (event.sequence > slot.watermark) await slot.listener(event);
          if (this.#slots.get(event.subscriptionId) !== slot) return;
        } catch {
          /* Consumer failures do not replay device work. */
        }
        slot.queue.shift();
        slot.bytes -= size(event);
        if (event.delivery === "control") slot.controls--;
      }
    } finally {
      slot.running = false;
      for (const resolve of slot.drained) resolve();
      slot.drained.clear();
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
  UiRequestMapV2 as UiRequestMap,
  UiEventEnvelopeV2 as UiEventEnvelope,
  RpcPeer,
} from "@kobrixa/plugin-protocol";
export interface UiEventClientPort {
  cancelled?(id: Handle): boolean;
  adoptTerminal?(
    event: ResyncRequiredEvent,
    prepare: () => (() => Promise<void>) | undefined,
  ): void;
  terminal?(handler: (event: ResyncRequiredEvent) => (() => Promise<void>) | undefined): void;
  pendingTerminal?(id: Handle): ResyncRequiredEvent | undefined;
  current?(): () => boolean;
  adopt(input: {
    subscriptionId: Handle;
    sequence: Counter;
    snapshot: () => Promise<UiRequestMap["ui/snapshot"]["result"]>;
    listener: (event: UiEventEnvelope) => void | Promise<void>;
  }): void;
  forget(subscriptionId: Handle): void;
}
const uiInboxes = new WeakMap<UiEventClientPort, () => EventInbox>();
export function beginUiSubscription(port: UiEventClientPort): () => void {
  const inbox = uiInboxes.get(port);
  if (!inbox) throw new TypeError("Unknown UI event projection");
  inbox().enable();
  return inbox().beginSubscription();
}
export function uiEventClientPort(peer: RpcPeer): UiEventClientPort {
  const port: UiEventClientPort = {
    cancelled: (id) => eventInbox(peer).cancelled(id),
    adoptTerminal: (event, prepare) => eventInbox(peer).adoptTerminal(event, prepare),
    terminal: (handler) => eventInbox(peer).terminalHandler(handler),
    pendingTerminal: (id) => eventInbox(peer).pendingTerminal(id),
    current() {
      const epoch = peer.uiSessionEpoch;
      return () => !peer.closed && peer.uiSessionEpoch === epoch;
    },
    adopt({ subscriptionId, sequence, snapshot, listener }) {
      const epoch = peer.uiSessionEpoch;
      const inbox = eventInbox(peer);
      inbox.enable();
      inbox.open(
        subscriptionId,
        (event) => {
          if (!peer.closed && peer.uiSessionEpoch === epoch && event.kind.startsWith("ui.")) {
            const parsed = uiEventEnvelopeSchemaV2.parse(event);
            if (
              parsed.kind === "ui.data" &&
              (peer.uiResourceVersion !== 2 || peer.uiSessionEpoch !== epoch)
            )
              return;
            return listener(parsed);
          }
        },
        async () => {
          if (peer.closed || peer.uiSessionEpoch !== epoch) return;
          const result = await snapshot();
          if (peer.closed || peer.uiSessionEpoch !== epoch) return;
          if (!result.ok) throw new Error(result.error.message);
          inbox.reconcile(subscriptionId, result.value.sequence);
        },
        sequence,
      );
    },
    forget: (subscriptionId) => eventInbox(peer).close(subscriptionId),
  };
  // Lookup is deferred until subscription; legacy hosts need no event metadata.
  uiInboxes.set(port, () => eventInbox(peer));
  return port;
}
