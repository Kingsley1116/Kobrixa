import type { DeviceDescriptor, DeviceInputModes, DeviceMonitorSnapshot } from "@kobrixa/device";
import type { Handle, ReadSnapshot, SourceCatalog } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { DeviceBrokerPort, DeviceMethod, DeviceParams, DeviceResult } from "./broker-port.js";
import type { MonitorResult } from "../../shared/api.js";
export interface LegacyMonitorFeed {
  subscribe(input: { principal: Principal; sessionId: string; intervalMs: 500 | 30000;
    receive: (snapshot: ReadSnapshot, sources: SourceCatalog) => void }): Promise<() => Promise<void>>;
}
export interface LegacyDeviceDependencies {
  broker: DeviceBrokerPort;
  principal(): Principal;
  disconnect(sessionId: Handle): Promise<void>;
  stop(sessionId: Handle): Promise<void>;
  feed: LegacyMonitorFeed;
}
export declare function createLegacyDevice(deps: LegacyDeviceDependencies): LegacyDevice;
export declare function createLegacyMonitorFeed(broker: DeviceBrokerPort): LegacyMonitorFeed;
export declare class LegacyDevice {
  readonly dependencies: LegacyDeviceDependencies;
  constructor(dependencies: LegacyDeviceDependencies);
  request<M extends DeviceMethod>(method: M, params: DeviceParams<M>, signal?: AbortSignal): Promise<Extract<DeviceResult<M>, { ok: true }>["value"]>;
  descriptor(id: string): DeviceDescriptor;
  discover(signal?: AbortSignal): Promise<DeviceDescriptor[]>;
  connect(value: DeviceDescriptor, signal?: AbortSignal): Promise<string>;
  connectWifi(address: string, signal?: AbortSignal): Promise<string>;
  reconnectForRecovery(previousSessionId: Handle, signal: AbortSignal): Promise<Handle>;
  disconnect(id: string): Promise<void>;
  reset(): Promise<void>;
  stop(id: string): Promise<void>;
  monitor(id: string): Promise<MonitorResult<DeviceMonitorSnapshot>>;
  inputModes(id: string, port: number, type: number): Promise<MonitorResult<DeviceInputModes>>;
  setInputMode(id: string, port: number, type: number, mode: number): Promise<MonitorResult<DeviceMonitorSnapshot>>;
  watch(id: string, intervalMs: 500 | 30000, receive: Parameters<LegacyMonitorFeed["subscribe"]>[0]["receive"]): Promise<() => Promise<void>>;
}
