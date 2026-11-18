import { expect, it, vi } from "vitest";
import { CleanupBlocked, LifecycleCoordinator } from "../device-broker/lifecycle-coordinator.js";
import type { JournalDisposition } from "../device-broker/journal-disposition.js";
import { ShutdownCoordinator } from "./shutdown-coordinator.js";

function fixture() {
  const lifecycle: LifecycleCoordinator = Object.create(LifecycleCoordinator.prototype);
  const close = vi.spyOn(lifecycle, "close").mockResolvedValue();
  const disposition = vi.spyOn(lifecycle, "closeDisposition").mockReturnValue(undefined);
  vi.spyOn(lifecycle, "reports").mockReturnValue([]);
  const retry = vi.spyOn(lifecycle, "allowCloseRetry").mockImplementation(() => {});
  return { facade: new ShutdownCoordinator(lifecycle), close, disposition, retry };
}

it("reports the committed device receipt and forwards close and retry", async () => {
  const { facade, close, disposition, retry } = fixture();
  const receipt = { stopConfirmed: true, journalCommitted: true, faultIds: ["resolved-fault"] };
  disposition.mockReturnValue(receipt);
  const report = await facade.close("shutdown");
  expect(report.blocker).toBe(false);
  expect(report.device).toEqual(receipt);
  expect(close).toHaveBeenCalledExactlyOnceWith("close");
  facade.allowCloseRetry();
  expect(retry).toHaveBeenCalledOnce();
});

it("reports the R1 no-evidence receipt on a permitted update", async () => {
  const { facade, close, disposition } = fixture();
  const receipt: JournalDisposition = {
    stopConfirmed: true,
    journalCommitted: false,
    faultIds: [],
    reason: "journal-unavailable-no-evidence",
  };
  disposition.mockReturnValue(receipt);
  const report = await facade.close("update");
  expect(report.blocker).toBe(false);
  expect(report.device).toEqual(receipt);
  expect(close).toHaveBeenCalledExactlyOnceWith("update");
});

it("reports a blocked close without confirming stop or journal commit", async () => {
  const { facade, close } = fixture();
  close.mockRejectedValueOnce(new Error("actual exit pending"));
  const report = await facade.close("update");
  expect(report.blocker).toBe(true);
  expect(report.device).toEqual({ stopConfirmed: false, journalCommitted: false, faultIds: [] });
});

it("retains fault IDs from a blocked device disposition", async () => {
  const { facade, close } = fixture();
  const receipt = { stopConfirmed: false, journalCommitted: true, faultIds: ["stop-fault"] };
  close.mockRejectedValueOnce(new CleanupBlocked(receipt, []));
  const report = await facade.close("shutdown");
  expect(report.blocker).toBe(true);
  expect(report.device).toEqual(receipt);
});
