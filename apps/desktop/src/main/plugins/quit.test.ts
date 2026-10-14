import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { installPluginQuitCleanup } from "./quit.js";

afterEach(() => vi.useRealTimers());
function host() {
  const emitter = new EventEmitter();
  const quit = vi.fn();
  const willQuit = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    emitter.emit("will-quit", event);
    return event.prevented;
  };
  return { app: { on: emitter.on.bind(emitter), quit } as never, quit, willQuit };
}

it("holds the first quit until plugin shutdown finishes, then quits again", async () => {
  const { app, quit, willQuit } = host();
  let finish!: () => void;
  const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  installPluginQuitCleanup(app, { active: true, shutdown });
  expect(willQuit()).toBe(true);
  expect(willQuit()).toBe(true); // A second request during cleanup is still held.
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(quit).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  expect(willQuit()).toBe(false);
});

it("never quits before shutdown's own deadline, but still quits if shutdown hangs", async () => {
  vi.useFakeTimers();
  const { app, quit, willQuit } = host();
  installPluginQuitCleanup(app, { active: true, shutdown: () => new Promise(() => {}) });
  expect(willQuit()).toBe(true);
  await vi.advanceTimersByTimeAsync(4_000); // PLUGIN_SHUTDOWN_DEADLINE_MS: force kill is due here.
  expect(quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(quit).toHaveBeenCalledTimes(1);
});

it("does not delay quitting without active plugins", () => {
  const idle = host();
  const shutdown = vi.fn(async () => {});
  installPluginQuitCleanup(idle.app, { active: false, shutdown });
  expect(idle.willQuit()).toBe(false);
  expect(shutdown).not.toHaveBeenCalled();
});
