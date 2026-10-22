import type { RpcPeer, ResourceOwner, Handle, Counter } from "@kobrixa/plugin-protocol";
import type { UiRequestMap, UiEventEnvelope } from "@kobrixa/plugin-protocol";
export declare function bindEventChannel(peer: RpcPeer, owner: ResourceOwner): void;
export interface UiEventClientPort {
  adopt(input: { subscriptionId: Handle; sequence: Counter;
    snapshot: () => Promise<UiRequestMap["ui/snapshot"]["result"]>;
    listener: (event: UiEventEnvelope) => void | Promise<void> }): void;
  forget(subscriptionId: Handle): void;
}
export declare function uiEventClientPort(peer: RpcPeer): UiEventClientPort;
