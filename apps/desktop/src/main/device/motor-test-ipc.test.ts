import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));
import { registerIpc } from "../ipc.js";
import { UpdateOperationGate, type UpdateService } from "../updates/service.js";

describe("retired motor test IPC", () => {
  it("registers no private motor route while preserving monitor and trusted core stop", () => {
    handlers.clear();
    const renderer = { id: 1, mainFrame: {}, once: vi.fn() };
    const updates = { preparing: true } as UpdateService;
    registerIpc(
      () => renderer as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      updates,
      new UpdateOperationGate(() => updates),
      undefined,
      undefined,
      { monitor: {} as never, lab: {} as never },
    );
    for (const name of ["start", "stop", "keepalive", "state"])
      expect(handlers.has(`device:motor-test-${name}`)).toBe(false);
    for (const name of [
      "device:stop",
      "device:monitor",
      "device:watch-monitor",
      "sensor-lab:start",
      "device:files-prepare",
    ])
      expect(handlers.has(name)).toBe(true);
  });
});
