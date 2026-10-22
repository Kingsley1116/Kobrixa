import type { Counter } from "@kobrixa/plugin-protocol";
import type { DeviceDisposition, DeviceResourceParticipant } from "@kobrixa/plugin-runtime";
export interface ResourceDriver {
  revokeOwner: DeviceResourceParticipant["retire"];
  revokeProvider(
    providerId: string,
    providerGeneration: Counter,
  ): readonly Promise<DeviceDisposition>[];
  revokeAll(): readonly Promise<DeviceDisposition>[];
}
// T2 owns first-end ledgers and the 15s + 5s cleanup clocks. Revocation functions
// must be synchronous; their returned promises already run independently of the
// cancelled ordinary request. This wrapper never renews a grant or deadline.
export function createDeviceResourceParticipant(driver: ResourceDriver): DeviceResourceParticipant {
  const collect = async (
    work: readonly Promise<DeviceDisposition>[],
  ): Promise<DeviceDisposition> => {
    const results = await Promise.allSettled(work);
    const value: DeviceDisposition = { stopConfirmed: true, journalCommitted: true, faultIds: [] };
    for (const result of results) {
      if (result.status === "rejected") {
        value.stopConfirmed = false;
        value.journalCommitted = false;
        continue;
      }
      value.stopConfirmed &&= result.value.stopConfirmed;
      value.journalCommitted &&= result.value.journalCommitted;
      value.faultIds.push(...result.value.faultIds);
    }
    value.faultIds = [...new Set(value.faultIds)];
    return value;
  };
  return {
    retire: (owner, reason) => driver.revokeOwner(owner, reason),
    retireProvider: (id, generation) => collect(driver.revokeProvider(id, generation)),
    beginShutdown: () => collect(driver.revokeAll()),
  };
}
