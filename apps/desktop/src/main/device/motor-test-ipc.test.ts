import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));
import { registerIpc } from "../ipc.js";
import { UpdateOperationGate, type UpdateService } from "../updates/service.js";

describe("motor test IPC", () => {
  it("validates requests and binds control to the trusted renderer", async () => {
    const renderer = { id: 1, mainFrame: {} };
    const motors = {
      start: vi.fn(),
      stop: vi.fn(),
      keepAlive: vi.fn(),
      getState: vi.fn(),
      flush: vi.fn(),
    };
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
      { monitor: {} as never, lab: {} as never, motors: motors as never },
    );
    const event = { sender: renderer, senderFrame: renderer.mainFrame };
    const request = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      testId: "00000000-0000-4000-8000-000000000002",
      port: 0,
      power: 20,
      direction: 1,
      mode: "timed",
      durationMs: 1000,
      brake: true,
    };
    const start = handlers.get("device:motor-test-start")!;
    const stop = handlers.get("device:motor-test-stop")!;
    const ref = { sessionId: request.sessionId, testId: request.testId };
    await expect(start(event, request)).rejects.toThrow("busy");
    await stop(event, ref);
    expect(motors.stop).toHaveBeenCalledWith(ref, 1, true);
    (updates as { preparing: boolean }).preparing = false;
    for (const patch of [
      { port: 4 },
      { power: 101 },
      { direction: 0 },
      { durationMs: Infinity },
      { sessionId: "bad" },
      { extra: true },
    ])
      await expect(start(event, { ...request, ...patch })).rejects.toThrow();
    expect(motors.start).not.toHaveBeenCalled();
    expect(() => start({ ...event, senderFrame: {} }, request)).toThrow("untrusted");
    expect(() => stop({ ...event, sender: { id: 2 } }, ref)).toThrow("untrusted");
    await start(event, request);
    expect(motors.start).toHaveBeenCalledWith(request, 1);
  });
});
