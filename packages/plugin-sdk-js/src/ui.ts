import {
  type UiRequestMapV2 as UiRequestMap,
  type UiEventEnvelopeV2 as UiEventEnvelope,
  type Handle,
  type UiBinding,
  type UiScalar,
  type Result,
  type Severity,
} from "@kobrixa/plugin-protocol";
type Query = "ui/instances" | "ui/state" | "ui/patch" | "ui/subscribe" | "ui/snapshot";
import { beginUiSubscription, type UiEventClientPort, type ResyncRequiredEvent } from "./events.js";
export interface UiRequestPort {
  <M extends Query>(
    method: M,
    params: UiRequestMap[M]["params"],
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<UiRequestMap[M]["result"]>;
  (
    method: "events/unsubscribe",
    params: { subscriptionId: Handle },
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Result<{ removed: boolean }>>;
  (
    method: "ui/showMessage",
    params: { message: string; severity: Severity },
    options: { timeoutMs: number },
  ): Promise<null>;
}
export interface UiResyncSubscription {
  readonly subscriptionId: Handle;
  readonly params: UiRequestMap["ui/subscribe"]["params"];
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
export interface UiResyncRequiredNotice {
  readonly event: ResyncRequiredEvent;
  readonly cleanup: Promise<readonly Result<{ removed: boolean }>[]>;
  readonly subscriptions: readonly UiResyncSubscription[];
}
type SubscriptionRecord = {
  params: UiRequestMap["ui/subscribe"]["params"];
  lifetime: AbortController;
  current: () => boolean;
};
type Hook = {
  callback: (notice: UiResyncRequiredNotice) => void | Promise<void>;
  lifetime: AbortController;
  records: Set<SubscriptionRecord>;
};
export class UiClient {
  #ready = false;
  #epoch = 0;
  #records = new Map<Handle, SubscriptionRecord>();
  #notices = new Set<Map<Handle, SubscriptionRecord>>();
  #hook: Hook | undefined;
  #cleanup = new Set<Promise<Result<{ removed: boolean }>>>();
  onResyncRequired(callback: (notice: UiResyncRequiredNotice) => void | Promise<void>): () => void {
    this.check();
    if (this.#hook) this.#detach(this.#hook);
    const hook: Hook = { callback, lifetime: new AbortController(), records: new Set() };
    this.#hook = hook;
    this.events.terminal?.((event) => this.#terminal(event));
    return () => {
      this.#detach(hook);
      if (this.#hook === hook) this.#hook = undefined;
    };
  }
  #detach(hook: Hook): void {
    hook.lifetime.abort();
    for (const record of hook.records) record.lifetime.abort();
  }
  #close(id: Handle): Promise<Result<{ removed: boolean }>> {
    const closing = this.request("events/unsubscribe", { subscriptionId: id }, { timeoutMs: 5000 });
    this.#cleanup.add(closing);
    void closing.finally(() => this.#cleanup.delete(closing)).catch(() => {});
    return closing;
  }
  #terminal(event: ResyncRequiredEvent): (() => Promise<void>) | undefined {
    const records = new Map<Handle, SubscriptionRecord>();
    const cleanup: Promise<Result<{ removed: boolean }>>[] = [];
    for (const id of event.data.affected) {
      const record = this.#records.get(id);
      if (!record) continue;
      this.#records.delete(id);
      this.events.forget(id);
      // Cleanup is independent of user delivery, including throw/hung callbacks.
      if (!record.current()) {
        record.lifetime.abort();
        continue;
      }
      cleanup.push(this.#close(id));
      records.set(id, record);
    }
    if (!records.size) return;
    const closed = Promise.all(cleanup);
    void closed.catch(() => {});
    const hook = this.#hook;
    if (!hook) {
      for (const record of records.values()) record.lifetime.abort();
      return;
    }
    this.#notices.add(records);
    for (const record of records.values()) hook.records.add(record);
    return async () => {
      try {
        const subscriptions = [...records]
          .filter(([, record]) => record.current() && !record.lifetime.signal.aborted)
          .map(([subscriptionId, record]) => ({
            subscriptionId,
            params: structuredClone(record.params),
            signal: record.lifetime.signal,
            isCurrent: () =>
              record.current() && !record.lifetime.signal.aborted && !hook.lifetime.signal.aborted,
          }));
        if (!hook.lifetime.signal.aborted && subscriptions.length)
          await hook.callback({ event: structuredClone(event), subscriptions, cleanup: closed });
      } finally {
        this.#notices.delete(records);
        for (const record of records.values()) {
          record.lifetime.abort();
          hook.records.delete(record);
        }
      }
    };
  }
  #cancel(id: Handle, forget = true): void {
    this.#records.get(id)?.lifetime.abort();
    this.#records.delete(id);
    for (const records of this.#notices) records.get(id)?.lifetime.abort();
    if (forget) this.events.forget(id);
  }
  constructor(
    private readonly request: UiRequestPort,
    private readonly events: UiEventClientPort,
  ) {}
  markReady(): void {
    this.#ready = true;
  }
  retire(): void {
    this.#epoch++;
    if (this.#hook) this.#detach(this.#hook);
    this.#hook = undefined;
    for (const id of this.#records.keys()) this.#cancel(id);
    for (const records of this.#notices)
      for (const record of records.values()) record.lifetime.abort();
    this.#ready = false;
  }
  private check(): void {
    if (!this.#ready) throw new Error("UI is not ready.");
  }
  async showMessage(message: string, severity: Severity = "info"): Promise<void> {
    await this.request("ui/showMessage", { message, severity }, { timeoutMs: 10000 });
  }
  async instances(signal?: AbortSignal): Promise<UiRequestMap["ui/instances"]["result"]> {
    this.check();
    return this.request("ui/instances", {}, { timeoutMs: 5000, ...(signal ? { signal } : {}) });
  }
  async state(
    binding: UiBinding,
    signal?: AbortSignal,
  ): Promise<UiRequestMap["ui/state"]["result"]> {
    this.check();
    return this.request(
      "ui/state",
      { binding },
      { timeoutMs: 5000, ...(signal ? { signal } : {}) },
    );
  }
  async patch(
    binding: UiBinding,
    baseRevision: number,
    set: Record<string, UiScalar>,
    signal?: AbortSignal,
  ): Promise<UiRequestMap["ui/patch"]["result"]> {
    this.check();
    return this.request(
      "ui/patch",
      { binding, baseRevision, set },
      { timeoutMs: 5000, ...(signal ? { signal } : {}) },
    );
  }
  async subscribe(
    params: UiRequestMap["ui/subscribe"]["params"],
    listener: (event: UiEventEnvelope) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<UiRequestMap["ui/subscribe"]["result"]> {
    this.check();
    const epoch = this.#epoch;
    const channelCurrent = this.events.current?.() ?? (() => true);
    params = structuredClone(params);
    if (
      new Set(params.topics).size !== params.topics.length ||
      (!params.binding && params.topics.some((t) => t !== "instances" && t !== "environment"))
    )
      throw new TypeError("Invalid UI subscription topics.");
    this.events.terminal?.((event) => this.#terminal(event));
    const finish = beginUiSubscription(this.events);
    try {
      const result = await this.request("ui/subscribe", params, {
        timeoutMs: 5000,
        ...(signal ? { signal } : {}),
      });
      // Retirement can run after RpcPeer resolves the reply but before this
      // continuation. Never adopt that reply into a newer ready session.
      if (
        !this.#ready ||
        epoch !== this.#epoch ||
        !channelCurrent() ||
        signal?.aborted ||
        (result.ok && this.events.cancelled?.(result.value.subscriptionId))
      ) {
        if (result.ok) void this.#close(result.value.subscriptionId).catch(() => {});
        throw new Error("UI session retired or subscription cancelled.");
      }
      if (result.ok) {
        const id = result.value.subscriptionId;
        const record: SubscriptionRecord = {
          params: structuredClone(params),
          lifetime: new AbortController(),
          current: () => this.#ready && this.#epoch === epoch && channelCurrent(),
        };
        try {
          this.#records.set(id, record);
          const terminal = this.events.pendingTerminal?.(id);
          if (terminal) {
            // Pending terminal is already charged to the inbox control queue.
            // Attach adoption work to that queue rather than starting an unbounded task.
            this.events.adoptTerminal?.(terminal, () => this.#terminal(terminal));
          } else
            this.events.adopt({
              subscriptionId: result.value.subscriptionId,
              sequence: result.value.sequence,
              listener: (event) => {
                if (record.current() && !record.lifetime.signal.aborted) return listener(event);
              },
              snapshot: () => this.snapshot(id),
            });
        } catch (error) {
          this.#cancel(id);
          void this.#close(id).catch(() => {});
          throw error;
        }
      }
      return result;
    } finally {
      finish();
    }
  }
  async snapshot(subscriptionId: Handle): Promise<UiRequestMap["ui/snapshot"]["result"]> {
    this.check();
    return this.request("ui/snapshot", { subscriptionId }, { timeoutMs: 5000 });
  }
  async unsubscribe(subscriptionId: Handle): Promise<Result<{ removed: boolean }>> {
    this.#cancel(subscriptionId, false);
    const result = await this.request(
      "events/unsubscribe",
      { subscriptionId },
      { timeoutMs: 5000 },
    );
    if (result.ok) this.events.forget(subscriptionId);
    return result;
  }
}
