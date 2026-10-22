import type {
  ResourceOwner,
  Handle,
  Counter,
  Result,
  UiEvent,
  UiSubscriptionSnapshot,
} from "@kobrixa/plugin-protocol";
export interface UiEventLedgerPort {
  create(owner: ResourceOwner): Result<{ subscriptionId: Handle; sequence: 0 }>;
  owns(owner: ResourceOwner, subscriptionId: Handle): boolean;
  publish(
    owner: ResourceOwner,
    subscriptionId: Handle,
    event: UiEvent,
    delivery: "control" | "telemetry",
  ): Result<{ accepted: true }>;
  resync(owner: ResourceOwner, subscriptionId: Handle): Result<{ accepted: true }>;
  snapshot(
    owner: ResourceOwner,
    subscriptionId: Handle,
    read: () => Result<UiSubscriptionSnapshot>,
  ): Result<{ sequence: Counter; snapshot: UiSubscriptionSnapshot }>;
  unsubscribe(owner: ResourceOwner, subscriptionId: Handle): Result<{ removed: boolean }>;
  closeAfterControl(owner: ResourceOwner, subscriptionId: Handle): void;
  onRemoved(listener: (subscriptionId: Handle) => void): () => void;
}

import {
  RpcError,
  RPC_ERRORS,
  uiRequestSchemas,
  resourceFailure,
  type UiBinding,
  type UiRequestMap,
} from "@kobrixa/plugin-protocol";
import { sameResourceOwner, sameUiBinding } from "./ui-host-ports.js";
import type { UiStateRegistry } from "./ui-state.js";
type Subscription = {
  owner: ResourceOwner;
  topics: UiRequestMap["ui/subscribe"]["params"]["topics"];
  binding?: UiBinding;
};
export class UiSubscriptions {
  readonly #subscriptions = new Map<Handle, Subscription>();
  readonly #offState: () => void;
  readonly #offRemoved: () => void;
  readonly #environment = new Map<string, { locale: "en" | "zh-TW"; theme: "light" | "dark" }>();
  constructor(
    private readonly state: UiStateRegistry,
    private readonly ledger: UiEventLedgerPort,
    private readonly revokeIntent: (owner: ResourceOwner, binding?: UiBinding) => void,
  ) {
    this.#offState = state.onEvent((owner, event) => this.#deliver(owner, event));
    this.#offRemoved = ledger.onRemoved((id) => {
      this.#subscriptions.delete(id);
    });
  }
  #read(subscription: Subscription): Result<UiSubscriptionSnapshot> {
    const instances = this.state.instances(subscription.owner);
    const environment =
      this.#environment.get(JSON.stringify(subscription.owner)) ?? this.state.environment();
    if (!subscription.binding)
      return { ok: true, value: { instances, states: [], ...environment } };
    const state = this.state.state(subscription.owner, subscription.binding);
    if (!state.ok) return state;
    return {
      ok: true,
      value: {
        instances: instances.filter((binding) => sameUiBinding(binding, subscription.binding!)),
        states: [state.value],
        ...environment,
      },
    };
  }
  subscribe(
    owner: ResourceOwner,
    input: UiRequestMap["ui/subscribe"]["params"],
  ): UiRequestMap["ui/subscribe"]["result"] {
    if (
      !uiRequestSchemas["ui/subscribe"].params.safeParse(input).success ||
      new Set(input.topics).size !== input.topics.length ||
      (!input.binding &&
        input.topics.some((topic) => topic !== "instances" && topic !== "environment"))
    )
      throw new RpcError(RPC_ERRORS.invalidParams, "Invalid UI subscription.");
    const subscription: Subscription = {
      owner: structuredClone(owner),
      topics: [...input.topics],
      ...(input.binding ? { binding: structuredClone(input.binding) } : {}),
    };
    const snapshot = this.#read(subscription);
    if (!snapshot.ok) return snapshot;
    // All operations before return are synchronous. No event can enter between snapshot and admission.
    const admitted = this.ledger.create(owner);
    if (!admitted.ok) return admitted;
    this.#subscriptions.set(admitted.value.subscriptionId, subscription);
    return { ok: true, value: { ...admitted.value, snapshot: snapshot.value } };
  }
  snapshot(owner: ResourceOwner, subscriptionId: Handle): UiRequestMap["ui/snapshot"]["result"] {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (
      !subscription ||
      !sameResourceOwner(owner, subscription.owner) ||
      !this.ledger.owns(owner, subscriptionId)
    )
      return resourceFailure("stale");
    return this.ledger.snapshot(owner, subscriptionId, () => this.#read(subscription));
  }
  unsubscribe(owner: ResourceOwner, subscriptionId: Handle): Result<{ removed: boolean }> {
    // The shared ledger is authoritative even after this module has removed its callback metadata.
    const result = this.ledger.unsubscribe(owner, subscriptionId);
    if (result.ok) {
      this.#subscriptions.delete(subscriptionId);
      if (
        ![...this.#subscriptions.values()].some((subscription) =>
          sameResourceOwner(owner, subscription.owner),
        )
      )
        this.#environment.delete(JSON.stringify(owner));
    }
    return result;
  }
  environment(owner: ResourceOwner, locale: "en" | "zh-TW", theme: "light" | "dark"): void {
    if (
      ![...this.#subscriptions.values()].some((subscription) =>
        sameResourceOwner(owner, subscription.owner),
      )
    )
      return;
    this.#environment.set(JSON.stringify(owner), { locale, theme });
    this.#deliver(owner, { kind: "ui.environment", data: { locale, theme } });
  }
  #deliver(owner: ResourceOwner, event: UiEvent): void {
    for (const [id, subscription] of [...this.#subscriptions]) {
      if (!sameResourceOwner(owner, subscription.owner) || !this.ledger.owns(owner, id)) continue;
      const topic = event.kind.slice(3) as Subscription["topics"][number];
      if (event.kind !== "ui.revoked" && !subscription.topics.includes(topic)) continue;
      if (
        "binding" in event.data &&
        (!subscription.binding || !sameUiBinding(event.data.binding, subscription.binding))
      )
        continue;
      let selected = event;
      if (event.kind === "ui.instances" && subscription.binding)
        selected = {
          kind: "ui.instances",
          data: {
            instances: event.data.instances.filter((binding) =>
              sameUiBinding(binding, subscription.binding!),
            ),
          },
        };
      const delivery = selected.kind === "ui.state" ? "telemetry" : "control";
      const result = this.ledger.publish(owner, id, selected, delivery);
      if (!result.ok) {
        if (delivery === "telemetry" && this.ledger.resync(owner, id).ok) continue;
        // Synchronous revoke happens before any callback cleanup or await; safety snapshots live elsewhere.
        this.revokeIntent(owner, subscription.binding);
        this.unsubscribe(owner, id);
      } else if (selected.kind === "ui.revoked") {
        this.ledger.closeAfterControl(owner, id);
      }
    }
  }
  retire(owner: ResourceOwner): void {
    for (const [id, subscription] of [...this.#subscriptions])
      if (sameResourceOwner(owner, subscription.owner)) this.unsubscribe(owner, id);
    this.#environment.delete(JSON.stringify(owner));
  }
  dispose(): void {
    this.#offState();
    this.#offRemoved();
    for (const [id, subscription] of [...this.#subscriptions])
      this.unsubscribe(subscription.owner, id);
    this.#environment.clear();
  }
}
