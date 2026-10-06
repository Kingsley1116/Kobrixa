import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceDescriptor, DeviceSession, MotorTestReading } from "@kobrixa/device";
import type { MotorTestRequest, MotorTestState } from "../../shared/motor-test.js";
import { MotorTestService, motorTestRequestSchema } from "./motor-test-service.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const testId = "00000000-0000-4000-8000-000000000002";
const request: MotorTestRequest = {
  sessionId,
  testId,
  port: 0,
  mode: "timed",
  power: 20,
  direction: 1,
  brake: true,
  durationMs: 1000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(
  descriptor: DeviceDescriptor = {
    id: "usb",
    name: "EV3",
    transport: "usb",
    serialNumber: "brick-1",
  },
) {
  let running = false,
    programStopped = true,
    recording = false;
  let helper = { owned: true, state: 0, result: 0, angle: 10 as number | null };
  const read = (): MotorTestReading => ({
    sampledAt: Date.now(),
    programStopped,
    outputs: [0, 1, 2, 3].map((port) => ({
      port,
      type: 7,
      angle: 10,
      busy: port === 0 && running,
      speed: running && port === 0 ? 20 : 0,
    })),
  });
  const session = {
    descriptor,
    connected: true,
    readMotorTest: vi.fn<DeviceSession["readMotorTest"]>(async () => read()),
    motorTimed: vi.fn<DeviceSession["motorTimed"]>(async () => {
      running = true;
    }),
    motorStop: vi.fn<DeviceSession["motorStop"]>(async () => {
      running = false;
    }),
    upload: vi.fn<DeviceSession["upload"]>(async () => {}),
    delete: vi.fn<DeviceSession["delete"]>(async () => {}),
    runMotorHelper: vi.fn<DeviceSession["runMotorHelper"]>(async () => {
      programStopped = false;
    }),
    readMotorHelper: vi.fn<DeviceSession["readMotorHelper"]>(async () => helper),
    armMotorHelper: vi.fn<DeviceSession["armMotorHelper"]>(async () => {
      running = true;
      helper = { ...helper, state: 1 };
    }),
    stopMotorHelper: vi.fn<DeviceSession["stopMotorHelper"]>(async () => {
      running = false;
      programStopped = true;
      return helper.owned;
    }),
  };
  const controller = new AbortController();
  const states: MotorTestState[] = [];
  const service = new MotorTestService({
    run: async (_id, work) => work(session as unknown as DeviceSession, controller.signal),
    recording: () => recording,
    publish: (state) => states.push(state),
    now: () => Date.now(),
  });
  return {
    service,
    session,
    states,
    controller,
    read,
    record: () => {
      recording = true;
    },
    program: () => {
      programStopped = false;
    },
    result: (state: number, result: number) => {
      helper = { ...helper, state, result };
    },
    loseOwnership: () => {
      helper = { ...helper, owned: false };
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => {
  vi.useRealTimers();
});
describe("motor test orchestration", () => {
  it("does not start after release during preparation", async () => {
    const h = setup(),
      gate = deferred<MotorTestReading>();
    h.session.readMotorTest.mockReturnValueOnce(gate.promise);
    h.service.start(request, 1);
    const stop = h.service.stop(request, 1);
    gate.resolve(h.read());
    await stop;
    expect(h.session.motorTimed).not.toHaveBeenCalled();
    expect(h.service.getState().phase).toBe("stopped");
  });
  it("rejects bad parameters, recording and a second concurrent test", async () => {
    for (const patch of [
      { power: 101 },
      { port: 4 },
      { power: NaN },
      { durationMs: 0 },
      { degrees: 90 },
      { mode: "angle" },
    ])
      expect(() => motorTestRequestSchema.parse({ ...request, ...patch })).toThrow();
    const h = setup();
    h.service.start(request, 1);
    expect(() => h.service.start(request, 1)).toThrow("in progress");
    await h.service.stopAll();
    h.record();
    expect(() => h.service.start(request, 1)).toThrow("recording");
  });
  it("refuses a running user program without sending a motor command", async () => {
    const h = setup();
    h.program();
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getState().phase).toBe("failed");
    expect(h.session.motorTimed).not.toHaveBeenCalled();
    expect(h.session.motorStop).not.toHaveBeenCalled();
  });
  it("sends one finite timed command and confirms stop", async () => {
    const h = setup();
    h.service.start({ ...request, brake: false }, 1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
    expect(h.session.motorTimed.mock.calls[0]).toEqual([0, 20, 1000, false, h.controller.signal]);
    expect(h.session.motorStop.mock.calls[0]?.slice(0, 2)).toEqual([0, false]);
    expect(h.service.getState().phase).toBe("completed");
    expect(h.service.busy).toBe(false);
  });
  it("expires a held jog when renderer heartbeats stop and never restarts it", async () => {
    const h = setup();
    const jog = { ...request, mode: "jog" as const };
    delete jog.durationMs;
    h.service.start(jog, 1);
    await vi.advanceTimersByTimeAsync(600);
    const count = h.session.motorTimed.mock.calls.length;
    h.service.keepAlive(jog, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.session.motorTimed).toHaveBeenCalledTimes(count);
    expect(h.service.getState().phase).toBe("stopped");
  });
  it("does not let an old id or another owner stop an active test", async () => {
    const h = setup();
    h.service.start(request, 1);
    await expect(h.service.stop(request, 2)).rejects.toThrow("another window");
    await h.service.stop({ ...request, testId: "different" }, 1);
    expect(h.service.busy).toBe(true);
    await h.service.stop(request, 1);
  });
  it("does not arm an angle helper after cancellation during upload", async () => {
    const h = setup(),
      gate = deferred<void>();
    h.session.upload.mockReturnValueOnce(gate.promise);
    const angle = { ...request, mode: "angle" as const, degrees: 90 };
    delete angle.durationMs;
    h.service.start(angle, 1);
    await vi.advanceTimersByTimeAsync(0);
    const stop = h.service.stop(angle, 1);
    gate.resolve();
    await stop;
    expect(h.session.runMotorHelper).not.toHaveBeenCalled();
    expect(h.session.armMotorHelper).not.toHaveBeenCalled();
    expect(h.session.delete).toHaveBeenCalledTimes(1);
  });
  it("reads the helper timeout result then stops it before removing its own file", async () => {
    const h = setup();
    const angle = { ...request, mode: "angle" as const, degrees: 90 };
    delete angle.durationMs;
    h.service.start(angle, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.armMotorHelper).toHaveBeenCalledTimes(1);
    h.result(2, 2);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.service.getState().phase).toBe("timeout");
    expect(h.session.stopMotorHelper.mock.invocationCallOrder[0]).toBeLessThan(
      h.session.delete.mock.invocationCallOrder[0]!,
    );
  });
  it("retains an unconfirmed result on disconnect and does not resume", async () => {
    const h = setup();
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.session.connected = false;
    h.service.disconnected(sessionId);
    h.controller.abort(new Error("Cable removed"));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.service.getState().phase).toBe("unconfirmed");
    await expect(h.service.flush()).rejects.toThrow("not been confirmed");
    expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "unknown-type", "unknown-speed"])(
    "rejects %s output status before driving",
    async (unknown) => {
      const h = setup();
      const reading = h.read();
      if (unknown === "missing") reading.outputs.pop();
      else if (unknown === "unknown-type") reading.outputs[3]!.type = 125;
      else reading.outputs[3]!.speed = null;
      h.session.readMotorTest.mockResolvedValueOnce(reading);
      h.service.start(request, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.service.getState().phase).toBe("failed");
      expect(h.session.motorTimed).not.toHaveBeenCalled();
    },
  );

  it("does not shorten a timed run when its acknowledgement is delayed", async () => {
    const h = setup(),
      gate = deferred<void>();
    h.session.motorTimed.mockReturnValueOnce(gate.promise);
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(1500);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(900);
    expect(h.service.getState().phase).toBe("running");
    expect(h.session.motorStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.service.getState().phase).toBe("completed");
  });

  it("brakes at the jog limit without submitting an invalid short renewal", async () => {
    const h = setup();
    const jog = { ...request, mode: "jog" as const, brake: false };
    delete jog.durationMs;
    h.session.readMotorTest.mockImplementation(async () => {
      if (Date.now() === 19_900) vi.setSystemTime(19_950);
      return h.read();
    });
    h.service.start(jog, 1);
    const heartbeat = setInterval(() => h.service.keepAlive(jog, 1), 100);
    await vi.advanceTimersByTimeAsync(10_100);
    clearInterval(heartbeat);
    expect(h.service.getState().phase).toBe("timeout");
    expect(h.session.motorTimed.mock.calls.every((call) => call[2] >= 100 && call[2] <= 400)).toBe(
      true,
    );
    expect(h.session.motorStop.mock.calls.at(-1)?.[1]).toBe(true);
  });

  it("keeps the angle watchdog's braking even when normal completion would coast", async () => {
    const h = setup();
    const angle = { ...request, mode: "angle" as const, degrees: 90, brake: false };
    delete angle.durationMs;
    h.service.start(angle, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.result(2, 2);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.service.getState().phase).toBe("timeout");
    expect(h.session.stopMotorHelper.mock.calls[0]?.[2]).toBe(true);
  });

  it("upgrades an in-flight coast stop to braking without losing an observed result", async () => {
    const h = setup(),
      gate = deferred<void>();
    const stopMotor = h.session.motorStop.getMockImplementation()!;
    h.session.motorStop.mockImplementationOnce(async (...args) => {
      await gate.promise;
      await stopMotor(...args);
    });
    h.service.start({ ...request, brake: false }, 1);
    await vi.advanceTimersByTimeAsync(1100);
    const stopped = h.service.stop(request, 1, true);
    gate.resolve();
    await stopped;
    expect(h.session.motorStop.mock.calls.map((call) => call[1])).toEqual([false, true]);
    expect(h.service.getState().phase).toBe("completed");
  });

  it("keeps disconnect uncertainty despite a late command reply without an abort", async () => {
    const h = setup(),
      gate = deferred<void>();
    h.session.motorTimed.mockReturnValueOnce(gate.promise);
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.service.disconnected(sessionId);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getState().phase).toBe("unconfirmed");
    expect(
      h.states
        .slice(h.states.findIndex((state) => state.phase === "unconfirmed"))
        .every((state) => state.phase === "unconfirmed"),
    ).toBe(true);
    expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
  });

  it("can retry a terminal unconfirmed stop on the same session", async () => {
    const h = setup();
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.session.motorStop.mockRejectedValueOnce(new Error("Temporary failure"));
    h.session.motorStop.mockRejectedValueOnce(new Error("Temporary failure"));
    await h.service.stop(request, 1);
    expect(h.service.getState().phase).toBe("unconfirmed");
    expect(h.service.busy).toBe(false);
    await h.service.stop(request, 1);
    expect(h.service.getState().phase).toBe("stopped");
    expect(h.session.motorStop).toHaveBeenCalledTimes(3);
    expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
    await expect(h.service.flush()).resolves.toBeUndefined();
  });

  it("waits for a transient kernel busy bit after stop without issuing more drive commands", async () => {
    const h = setup();
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    const stale = h.read();
    h.session.readMotorTest.mockResolvedValueOnce(stale);
    const stopped = h.service.stop(request, 1);
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    expect(h.service.getState().phase).toBe("stopped");
    expect(h.session.motorStop).toHaveBeenCalledTimes(1);
    expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
  });

  it("honors a brake request arriving during helper cleanup and preserves completion", async () => {
    const h = setup(),
      gate = deferred<void>();
    const angle = { ...request, mode: "angle" as const, degrees: 90, brake: false };
    delete angle.durationMs;
    h.session.delete.mockReturnValueOnce(gate.promise);
    h.service.start(angle, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.result(2, 1);
    await vi.advanceTimersByTimeAsync(200);
    const stopped = h.service.stop(angle, 1, true);
    gate.resolve();
    await stopped;
    expect(h.session.stopMotorHelper.mock.calls.map((call) => call[2])).toEqual([false, true]);
    expect(h.service.getState().phase).toBe("completed");
  });

  it("bounds stop readback attempts when the busy bit never clears", async () => {
    const h = setup();
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.session.motorStop.mockImplementation(async () => {});
    const stopped = h.service.stop(request, 1);
    await vi.advanceTimersByTimeAsync(850);
    await stopped;
    expect(h.service.getState().phase).toBe("unconfirmed");
    expect(h.service.busy).toBe(false);
    expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
    expect(h.session.readMotorTest).toHaveBeenCalledTimes(11);
  });

  it.each([
    { id: "old-usb", name: "EV3", transport: "usb", serialNumber: "brick-1" },
    { id: "old-wifi", name: "EV3", transport: "wifi", address: "192.168.1.22" },
  ] satisfies DeviceDescriptor[])(
    "checks the same $transport brick after reconnect without driving it",
    async (descriptor) => {
      const h = setup(descriptor);
      h.service.start(request, 1);
      await vi.advanceTimersByTimeAsync(0);
      h.service.disconnected(sessionId);
      const previous = h.service.getState();
      const idle = h.read();
      idle.outputs.forEach((output) => {
        output.busy = false;
        output.speed = 0;
        output.angle = 500;
      });
      idle.sampledAt += 1000;
      h.session.descriptor = { ...descriptor, id: "new-connection" };
      h.session.readMotorTest.mockResolvedValue(idle);
      // This event intentionally precedes settlement of the old operation.
      await h.service.reconnected("new-session");
      expect(h.service.getState()).toMatchObject({
        phase: "stopped",
        request: previous.request,
        angle: previous.angle,
        displacement: previous.displacement,
        updatedAt: previous.updatedAt,
        message: "EV3 is idle after reconnect; the previous test result is unavailable.",
      });
      expect(h.session.motorTimed).toHaveBeenCalledTimes(1);
      expect(h.session.motorStop).not.toHaveBeenCalled();
      expect(h.session.runMotorHelper).not.toHaveBeenCalled();
      expect(h.session.armMotorHelper).not.toHaveBeenCalled();
      expect(h.session.stopMotorHelper).not.toHaveBeenCalled();
      await expect(h.service.flush()).resolves.toBeUndefined();
    },
  );

  it.each([
    { id: "same-name", name: "EV3", transport: "usb", serialNumber: "other-brick" },
    { id: "same-name", name: "EV3", transport: "usb" },
    { id: "same-name", name: "EV3", transport: "wifi", address: "brick-1" },
  ] satisfies DeviceDescriptor[])(
    "does not infer identity from $transport names or connection ids",
    async (descriptor) => {
      const h = setup();
      h.service.start(request, 1);
      await vi.advanceTimersByTimeAsync(0);
      h.service.disconnected(sessionId);
      await vi.advanceTimersByTimeAsync(0);
      const reads = h.session.readMotorTest.mock.calls.length;
      h.session.descriptor = descriptor;
      await h.service.reconnected("new-session");
      expect(h.service.getState().phase).toBe("unconfirmed");
      expect(h.session.readMotorTest).toHaveBeenCalledTimes(reads);
      expect(h.session.motorStop).not.toHaveBeenCalled();
    },
  );

  it("does not resolve a USB disconnect when the original serial number was unavailable", async () => {
    const h = setup({ id: "usb", name: "EV3", transport: "usb" });
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.service.disconnected(sessionId);
    h.session.descriptor = { id: "usb", name: "EV3", transport: "usb", serialNumber: "brick-1" };
    await h.service.reconnected("new-session");
    expect(h.service.getState().phase).toBe("unconfirmed");
  });

  it.each(["moving", "program", "missing-selected", "read-failed"])(
    "keeps reconnect uncertainty for %s",
    async (condition) => {
      const h = setup();
      h.service.start(request, 1);
      await vi.advanceTimersByTimeAsync(0);
      h.service.disconnected(sessionId);
      await vi.advanceTimersByTimeAsync(0);
      const reading = h.read();
      reading.outputs.forEach((output) => {
        output.busy = false;
        output.speed = 0;
      });
      if (condition === "moving") reading.outputs[3]!.busy = true;
      if (condition === "program") reading.programStopped = false;
      if (condition === "missing-selected") reading.outputs[0]!.angle = null;
      if (condition === "read-failed")
        h.session.readMotorTest.mockRejectedValueOnce(new Error("Cable removed"));
      else h.session.readMotorTest.mockResolvedValueOnce(reading);
      await expect(h.service.reconnected("new-session")).resolves.toBeUndefined();
      expect(h.service.getState().phase).toBe("unconfirmed");
      expect(h.session.motorStop).not.toHaveBeenCalled();
    },
  );

  it("coalesces reconnect notifications and ignores repeats after a successful idle check", async () => {
    const h = setup(),
      gate = deferred<MotorTestReading>();
    h.service.start(request, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.service.disconnected(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    const reads = h.session.readMotorTest.mock.calls.length;
    h.session.readMotorTest.mockReturnValueOnce(gate.promise);
    const first = h.service.reconnected("new-session");
    const duplicate = h.service.reconnected("new-session");
    expect(first).toBe(duplicate);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => h.service.start(request, 1)).toThrow("checked after reconnect");
    const idle = h.read();
    idle.outputs.forEach((output) => {
      output.busy = false;
      output.speed = 0;
    });
    gate.resolve(idle);
    await first;
    await h.service.reconnected("new-session");
    expect(h.session.readMotorTest).toHaveBeenCalledTimes(reads + 1);
    expect(h.service.getState().phase).toBe("stopped");
  });
});
