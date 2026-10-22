import { expect, it, vi } from "vitest";
import { LifecycleCoordinator } from "../device-broker/lifecycle-coordinator.js";
import { ShutdownCoordinator } from "./shutdown-coordinator.js";
it("forwards close and recovery to the existing coordinator", async () => {
  const close = vi.spyOn(LifecycleCoordinator.prototype, "close").mockResolvedValue();
  const reports = vi.spyOn(LifecycleCoordinator.prototype, "reports").mockReturnValue([]);
  const retry = vi
    .spyOn(LifecycleCoordinator.prototype, "allowCloseRetry")
    .mockImplementation(() => {});
  try {
    const lifecycle: LifecycleCoordinator = Object.create(LifecycleCoordinator.prototype);
    const facade = new ShutdownCoordinator(lifecycle);
    expect(await facade.close("shutdown")).toMatchObject({ blocker: false });
    expect(close).toHaveBeenCalledExactlyOnceWith("close");
    facade.allowCloseRetry();
    expect(retry).toHaveBeenCalledOnce();
    close.mockRejectedValueOnce(new Error("actual exit pending"));
    expect(await facade.close("update")).toMatchObject({ blocker: true });
  } finally {
    close.mockRestore();
    reports.mockRestore();
    retry.mockRestore();
  }
});
