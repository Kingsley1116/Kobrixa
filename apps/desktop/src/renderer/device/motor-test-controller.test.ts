import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotorTestRef, MotorTestRequest, MotorTestState } from "../../shared/motor-test.js";
import { MotorTestController } from "./motor-test-controller.js";
import { motorStopConfirmed, motorTestNumbers } from "./motor-test-controls.js";

const idle = (): MotorTestState => ({
  phase: "idle",
  angle: null,
  displacement: null,
  elapsedMs: 0,
});
const state = (request: MotorTestRequest, phase: MotorTestState["phase"]): MotorTestState => ({
  ...idle(),
  request,
  phase,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const options = { port: 0, power: 20, direction: 1 as const, mode: "jog" as const, brake: true };
function setup() {
  let listener = (_state: MotorTestState): void => {};
  let request: MotorTestRequest;
  const api = {
    startMotorTest: vi.fn(async (next: MotorTestRequest) => {
      request = next;
      return state(next, "running");
    }),
    keepMotorTestAlive: vi.fn(async (_ref: MotorTestRef) => {}),
    stopMotorTest: vi.fn(async (_ref: MotorTestRef, _brake?: boolean) => state(request, "stopped")),
    motorTestState: vi.fn(async () => idle()),
    onMotorTest: vi.fn((next: (value: MotorTestState) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = () => {};
      };
    }),
  };
  const controller = new MotorTestController(api);
  controller.configure("ev3", true);
  return { api, controller, emit: (value: MotorTestState) => listener(value) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("motor test user intent", () => {
  it("keeps the new subscription when disposal and reinitialization overlap", async () => {
    const { api, controller, emit } = setup();
    await controller.initialize();
    const disposal = controller.dispose();
    controller.configure("ev3", true);
    await controller.initialize();
    await disposal;
    api.startMotorTest.mockImplementationOnce(async (request) => state(request, "preparing"));
    await controller.start(options);
    const request = controller.getSnapshot().request!;
    emit(state(request, "running"));
    expect(controller.getSnapshot().phase).toBe("running");
    api.stopMotorTest.mockResolvedValueOnce(state(request, "stopped"));
    await controller.stop();
  });
  it("keeps a rejected start unconfirmed when stop cannot find its ownership", async () => {
    const { api, controller } = setup();
    api.startMotorTest.mockRejectedValueOnce(new Error("IPC response lost"));
    api.stopMotorTest.mockResolvedValueOnce(idle());
    await controller.start(options);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unconfirmed",
      message: "IPC response lost",
    });
    expect(api.stopMotorTest).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.keepMotorTestAlive).not.toHaveBeenCalled();
  });
  it("stops the already allocated id when a jog is released during preparation", async () => {
    const { api, controller, emit } = setup();
    await controller.initialize();
    const pending = deferred<MotorTestState>();
    api.startMotorTest.mockImplementationOnce(() => pending.promise);
    const starting = controller.start(options);
    const request = controller.getSnapshot().request!;
    api.stopMotorTest.mockResolvedValueOnce(state(request, "stopped"));
    await controller.releaseJog();
    expect(api.stopMotorTest).toHaveBeenCalledWith(
      { sessionId: request.sessionId, testId: request.testId },
      true,
    );
    pending.resolve(state(request, "running"));
    await starting;
    emit(state(request, "running"));
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().phase).toBe("stopped");
    expect(api.keepMotorTestAlive).not.toHaveBeenCalled();
  });
  it("never queues keepalives and removes them on release", async () => {
    const { api, controller } = setup();
    const pending = deferred<void>();
    api.keepMotorTestAlive.mockReturnValueOnce(pending.promise);
    await controller.start(options);
    await vi.advanceTimersByTimeAsync(650);
    expect(api.keepMotorTestAlive).toHaveBeenCalledTimes(1);
    await controller.releaseJog();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(650);
    expect(api.keepMotorTestAlive).toHaveBeenCalledTimes(1);
  });
  it("uses selected coasting for a normal release and escalates an in-flight release to brake", async () => {
    const { api, controller } = setup();
    await controller.start({ ...options, brake: false });
    const pending = deferred<MotorTestState>();
    api.stopMotorTest.mockReturnValueOnce(pending.promise);
    const released = controller.releaseJog();
    const forced = controller.stop();
    expect(api.stopMotorTest.mock.calls.map((call) => call[1])).toEqual([false, true]);
    pending.resolve(state(controller.getSnapshot().request!, "stopped"));
    await Promise.all([released, forced]);
    expect(controller.getSnapshot().phase).toBe("stopped");
  });
  it("does not publish an earlier test or connection's delayed result", async () => {
    const { api, controller, emit } = setup();
    await controller.initialize();
    const pending = deferred<MotorTestState>();
    api.startMotorTest.mockImplementationOnce(() => pending.promise);
    const starting = controller.start(options);
    const old = controller.getSnapshot().request!;
    api.stopMotorTest.mockResolvedValueOnce(state(old, "stopped"));
    await controller.stop();
    controller.configure("new", true);
    await controller.start(options);
    const next = controller.getSnapshot().request!;
    pending.resolve(state(old, "completed"));
    await starting;
    emit(state(old, "completed"));
    expect(controller.getSnapshot().request).toEqual(next);
    expect(controller.getSnapshot().phase).toBe("running");
    await controller.stop();
  });
  it("stops on hidden view, connection replacement, and disposal", async () => {
    for (const action of ["hidden", "reconnect", "dispose"] as const) {
      const { api, controller } = setup();
      await controller.start({ ...options, mode: "timed", durationMs: 1_000 });
      if (action === "hidden") controller.configure("ev3", false);
      else if (action === "reconnect") controller.configure("new", true);
      else await controller.dispose();
      expect(api.stopMotorTest).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "ev3" }),
        true,
      );
    }
  });
  it("keeps an unconfirmed stop visible and blocks draining until a retry succeeds", async () => {
    const { api, controller } = setup();
    await controller.start(options);
    api.stopMotorTest.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(controller.drain()).rejects.toThrow("Disconnected");
    expect(controller.getSnapshot().phase).toBe("unconfirmed");
    expect(motorStopConfirmed(controller.getSnapshot())).toBe(false);
    await controller.drain();
    expect(controller.getSnapshot().phase).toBe("stopped");
  });
  it("does not let a pending state query replace a newly started test", async () => {
    const { api, controller } = setup();
    const pending = deferred<MotorTestState>();
    api.motorTestState.mockReturnValue(pending.promise);
    const initial = controller.initialize();
    await controller.start(options);
    pending.resolve(idle());
    await initial;
    expect(controller.getSnapshot().phase).toBe("running");
    await controller.stop();
  });
  it("rejects non-finite, blank, fractional-power and out-of-range UI inputs", () => {
    expect(motorTestNumbers("20", "1", "90")).toEqual({
      power: 20,
      durationMs: 1_000,
      degrees: 90,
    });
    for (const value of ["", " ", "NaN", "Infinity", "0", "101", "1.5"])
      expect(motorTestNumbers(value, "1", "90")).toBeUndefined();
    expect(motorTestNumbers("20", "0.09", "90")).toBeUndefined();
    expect(motorTestNumbers("20", "5.01", "90")).toBeUndefined();
    expect(motorTestNumbers("20", "1", "3601")).toBeUndefined();
  });
});
