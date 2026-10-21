import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { startPrimary, type PrimaryHost } from "./profile-writer-lock.js";
function host(primary: boolean) {
  const events = new EventEmitter();
  let held = primary;
  const app: PrimaryHost = {
    requestSingleInstanceLock: vi.fn(() => primary), hasSingleInstanceLock: () => held,
    whenReady: vi.fn(async () => {}), quit: vi.fn(),
    on: (name, listener) => { events.on(name, listener); },
  };
  return { app, events, release: () => { held = false; } };
}
it("F17/F20 secondary never starts a writer, provider, plugin, worker or whenReady callback", async () => {
  const f = host(false); const start = vi.fn(async () => {}); const focus = vi.fn();
  expect(startPrimary(f.app, start, focus)).toBeNull();
  await Promise.resolve();
  expect(f.app.whenReady).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(f.app.quit).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled();
});
it("coalesces second-instance requests before ready, ignores arguments and focuses once", async () => {
  const f = host(true); const focus = vi.fn(() => false); const start = vi.fn(async () => {});
  const primary = startPrimary(f.app, start, focus)!;
  f.events.emit("second-instance", {}, ["--plugin-dev-dir=/untrusted"], "/untrusted");
  f.events.emit("second-instance", {}, ["--plugin-python=/untrusted"], "/untrusted");
  await primary.ready;
  expect(start).toHaveBeenCalledExactlyOnceWith(primary.profile);
  focus.mockReturnValue(true); primary.windowReady();
  expect(focus).toHaveBeenCalledTimes(3);
  primary.windowReady(); expect(focus).toHaveBeenCalledTimes(3);
  f.events.emit("second-instance", {}, [], ""); expect(focus).toHaveBeenCalledTimes(4);
});
it("keeps one epoch/object alive until actual process quit, not a failed close", async () => {
  const f = host(true); const received: unknown[] = [];
  const primary = startPrimary(f.app, async (profile) => { received.push(profile, profile); }, () => false)!;
  await primary.ready;
  expect(received[0]).toBe(primary.profile); expect(received[1]).toBe(primary.profile);
  expect(primary.profile.hostEpoch).toMatch(/^[0-9a-f-]{14}4[0-9a-f-]+$/);
  expect(() => primary.profile.assertHeld()).not.toThrow();
  f.events.emit("before-quit", {}); expect(() => primary.profile.assertHeld()).not.toThrow();
  f.events.emit("quit"); expect(() => primary.profile.assertHeld()).toThrow("profile");
});
it("assertHeld also detects unexpected Electron lock loss", async () => {
  const f = host(true); const primary = startPrimary(f.app, async () => {}, () => false)!;
  await primary.ready; f.release(); expect(() => primary.profile.assertHeld()).toThrow("profile");
});
import { createQuitRecovery } from "./quit.js";
it("F17 second launch reopens a blocked primary's missing recovery window without another writer", async () => {
  const f = host(true); let visible = false;
  const open = vi.fn(() => { visible = true; });
  const recovery = createQuitRecovery({ focus: () => visible, open, retry: async () => false, quit: f.app.quit });
  const start = vi.fn(async () => {});
  const primary = startPrimary(f.app, start, recovery.focus)!;
  await primary.ready;
  await recovery.blocked(new Error("unknown stop disposition"));
  expect(open).toHaveBeenCalledOnce();
  visible = false;
  f.events.emit("second-instance", {}, ["--plugin-dev-dir=/untrusted"], "/untrusted");
  expect(open).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledOnce();
  expect(() => primary.profile.assertHeld()).not.toThrow();
  expect(f.app.quit).not.toHaveBeenCalled();
});
