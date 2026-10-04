import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));
import { registerIpc } from "../ipc.js";

describe("monitor IPC", () => {
  it("validates privileged monitor requests before accessing the device", () => {
    const renderer = { id: 1, mainFrame: {} };
    const service = { monitor: vi.fn(), inputModes: vi.fn(), setInputMode: vi.fn() };
    registerIpc(
      () => renderer as never,
      {} as never,
      {} as never,
      {} as never,
      service as never,
      {} as never,
      { run: (_: string, work: () => unknown) => work() } as never,
    );
    const event = { sender: renderer, senderFrame: renderer.mainFrame };
    const id = "01a105ef-2540-78c2-a13e-e255f0b4b1a6";
    const monitor = handlers.get("device:monitor")!;
    const modes = handlers.get("device:input-modes")!;
    const set = handlers.get("device:set-input-mode")!;
    for (const fn of [monitor, modes, set]) {
      expect(() => fn({ ...event, senderFrame: {} }, id, 0, 29, 1)).toThrow("untrusted");
      expect(() => fn({ ...event, sender: { id: 2 } }, id, 0, 29, 1)).toThrow("untrusted");
      expect(() => fn(event, "invalid", 0, 29, 1)).toThrow();
    }
    for (const port of [-1, 4, 0.5, "1", null]) expect(() => modes(event, id, port, 29)).toThrow();
    for (const type of [-1, 0, 128, NaN, "29"]) expect(() => modes(event, id, 0, type)).toThrow();
    for (const mode of [-1, 8, 0.5, "0"]) expect(() => set(event, id, 0, 29, mode)).toThrow();
    expect(service.monitor).not.toHaveBeenCalled();
    expect(service.inputModes).not.toHaveBeenCalled();
    expect(service.setInputMode).not.toHaveBeenCalled();
    monitor(event, id);
    modes(event, id, 0, 29);
    set(event, id, 0, 29, 1);
    expect(service.monitor).toHaveBeenCalledWith(id);
    expect(service.inputModes).toHaveBeenCalledWith(id, 0, 29);
    expect(service.setInputMode).toHaveBeenCalledWith(id, 0, 29, 1);
  });
});
