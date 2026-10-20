import type { ResourceOwner, Handle, Counter, Result, UiEvent, UiSubscriptionSnapshot } from "@kobrixa/plugin-protocol";
export interface UiEventLedgerPort {
  create(owner: ResourceOwner): Result<{subscriptionId: Handle; sequence: 0}>;
  owns(owner: ResourceOwner, subscriptionId: Handle): boolean;
  publish(owner: ResourceOwner, subscriptionId: Handle, event: UiEvent,
    delivery: "control" | "telemetry"): Result<{accepted: true}>;
  resync(owner: ResourceOwner, subscriptionId: Handle): Result<{accepted: true}>;
  snapshot(owner: ResourceOwner, subscriptionId: Handle,
    read: () => Result<UiSubscriptionSnapshot>): Result<{sequence: Counter; snapshot: UiSubscriptionSnapshot}>;
  unsubscribe(owner: ResourceOwner, subscriptionId: Handle): Result<{removed: boolean}>;
  closeAfterControl(owner: ResourceOwner, subscriptionId: Handle): void;
  onRemoved(listener: (subscriptionId: Handle) => void): () => void;
}
