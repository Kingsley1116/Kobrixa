import { describe, expect, it, vi } from "vitest";
import { MainProcessCloseGuard } from "./main-close.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("main-process close fallback", () => {
  it("waits for the main save and coalesces concurrent close/quit attempts", async () => {
    const saving = deferred();
    const flush = vi.fn(() => saving.promise),
      close = vi.fn(),
      retry = vi.fn(),
      cancel = vi.fn();
    const guard = new MainProcessCloseGuard(flush, close, retry, cancel);
    const first = guard.request(),
      second = guard.request();
    expect(first).toBe(second);
    expect(flush).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(guard.ready).toBe(false);
    saving.resolve();
    await first;
    expect(guard.ready).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    await guard.request();
    expect(close).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
  it("keeps the window open after a failed save and retries only when requested", async () => {
    const error = new Error("Disk full");
    const flush = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const close = vi.fn(),
      retry = vi.fn(async () => false),
      cancel = vi.fn();
    const guard = new MainProcessCloseGuard(flush, close, retry, cancel);
    await guard.request();
    expect(retry).toHaveBeenCalledWith(error);
    expect(flush).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(guard.ready).toBe(false);
    await guard.request();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
  it("waits for the native Retry choice before making another save attempt", async () => {
    let choose!: (retry: boolean) => void;
    const choice = new Promise<boolean>((resolve) => {
      choose = resolve;
    });
    const flush = vi.fn().mockRejectedValueOnce(new Error("Locked")).mockResolvedValue(undefined);
    const close = vi.fn(),
      retry = vi.fn(() => choice),
      cancel = vi.fn();
    const guard = new MainProcessCloseGuard(flush, close, retry, cancel);
    const pending = guard.request();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    choose(true);
    await pending;
    expect(flush).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("does not close when both saving and the native dialog fail", async () => {
    const close = vi.fn(),
      cancel = vi.fn();
    const guard = new MainProcessCloseGuard(
      vi.fn().mockRejectedValue(new Error("Save failed")),
      close,
      vi.fn().mockRejectedValue(new Error("Dialog unavailable")),
      cancel,
    );
    await guard.request();
    expect(guard.ready).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
