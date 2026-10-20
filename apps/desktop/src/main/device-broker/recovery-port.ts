import type { BusinessResult, Counter, Handle } from "@kobrixa/plugin-protocol";
import type { CoreActionReference, CoreActionTarget, CoreActionValidationPort, PhysicalIdentity } from "@kobrixa/plugin-runtime";
import type { IdleObservation, ProviderOutcome } from "./provider.js";
import type { DeviceRecoverySnapshot, JournalPort } from "./journal-port.js";
import { journalDocument } from "./journal.js";
import type { DeviceFailureDetail, DeviceRecoveryPort } from "@kobrixa/plugin-runtime";
export type { DeviceFailureDetail, DeviceRecoveryPort, DeviceRecoverySnapshot } from "@kobrixa/plugin-runtime";
type Result = BusinessResult<DeviceRecoverySnapshot, DeviceFailureDetail>;
// Local dependency supplied by T2's registry. occupy must reserve the recovery lane
// synchronously before its first await, reject foreground/recording, and retain
// original occupancy through work, journal publication and cleanup settlement.
export interface RecoveryDriver {
  wallNow(): number; // Unix epoch milliseconds, independent of monotonic deadlines.
  describe(sessionId: Handle): { sessionId: Handle; providerGeneration: Counter; physical: PhysicalIdentity } | null;
  occupy<T>(sessionId: Handle, work: (lane: {
    observe(): Promise<ProviderOutcome<IdleObservation>>;
    stop(): Promise<ProviderOutcome<IdleObservation>>;
  }) => Promise<T>): Promise<T>;
}
const denied = (): Result => ({ ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "A current core action is required.", detail: { kind: "permission", reason: "user-action-required" } } });
const stale = (): Result => ({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Recovery evidence is stale.", detail: { kind: "resource", reason: "stale", resource: "journal" } } });
const failure = (reason: "identity-ambiguous" | "readback-failed" | "journal-unwritable" | "provider-disabled", confirmed = false): Result => ({ ok: false, error: {
  code: reason === "readback-failed" ? "PLUGIN_E_DEVICE_STOP_UNCONFIRMED" : reason === "provider-disabled" ? "PLUGIN_E_DEVICE_UNAVAILABLE" : "PLUGIN_E_DEVICE_OPERATION",
  message: "Recovery remains blocked.", detail: { kind: "device", reason, dispatch: "unknown", stopConfirmation: confirmed ? "confirmed" : "unconfirmed" },
} });
export function isIdle(value: IdleObservation | null): value is IdleObservation {
  return value !== null && value.programStopped && value.outputs.length === 4
    && new Set(value.outputs.map((o) => o.actuatorId)).size === 4
    && value.outputs.every((o) => o.known && o.busy === false && o.speed === 0);
}
export function createDeviceRecovery(input: { journal: JournalPort; actions: CoreActionValidationPort; driver: RecoveryDriver }): DeviceRecoveryPort {
  const { journal, actions, driver } = input;
  const run = async (action: CoreActionReference, target: CoreActionTarget, work: () => Promise<Result>): Promise<Result> => {
    if (!actions.claim(action, target)) return denied();
    try { return await work(); } finally { actions.complete(action); }
  };
  const resolve = async (target: Extract<CoreActionTarget, { kind: "device-stop" | "device-reconcile" }>, action: CoreActionReference): Promise<Result> => {
    const fault = journal.snapshot().faults.find((e) => e.id === target.faultId);
    if (!fault || fault.state === "resolved") return stale();
    const session = driver.describe(target.sessionId);
    if (!session) return failure("provider-disabled");
    if (session.physical.providerId !== fault.providerId || session.physical.family !== fault.physical.family) return failure("identity-ambiguous");
    if (target.kind === "device-reconcile" && target.identityEvidence === "serial-match"
      && (session.physical.strength !== "stable" || fault.physical.strength !== "stable"
        || session.physical.basis !== "serial" || fault.physical.basis !== "serial"
        || session.physical.digest === null || session.physical.digest !== fault.physical.digest)) return failure("identity-ambiguous");
    // user-confirmed-device and current-device stop are admitted only because the
    // ledger claim binds this fault/session to actual core confirmation evidence.
    try {
      return await driver.occupy(target.sessionId, async (lane) => {
        if (!actions.isClaimed(action, target)) return denied();
        const outcome = await (target.kind === "device-stop" ? lane.stop() : lane.observe());
        if (!actions.isClaimed(action, target)) return denied();
        const current = driver.describe(target.sessionId);
        if (!current || current.providerGeneration !== session.providerGeneration
          || current.physical.digest !== session.physical.digest) return stale();
        if (outcome.error || !isIdle(outcome.value)) return failure("readback-failed");
        const document = await journal.load();
        if (!actions.isClaimed(action, target)) return denied();
        const existing = document.entries.find((e) => e.id === fault.id);
        if (!existing || existing.revision !== fault.revision) return stale();
        const same = fault.sessionId === target.sessionId && fault.providerGeneration === session.providerGeneration;
        const at = Math.max(driver.wallNow(), fault.updatedAt);
        const entries = document.entries.map((e) => e.id !== fault.id ? e : {
          ...fault, revision: fault.revision + 1, updatedAt: at, state: "resolved" as const,
          stopConfirmation: "confirmed" as const,
          resolution: { kind: same && target.kind === "device-stop" ? "confirmed-on-original-session" as const : "observed-idle" as const,
            at, sessionId: target.sessionId,
            identityEvidence: same ? "same-session" as const : target.kind === "device-reconcile" ? target.identityEvidence : "user-confirmed-device" as const },
        });
        try { await journal.commit(journalDocument(document.revision + 1, entries)); }
        catch { return failure("journal-unwritable", true); }
        return { ok: true, value: journal.snapshot() };
      });
    } catch { return failure("readback-failed"); }
  };
  return {
    snapshot: () => journal.snapshot(), subscribe: (listener) => journal.subscribe(listener),
    stopCurrent(value) { const target = { kind: "device-stop" as const, faultId: value.faultId, sessionId: value.sessionId }; return run(value.action, target, () => resolve(target, value.action)); },
    reconcile(value) { const target = { kind: "device-reconcile" as const, faultId: value.faultId, sessionId: value.sessionId, identityEvidence: value.identityEvidence }; return run(value.action, target, () => resolve(target, value.action)); },
    clearResolved(value) {
      const target = { kind: "device-clear" as const, entryIds: [...value.entryIds] };
      return run(value.action, target, async () => {
        if (!value.entryIds.length || value.entryIds.length > 64 || new Set(value.entryIds).size !== value.entryIds.length) return stale();
        const document = await journal.load();
        if (!actions.isClaimed(value.action, target)) return denied();
        if (value.entryIds.some((id) => !document.entries.some((e) => e.id === id && e.state === "resolved"))) return stale();
        try { await journal.commit(journalDocument(document.revision + 1, document.entries.filter((e) => !value.entryIds.includes(e.id)))); }
        catch { return failure("journal-unwritable"); }
        return { ok: true, value: journal.snapshot() };
      });
    },
  };
}
