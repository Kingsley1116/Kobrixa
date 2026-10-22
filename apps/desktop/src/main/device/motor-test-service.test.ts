import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MotionSnapshot } from "@kobrixa/plugin-protocol";
import { MotorTestService, type MotorBrokerBindings } from "./motor-test-service.js";
it("F05 stop before prepare response prevents late start and uses the original operation ID", async () => {
  let ready!: (value: { operation: MotionSnapshot }) => void;
  const operation = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    phase: "stopped",
    angle: null,
    displacement: null,
    elapsedMs: 0,
  } as MotionSnapshot;
  const call = vi.fn(async (method: string) =>
    method === "devices/motion/prepare"
      ? new Promise<{ operation: MotionSnapshot }>((resolve) => {
          ready = resolve;
        })
      : { operation },
  );
  const bindings = {
    call,
    prepare: () => ({
      sessionId: operation.sessionId,
      contextRef: randomUUID(),
      motionScopeRef: randomUUID(),
      motion: {
        actuatorId: randomUUID(),
        mode: "timed",
        power: 10,
        direction: 1,
        brake: true,
        durationMs: 100,
      },
    }),
    pulse: vi.fn(),
    hasBlocker: () => false,
  } as unknown as MotorBrokerBindings;
  const service = new MotorTestService({ bindings, publish() {} });
  const request = {
    sessionId: operation.sessionId,
    testId: randomUUID(),
    port: 0,
    mode: "timed" as const,
    power: 10,
    direction: 1 as const,
    brake: true,
    durationMs: 100,
  };
  service.start(request, 1);
  await Promise.resolve();
  const stopping = service.stop(request, 1);
  ready({ operation });
  await stopping;
  expect(call.mock.calls.map(([method]) => method)).not.toContain("devices/motion/start");
  expect(call.mock.calls.some(([method]) => method === "devices/motion/stop")).toBe(true);
});
it("F11 no real UI binding means unavailable; reconnected never rewrites uncertainty", () => {
  const service = new MotorTestService({ publish() {} });
  expect(() =>
    service.start(
      {
        sessionId: randomUUID(),
        testId: randomUUID(),
        port: 0,
        mode: "jog",
        power: 10,
        direction: 1,
        brake: true,
      },
      1,
    ),
  ).toThrow("unavailable");
  expect(service.getState().phase).toBe("idle");
});
it("T5fix stopAll and flush ignore an already-terminal retained operation after eviction", async () => {
  const operation = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    phase: "completed",
    angle: null,
    displacement: null,
    elapsedMs: 0,
  } as MotionSnapshot;
  const call = vi.fn(async (method: string) => {
    if (method === "devices/motion/stop") throw new Error("stale");
    return { operation };
  });
  const bindings = {
    call,
    prepare: () => ({}),
    pulse() {},
    hasBlocker: () => false,
  } as unknown as MotorBrokerBindings;
  const service = new MotorTestService({ bindings, publish() {} });
  service.start(
    {
      sessionId: operation.sessionId,
      testId: randomUUID(),
      port: 0,
      mode: "timed",
      power: 10,
      direction: 1,
      brake: true,
      durationMs: 100,
    },
    1,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(service.busy).toBe(false);
  await expect(service.stopAll()).resolves.toBeUndefined();
  await expect(service.flush()).resolves.toBeUndefined();
  expect(call.mock.calls.map(([method]) => method)).not.toContain("devices/motion/stop");
});
