import {
  type UiRequestMap,
  type UiEventEnvelope,
  type Handle,
  type UiBinding,
  type UiScalar,
  type Result,
  type Severity,
} from "@kobrixa/plugin-protocol";
type Query = "ui/instances" | "ui/state" | "ui/patch" | "ui/subscribe" | "ui/snapshot";
import { beginUiSubscription, type UiEventClientPort } from "./events.js";
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
export class UiClient {
  #ready = false;
  constructor(
    private readonly request: UiRequestPort,
    private readonly events: UiEventClientPort,
  ) {}
  markReady(): void {
    this.#ready = true;
  }
  retire(): void {
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
    if (
      new Set(params.topics).size !== params.topics.length ||
      (!params.binding && params.topics.some((t) => t !== "instances" && t !== "environment"))
    )
      throw new TypeError("Invalid UI subscription topics.");
    const finish = beginUiSubscription(this.events);
    try {
      const result = await this.request("ui/subscribe", params, {
        timeoutMs: 5000,
        ...(signal ? { signal } : {}),
      });
      if (result.ok)
        this.events.adopt({
          subscriptionId: result.value.subscriptionId,
          sequence: result.value.sequence,
          listener,
          snapshot: () => this.snapshot(result.value.subscriptionId),
        });
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
    const result = await this.request(
      "events/unsubscribe",
      { subscriptionId },
      { timeoutMs: 5000 },
    );
    if (result.ok) this.events.forget(subscriptionId);
    return result;
  }
}
