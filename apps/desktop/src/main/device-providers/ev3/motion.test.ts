import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { DeviceSession, MotorTestReading } from "@kobrixa/device";
import type {
  ProviderCleanupContext,
  ProviderOperationContext,
} from "../../device-broker/provider.js";
import { Ev3MotionEngine } from "./motion.js";
const idle = (): MotorTestReading => ({
  sampledAt: 1,
  programStopped: true,
  outputs: Array.from({ length: 4 }, (_, port) => ({
    port,
    type: 7,
    angle: 0,
    busy: false,
    speed: 0,
  })),
});
export function context(): ProviderOperationContext & {
  stop: { requested: boolean; brakeRequired: boolean };
} {
  const stop = { requested: false, brakeRequired: false };
  return {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    providerGeneration: 1,
    operationClass: "finite-motion",
    cancellation: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30000,
    now: () => performance.now(),
    stop,
    assertContinuation() {
      if (stop.requested) throw new Error("cancelled");
    },
    shouldYield: () => false,
    stopState: () => stop,
    exchange: async (_step, invoke) => invoke(new AbortController().signal, 2000),
    publishProgress: vi.fn(),
    requestSafetyStop() {
      stop.requested = true;
      stop.brakeRequired = true;
    },
  };
}
function session() {
  return {
    readMotorTest: vi.fn(async () => idle()),
    upload: vi.fn(async () => {}),
    runMotorHelper: vi.fn(async () => {}),
    readMotorHelper: vi.fn(async () => ({ owned: true, state: 0, result: 0, angle: 0 })),
    armMotorHelper: vi.fn(async () => {}),
    motorTimed: vi.fn<DeviceSession["motorTimed"]>(async () => {}),
    motorStop: vi.fn<DeviceSession["motorStop"]>(async () => {}),
    stopMotorHelper: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}
afterEach(() => vi.useRealTimers());
it.each(["upload", "ready"])("F05/A-RF1 stop after %s prevents helper arm", async (point) => {
  const ctx = context(),
    s = session(),
    engine = new Ev3MotionEngine();
  if (point === "upload")
    s.upload.mockImplementation(async () => {
      ctx.stop.requested = true;
    });
  else
    s.readMotorHelper.mockImplementation(async () => {
      ctx.stop.requested = true;
      return { owned: true, state: 0, result: 0, angle: 0 };
    });
  await expect(
    engine.execute(
      0,
      {
        mode: "relative-angle",
        actuatorId: randomUUID(),
        power: 20,
        direction: 1,
        degrees: 90,
        brake: false,
      },
      ctx,
      () => s as unknown as DeviceSession,
    ),
  ).rejects.toThrow();
  expect(s.armMotorHelper).not.toHaveBeenCalled();
  expect(s.motorTimed).not.toHaveBeenCalled();
});
it("F08 requires all four outputs, waits at most five readings and preserves forced brake", async () => {
  vi.useFakeTimers();
  const s = session(),
    engine = new Ev3MotionEngine();
  let brake = false,
    reads = 0;
  s.readMotorTest.mockImplementation(async () => {
    reads++;
    brake = true;
    const value = idle();
    value.outputs[3]!.speed = 1;
    return value;
  });
  const ctx: ProviderCleanupContext = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    providerGeneration: 1,
    signal: new AbortController().signal,
    deadlineMonotonicMs: 15000,
    now: () => 0,
    brakeRequired: () => brake,
    assertCleanup() {},
    exchange: async (_step, invoke) => invoke(new AbortController().signal, 2000),
  };
  const pending = engine.stop(
    { kind: "current-device" },
    ctx,
    () => s as unknown as DeviceSession,
    (port) => String(port),
  );
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(reads).toBe(5);
  expect(result.outputs[3]!.speed).toBe(1);
  expect(s.motorStop.mock.calls.some((call) => call[1] === true)).toBe(true);
});
it.each([399, 400, 401])("F06 jog never revives after a %i ms send gap", async (gap) => {
  vi.useFakeTimers();
  const s = session(),
    engine = new Ev3MotionEngine(),
    ctx = context();
  let now = 0,
    pulses = 0;
  ctx.now = () => now;
  s.motorTimed.mockImplementation(async () => {
    pulses++;
    if (pulses > 1) ctx.stop.requested = true;
  });
  s.readMotorTest.mockImplementation(async () => {
    if (pulses) now = gap;
    return idle();
  });
  const pending = engine.execute(
    0,
    { mode: "jog", actuatorId: randomUUID(), power: 20, direction: 1, brake: false },
    ctx,
    () => s as unknown as DeviceSession,
  );
  const result = pending.catch(() => null);
  await vi.runAllTimersAsync();
  await result;
  expect(pulses).toBe(gap < 400 ? 2 : 1);
});
it.each(["unknown-type", "speed-null", "moving", "program"])(
  "F08 preflight rejects %s before helper upload or pulse",
  async (invalid) => {
    const s = session(),
      ctx = context(),
      engine = new Ev3MotionEngine(),
      value = idle();
    if (invalid === "unknown-type") value.outputs[3]!.type = 125;
    if (invalid === "speed-null") value.outputs[3]!.speed = null;
    if (invalid === "moving") value.outputs[3]!.speed = 1;
    if (invalid === "program") value.programStopped = false;
    s.readMotorTest.mockResolvedValue(value);
    await expect(
      engine.execute(
        0,
        {
          mode: "timed",
          actuatorId: randomUUID(),
          power: 20,
          direction: 1,
          durationMs: 100,
          brake: true,
        },
        ctx,
        () => s as unknown as DeviceSession,
      ),
    ).rejects.toThrow();
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.motorTimed).not.toHaveBeenCalled();
  },
);
it("F08 foreign helper token never authorizes stopping another running program", async () => {
  const s = session(),
    ctx = context(),
    engine = new Ev3MotionEngine();
  s.readMotorHelper.mockImplementation(async () => {
    ctx.stop.requested = true;
    return { owned: true, state: 0, result: 0, angle: 0 };
  });
  await expect(
    engine.execute(
      0,
      {
        mode: "relative-angle",
        actuatorId: randomUUID(),
        power: 20,
        direction: 1,
        degrees: 90,
        brake: true,
      },
      ctx,
      () => s as unknown as DeviceSession,
    ),
  ).rejects.toThrow();
  s.stopMotorHelper.mockResolvedValue(false);
  s.readMotorTest.mockResolvedValue({ ...idle(), programStopped: false });
  const cleanup: ProviderCleanupContext = {
    operationId: ctx.operationId,
    sessionId: ctx.sessionId,
    providerGeneration: 1,
    signal: new AbortController().signal,
    deadlineMonotonicMs: 15000,
    now: () => 0,
    brakeRequired: () => true,
    assertCleanup() {},
    exchange: async (_step, invoke) => invoke(new AbortController().signal, 2000),
  };
  await expect(
    engine.stop(
      { kind: "operation", operationId: ctx.operationId },
      cleanup,
      () => s as unknown as DeviceSession,
      (port) => String(port),
    ),
  ).rejects.toThrow("readback-failed");
  expect(s.stop).not.toHaveBeenCalled();
  expect(s.motorStop).not.toHaveBeenCalled();
});
