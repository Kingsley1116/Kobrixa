import { beforeEach, describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));
import { registerIpc } from "../ipc.js";

beforeEach(() => handlers.clear());
describe("retained core battery IPC", () => {
  it("validates the sender, session and demand without exposing feature monitor or mode routes", async () => {
    const renderer = { id: 1, mainFrame: {}, once: vi.fn() };
    const monitor = { watch: vi.fn(async () => ({ status: "paused" })) };
    registerIpc(
      () => renderer as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { run: (_: string, work: () => unknown) => work() } as never,
      undefined,
      undefined,
      { monitor: monitor as never },
    );
    const event = { sender: renderer, senderFrame: renderer.mainFrame };
    const context = handlers.get("collab:device-control-context")!(event) as { document: string };
    await handlers.get("collab:set-device-control")!(event, {
      document: context.document,
      sequence: 1,
      state: "local",
      roomId: null,
      connected: true,
      synced: true,
      role: null,
      isHolder: true,
    });
    const id = "01a105ef-2540-78c2-a13e-e255f0b4b1a6";
    const watch = handlers.get("device:watch-monitor")!;
    expect(() => watch({ ...event, senderFrame: {} }, id, true)).toThrow("untrusted");
    expect(() => watch({ ...event, sender: { id: 2 } }, id, true)).toThrow("untrusted");
    expect(() => watch(event, "invalid", true)).toThrow();
    for (const enabled of [0, 1, "true", null, undefined])
      expect(() => watch(event, id, enabled)).toThrow();
    expect(monitor.watch).not.toHaveBeenCalled();
    await expect(watch(event, id, true)).resolves.toEqual({ status: "paused" });
    await watch(event, id, false);
    expect(monitor.watch.mock.calls).toEqual([
      [id, true],
      [id, false],
    ]);
    for (const channel of ["device:monitor", "device:input-modes", "device:set-input-mode"])
      expect(handlers.has(channel), channel).toBe(false);
  });
});
