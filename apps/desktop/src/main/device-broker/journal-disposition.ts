import type { DeviceDisposition } from "@kobrixa/plugin-runtime";
import type { JournalPort } from "./journal-port.js";

/** Host-only receipt extension. This is never a successful journal commit. */
export type JournalDisposition = DeviceDisposition & {
  reason?: "journal-unavailable-no-evidence";
};
// A serializable reason describes a receipt; only a live host proof authorizes
// closing. Recheck after storage drains so a later write/Stop cannot borrow it.
const closeProofs = new WeakMap<DeviceDisposition, () => boolean>();

function unavailableWithoutEvidence(journal: JournalPort): boolean {
  const history = journal.history?.();
  return (
    journal.snapshot().journalHealth === "unwritable" &&
    history !== undefined &&
    !history.initialized &&
    history.inventory === "validated-empty" &&
    !history.writeAttempted &&
    !history.publicationUncertain &&
    !history.riskWorkAdmitted &&
    !history.resourceLimited &&
    history.io === "idle"
  );
}

export function journalDisposition(journal: JournalPort): JournalDisposition {
  const snapshot = journal.snapshot();
  const value: JournalDisposition = {
    stopConfirmed: snapshot.blockers.length === 0,
    journalCommitted: snapshot.journalHealth === "ready",
    faultIds: [...snapshot.blockers],
    ...(unavailableWithoutEvidence(journal)
      ? { reason: "journal-unavailable-no-evidence" as const }
      : {}),
  };
  if (value.reason) closeProofs.set(value, () => unavailableWithoutEvidence(journal));
  return value;
}

export function permitsUnavailableClose(value: DeviceDisposition): boolean {
  return (
    (value as JournalDisposition).reason === "journal-unavailable-no-evidence" &&
    value.stopConfirmed &&
    !value.journalCommitted &&
    value.faultIds.length === 0 &&
    closeProofs.get(value)?.() === true
  );
}

/** An unrelated failure must never borrow the no-evidence exception. */
export function combineDispositions(all: readonly DeviceDisposition[]): JournalDisposition {
  const value: JournalDisposition = {
    stopConfirmed: all.every((item) => item.stopConfirmed),
    journalCommitted: all.every((item) => item.journalCommitted),
    faultIds: [...new Set(all.flatMap((item) => item.faultIds))],
  };
  if (
    !value.journalCommitted &&
    value.stopConfirmed &&
    value.faultIds.length === 0 &&
    all.every((item) => item.journalCommitted || permitsUnavailableClose(item))
  ) {
    value.reason = "journal-unavailable-no-evidence";
    closeProofs.set(value, () =>
      all.every((item) => item.journalCommitted || permitsUnavailableClose(item)),
    );
  }
  return value;
}
