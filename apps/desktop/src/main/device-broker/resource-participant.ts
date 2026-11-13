import { combineDispositions } from "./journal-disposition.js";
import type { Counter } from "@kobrixa/plugin-protocol";
import type { DeviceDisposition, DeviceResourceParticipant } from "@kobrixa/plugin-runtime";
// The coordinator owns onEnded -> endReservation -> drain and legacy save. The
// broker joins that existing work before disconnecting a retired provider.
const providerLifecycles = new WeakMap<
  DeviceResourceParticipant,
  (sessionId: string) => Promise<void>
>();
export function attachProviderRetirementLifecycle(
  resources: DeviceResourceParticipant,
  settle: (sessionId: string) => Promise<void>,
): () => void {
  if (providerLifecycles.has(resources)) throw new Error("Provider lifecycle already attached.");
  providerLifecycles.set(resources, settle);
  return () => {
    if (providerLifecycles.get(resources) === settle) providerLifecycles.delete(resources);
  };
}
export async function settleProviderRetirementLifecycle(
  resources: DeviceResourceParticipant,
  sessionId: string,
  hasReservations: boolean,
): Promise<void> {
  const settle = providerLifecycles.get(resources);
  if (settle) return settle(sessionId);
  // Resource-free standalone brokers need no storage adapter. A recording never
  // becomes saved merely because no coordinator was composed.
  return hasReservations
    ? Promise.reject(new Error("Provider retirement requires the reservation coordinator."))
    : Promise.resolve();
}
export interface ResourceDriver {
  revokeOwner: DeviceResourceParticipant["retire"];
  revokeProvider(
    providerId: string,
    providerGeneration: Counter,
  ): readonly Promise<DeviceDisposition>[];
  revokeAll(): readonly Promise<DeviceDisposition>[];
}
export class ProviderResourceFailure extends AggregateError {
  constructor(
    errors: unknown[],
    readonly disposition: DeviceDisposition,
  ) {
    super(errors, "Provider resource retirement failed.");
  }
}
// T2 owns first-end ledgers and the 15s + 5s cleanup clocks. Revocation functions
// must be synchronous; their returned promises already run independently of the
// cancelled ordinary request. This wrapper never renews a grant or deadline.
export function createDeviceResourceParticipant(driver: ResourceDriver): DeviceResourceParticipant {
  const collect = async (
    work: readonly Promise<DeviceDisposition>[],
    preserveErrors = false,
  ): Promise<DeviceDisposition> => {
    const results = await Promise.allSettled(work);
    const dispositions: DeviceDisposition[] = [];
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        dispositions.push({ stopConfirmed: false, journalCommitted: false, faultIds: [] });
        errors.push(result.reason);
        continue;
      }
      dispositions.push(result.value);
    }
    const value = combineDispositions(dispositions);
    if (preserveErrors && errors.length) throw new ProviderResourceFailure(errors, value);
    return value;
  };
  return {
    retire: (owner, reason) => driver.revokeOwner(owner, reason),
    retireProvider: async (id, generation) => collect(driver.revokeProvider(id, generation), true),
    beginShutdown: () => collect(driver.revokeAll()),
  };
}
