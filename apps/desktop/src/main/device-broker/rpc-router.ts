import type { RpcPeer } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { DeviceBrokerPort } from "./broker-port.js";
export declare function attachDeviceRpc(input: {
  peer: RpcPeer; principal: () => Principal; broker: DeviceBrokerPort;
}): () => void;
