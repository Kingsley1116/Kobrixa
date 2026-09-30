import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "../../shared/api.js";
import { LiveDiagnostics } from "./live-diagnostics.js";

function harness() {
  const requests: Array<{
    resolve(items: Diagnostic[]): void;
    reject(error: unknown): void;
  }> = [];
  const callbacks = {
    cancel: vi.fn(),
    check: vi.fn(
      (_workspaceId: string, _overlays: Record<string, string>) =>
        new Promise<Diagnostic[]>((resolve, reject) => requests.push({ resolve, reject })),
    ),
    onDiagnostics: vi.fn(),
    onChecking: vi.fn(),
    onError: vi.fn(),
  };
  return { checker: new LiveDiagnostics(callbacks), callbacks, requests };
}

describe("live diagnostics scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a pause during repeated Enter and Backspace edits", async () => {
    const { checker, callbacks } = harness();
    for (const content of ["LCD.Clear()", "LCD.Clear()\n", "LCD.Clear()", "LCD.Clear()\n\n"]) {
      checker.schedule("one", { "main.bp": content });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(callbacks.check).not.toHaveBeenCalled();
    expect(callbacks.onChecking).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(callbacks.check).toHaveBeenCalledExactlyOnceWith("one", {
      "main.bp": "LCD.Clear()\n\n",
    });
  });

  it("does not overlap slow checks and discards superseded edits", async () => {
    const { checker, callbacks, requests } = harness();
    checker.schedule("one", { "main.bp": "old" });
    await vi.advanceTimersByTimeAsync(500);
    checker.schedule("one", { "main.bp": "intermediate" });
    await vi.advanceTimersByTimeAsync(500);
    checker.schedule("one", { "main.bp": "latest" });
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.check).toHaveBeenCalledTimes(1);
    requests[0]!.resolve([]);
    expect(callbacks.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onDiagnostics).not.toHaveBeenCalled();
    expect(callbacks.check).toHaveBeenCalledTimes(2);
    expect(callbacks.check).toHaveBeenLastCalledWith("one", { "main.bp": "latest" });
    requests[1]!.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onDiagnostics).toHaveBeenCalledExactlyOnceWith([]);
    expect(callbacks.onChecking).toHaveBeenLastCalledWith(false);
  });

  it("keeps waiting for the latest edit if an older check completes before the debounce", async () => {
    const { checker, callbacks, requests } = harness();
    checker.schedule("one", { "main.bp": "old" });
    await vi.advanceTimersByTimeAsync(500);
    checker.schedule("one", { "main.bp": "new" });
    requests[0]!.resolve([]);
    await vi.advanceTimersByTimeAsync(499);
    expect(callbacks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.check).toHaveBeenCalledTimes(2);
  });

  it("ignores an old workspace failure and continues checking the new workspace", async () => {
    const { checker, callbacks, requests } = harness();
    checker.schedule("one", {});
    await vi.advanceTimersByTimeAsync(500);
    checker.cancel();
    checker.schedule("two", {});
    await vi.advanceTimersByTimeAsync(500);
    requests[0]!.reject(new Error("old workspace closed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.check).toHaveBeenLastCalledWith("two", {});
    const error = new Error("current failure");
    requests[1]!.reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(callbacks.onChecking).toHaveBeenLastCalledWith(false);
  });

  it("cancels queued work and never publishes a result after cancellation", async () => {
    const { checker, callbacks, requests } = harness();
    checker.schedule("one", {});
    checker.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.check).not.toHaveBeenCalled();
    checker.schedule("one", {});
    await vi.advanceTimersByTimeAsync(500);
    checker.cancel();
    requests[0]!.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onDiagnostics).not.toHaveBeenCalled();
    expect(callbacks.onChecking).toHaveBeenLastCalledWith(false);
  });
});
