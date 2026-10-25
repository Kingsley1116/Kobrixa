import type {
  ResourceOwner,
  UiDataRequestMapV2,
  UiEventEnvelopeV2,
} from "@kobrixa/plugin-protocol";
import { UiDataStore } from "./ui-data.js";
import type { UiStateRegistry } from "./ui-state.js";
import type { CoreWindowScope } from "./core-actions.js";
// Authorization is supplied by the original channel, never by dataset metadata.
export interface UiDataChannelAuthority {
  current(): boolean;
  panelsPermission(): boolean;
  scope(): CoreWindowScope;
  versions(): readonly (1 | 2)[];
  ready(): boolean;
}
type DataEvent = Pick<Extract<UiEventEnvelopeV2, { kind: "ui.data" }>, "kind" | "data">;
const key = (owner: ResourceOwner) =>
  JSON.stringify([
    owner.sourceKey,
    owner.pluginId,
    owner.generation,
    owner.hostEpoch,
    owner.processEpoch,
  ]);
export class UiDataHost {
  readonly store: UiDataStore;
  readonly #channels = new Map<
    string,
    { owner: ResourceOwner; authority: UiDataChannelAuthority }
  >();
  readonly #listeners = new Set<(owner: ResourceOwner, event: DataEvent) => void>();
  readonly #off: () => void;
  constructor(
    private readonly states: UiStateRegistry,
    now: () => number,
  ) {
    this.store = new UiDataStore({
      now,
      resolve: (owner, binding) => {
        const channel = this.#channels.get(key(owner))?.authority;
        if (!channel || !channel.current() || !states.inScope(owner, binding, channel.scope()))
          return null;
        const authority = states.dataAuthority(owner, binding);
        return authority
          ? {
              ...authority,
              ready: channel.ready() && channel.versions().includes(2),
              panelsPermission: channel.panelsPermission(),
            }
          : null;
      },
      admitCommit: (owner, binding) => states.admitDataCommit(owner, binding),
      publish: (owner, event) => {
        if (event.data.binding.kind !== "panel") return;
        const data = { ...event.data, binding: { ...event.data.binding, kind: "panel" as const } };
        for (const listener of this.#listeners) {
          try {
            listener(owner, { kind: "ui.data", data });
          } catch {
            /* Host observers do not own commits. */
          }
        }
      },
    });
    this.#off = states.onEvent((owner, event) => {
      if (event.kind === "ui.visibility" && !event.data.visible)
        this.store.invalidateHide(owner, event.data.binding);
      if (event.kind === "ui.revoked") this.store.close(owner, event.data.binding);
    });
  }
  bind(owner: ResourceOwner, authority: UiDataChannelAuthority): () => void {
    const id = key(owner);
    if (this.#channels.has(id)) throw new Error("UI data channel already attached");
    this.#channels.set(id, { owner: structuredClone(owner), authority });
    return () => {
      if (this.#channels.get(id)?.authority === authority) {
        this.#channels.delete(id);
        this.store.retire(owner);
      }
    };
  }
  supports(owner: ResourceOwner, version: 1 | 2): boolean {
    const channel = this.#channels.get(key(owner))?.authority;
    return (
      !!channel &&
      channel.current() &&
      channel.panelsPermission() &&
      channel.ready() &&
      channel.versions().includes(version)
    );
  }
  snapshot(
    owner: ResourceOwner,
    binding: UiDataRequestMapV2["ui/dataSnapshot"]["params"]["binding"],
  ) {
    return this.store.snapshot(owner, { binding });
  }
  onEvent(listener: (owner: ResourceOwner, event: DataEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  retire(owner: ResourceOwner): void {
    this.#channels.delete(key(owner));
    this.store.retire(owner);
  }
  dispose(): void {
    this.#off();
    for (const { owner } of this.#channels.values()) this.store.retire(owner);
    this.#channels.clear();
    this.#listeners.clear();
  }
}
