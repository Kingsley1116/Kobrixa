import type { Counter } from "@kobrixa/plugin-protocol";
import type { DeviceResourceParticipant, DeviceDisposition } from "@kobrixa/plugin-runtime";
export type ResourceDriver = {
  revokeOwner: DeviceResourceParticipant["retire"];
  revokeProvider(providerId: string, providerGeneration: Counter): readonly Promise<DeviceDisposition>[];
  revokeAll(): readonly Promise<DeviceDisposition>[];
};
export declare function createDeviceResourceParticipant(driver: ResourceDriver): DeviceResourceParticipant;
