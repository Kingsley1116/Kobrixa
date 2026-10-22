import {
  deviceRequestSchemas,
  eventEnvelopeSchema,
  requestMethods,
  type RequestContext,
  type RpcPeer,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { DeviceBrokerPort, DeviceMethod, DeviceParams, DeviceResult } from "./broker-port.js";
import { DeviceRpcBinding } from "./rpc-bindings.js";

const attachedPeers = new WeakSet<RpcPeer>();
export function attachDeviceRpc(input: {
  peer: RpcPeer;
  principal: () => Principal;
  broker: DeviceBrokerPort;
}): () => void {
  if (attachedPeers.has(input.peer))
    throw new Error("Device/common-event RPC is already attached to this peer.");
  const binding = new DeviceRpcBinding(input.principal);
  const original = binding.capture();
  if (original.kind !== "plugin") throw new Error("Device RPC requires a plugin channel owner.");
  const channel = input.broker.attachChannel({
    owner: original.owner,
    principal: () => binding.capture(),
    send(event) {
      binding.capture();
      if (input.peer.closed) throw new Error("Device channel closed.");
      input.peer.notify("events/deliver", eventEnvelopeSchema.parse(event));
    },
  });
  attachedPeers.add(input.peer);
  // RpcPeer validates each published schema before invoking this typed bridge.
  // The domain map uses schema-inferred inputs/results; RpcPeer.handle accepts z.input results.
  const register = input.peer.handle.bind(input.peer) as <M extends DeviceMethod>(
    method: M,
    handler: (params: DeviceParams<M>, context: RequestContext) => Promise<DeviceResult<M>>,
  ) => void;
  for (const method of Object.keys(deviceRequestSchemas)) {
    if (!Object.hasOwn(requestMethods, method)) continue;
    const name = method as DeviceMethod;
    register(name, async (params, context) => {
      const principal = binding.capture();
      const result = await input.broker.request(principal, name, params, context.signal);
      if (result.ok && name === "devices/negotiate") {
        context.afterReply(
          () => channel.negotiated("devices", 1),
          () => {},
        );
      }
      if (result.ok && name === "devices/subscribe" && "subscriptionId" in result.value) {
        const subscriptionId = result.value.subscriptionId;
        context.afterReply(
          () => channel.activate(subscriptionId),
          () => channel.abandon(subscriptionId),
        );
      }
      return result;
    });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    binding.close();
    channel.dispose();
  };
}
