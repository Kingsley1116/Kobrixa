import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { installPluginQuitCleanup } from "./quit.js";
afterEach(() => vi.useRealTimers());
function host() {
  const emitter = new EventEmitter(),
    quit = vi.fn();
  const fire = () => {
    const event = { preventDefault: vi.fn() };
    emitter.emit("will-quit", event);
    return event;
  };
  return { app: { on: emitter.on.bind(emitter), quit }, quit, fire };
}
it("waits for complete disposition even with no active plugin process", async () => {
  const h = host();
  let finish!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  installPluginQuitCleanup(h.app, cleanup, vi.fn());
  expect(h.fire().preventDefault).toHaveBeenCalledOnce();
  h.fire();
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(h.quit).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(h.quit).toHaveBeenCalledOnce());
  expect(h.fire().preventDefault).not.toHaveBeenCalled();
});
it("F17 25 seconds without disposition blocks quit and does not force exit", async () => {
  vi.useFakeTimers();
  const h = host(),
    blocked = vi.fn();
  installPluginQuitCleanup(h.app, () => new Promise(() => {}), blocked);
  h.fire();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(blocked).toHaveBeenCalledOnce();
  expect(h.quit).not.toHaveBeenCalled();
  expect(h.fire().preventDefault).toHaveBeenCalledOnce();
});
it("does not swallow failed stop, save, journal or process exit", async () => {
  for (const message of ["stop", "save", "journal", "process"]) {
    const h = host(),
      blocked = vi.fn();
    installPluginQuitCleanup(
      h.app,
      async () => {
        throw new Error(message);
      },
      blocked,
    );
    h.fire();
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
    expect(h.quit).not.toHaveBeenCalled();
  }
});
it("permits explicit retry after timeout without letting late completion quit", async () => {
  vi.useFakeTimers();
  const h = host();
  let finish!: () => void;
  const cleanup = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  installPluginQuitCleanup(h.app, cleanup, vi.fn());
  h.fire();
  await vi.advanceTimersByTimeAsync(25_000);
  h.fire();
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(h.quit).toHaveBeenCalledOnce();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.quit).toHaveBeenCalledOnce();
});
