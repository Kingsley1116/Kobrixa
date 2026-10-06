import { randomInt } from "node:crypto";
import { z } from "zod";
import {
  REMOTE_PROJECT_ROOT,
  type DeviceDescriptor,
  type DeviceSession,
  type MotorTestReading,
} from "@kobrixa/device";
import type { MotorTestRef, MotorTestRequest, MotorTestState } from "../../shared/motor-test.js";
import { createMotorTestImage } from "./motor-test-image.js";

export const motorTestRefSchema = z
  .object({ sessionId: z.string().uuid(), testId: z.string().uuid() })
  .strict();
export const motorTestRequestSchema = motorTestRefSchema
  .extend({
    port: z.number().int().min(0).max(3),
    power: z.number().int().min(1).max(100),
    direction: z.union([z.literal(1), z.literal(-1)]),
    mode: z.enum(["jog", "timed", "angle"]),
    brake: z.boolean(),
    durationMs: z.number().int().min(100).max(5000).optional(),
    degrees: z.number().int().min(1).max(3600).optional(),
  })
  .superRefine((request, ctx) => {
    if (
      (request.mode === "timed") !== (request.durationMs !== undefined) ||
      (request.mode === "angle") !== (request.degrees !== undefined)
    )
      ctx.addIssue({ code: "custom", message: "Parameters do not match the motor test mode." });
  });

interface Dependencies {
  run<T>(id: string, work: (session: DeviceSession, signal: AbortSignal) => Promise<T>): Promise<T>;
  recording(): boolean;
  publish(state: MotorTestState): void;
  now?(): number;
}
interface Test {
  request: MotorTestRequest;
  descriptor: DeviceDescriptor | undefined;
  owner: number;
  keepalive: number;
  stop: boolean;
  brake: boolean;
  started: number | undefined;
  origin: number | undefined;
  token: number;
  helperPath: string | undefined;
  helperStarted: boolean;
  issued: boolean;
  disconnected: boolean;
  stopConfirmed: boolean;
  wake: (() => void) | undefined;
  task: Promise<void>;
}

/** Owns one foreground device operation for the complete test, never aborting a read to stop. */
export class MotorTestService {
  private current: Test | undefined;
  private unconfirmedTest: Test | undefined;
  private reconnecting: Promise<void> | undefined;
  private state: MotorTestState = { phase: "idle", angle: null, displacement: null, elapsedMs: 0 };
  private readonly now: () => number;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => performance.now());
  }
  get busy(): boolean {
    return !!this.current;
  }
  getState = (): MotorTestState => structuredClone(this.state);

  start(value: MotorTestRequest, owner: number): MotorTestState {
    const request = motorTestRequestSchema.parse(value) as MotorTestRequest;
    if (this.current) throw new Error("Another motor test is in progress.");
    if (this.reconnecting) throw new Error("Motor state is being checked after reconnect.");
    if (this.dependencies.recording())
      throw new Error("Stop sensor recording before testing a motor.");
    const test: Test = {
      request,
      descriptor: undefined,
      owner,
      keepalive: this.now(),
      stop: false,
      brake: request.brake,
      started: undefined,
      origin: undefined,
      token: randomInt(1, 0x7fffffff),
      helperPath: undefined,
      helperStarted: false,
      issued: false,
      disconnected: false,
      stopConfirmed: false,
      wake: undefined,
      task: Promise.resolve(),
    };
    this.current = test;
    this.unconfirmedTest = undefined;
    this.state = { request, phase: "preparing", angle: null, displacement: null, elapsedMs: 0 };
    this.publish();
    test.task = this.dependencies
      .run(request.sessionId, async (session, signal) => {
        test.descriptor = { ...session.descriptor };
        try {
          await this.execute(test, session, signal);
        } catch (error) {
          // A failed request may already have reached the brick. Try to stop before releasing ownership.
          let stopped = !test.issued && !test.helperStarted;
          if (session.connected && !signal.aborted && !test.disconnected && !stopped) {
            try {
              stopped = await this.stopDevice(test, session, signal, true);
            } catch {
              /* retain uncertainty */
            }
          }
          this.patch(test, {
            phase: stopped ? "failed" : "unconfirmed",
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })
      .catch((error: unknown) => {
        if (!["failed", "unconfirmed"].includes(this.state.phase))
          this.patch(test, {
            phase: test.issued || test.helperStarted ? "unconfirmed" : "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        test.wake?.();
        if (this.state.phase === "unconfirmed") this.unconfirmedTest = test;
        if (this.current === test) this.current = undefined;
      });
    return this.getState();
  }

  keepAlive(ref: MotorTestRef, owner: number): void {
    const test = this.match(ref, owner);
    if (test && !test.stop) test.keepalive = this.now();
  }
  async stop(ref: MotorTestRef, owner: number, brake = true): Promise<MotorTestState> {
    const test =
      this.match(ref, owner) ??
      (!this.current ? this.match(ref, owner, this.unconfirmedTest) : undefined);
    if (test) {
      if (!this.current) {
        this.current = test;
        test.disconnected = false;
        test.brake = brake;
        this.patch(test, { phase: "stopping" });
        test.task = this.dependencies
          .run(test.request.sessionId, async (session, signal) => {
            this.assertConnected(test, session, signal);
            await this.finish(test, session, signal, "stopped", brake);
          })
          .catch((error: unknown) => {
            this.patch(test, {
              phase: "unconfirmed",
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            if (this.state.phase !== "unconfirmed") this.unconfirmedTest = undefined;
            if (this.current === test) this.current = undefined;
          });
      }
      test.brake = test.stop ? test.brake || brake : brake;
      test.stop = true;
      this.patch(test, { phase: "stopping" });
      test.wake?.();
      await test.task;
    }
    return this.getState();
  }
  async stopAll(sessionId?: string): Promise<void> {
    const test = this.current ?? this.unconfirmedTest;
    if (test && (!sessionId || sessionId === test.request.sessionId))
      await this.stop(test.request, test.owner, true);
  }
  async flush(): Promise<void> {
    await this.reconnecting;
    await this.stopAll();
    if (this.state.phase === "unconfirmed")
      throw new Error("Motor stop has not been confirmed. Check the EV3 before closing.");
  }
  disconnected(sessionId: string): void {
    const test = this.current;
    if (test?.request.sessionId !== sessionId) return;
    test.stop = true;
    test.disconnected = true;
    if (!test.stopConfirmed)
      this.patch(test, {
        phase: "unconfirmed",
        message: "EV3 disconnected; motor stop is unconfirmed.",
      });
    test.wake?.();
  }
  /** Observe the same physical EV3 after reconnect; never resume or stop it here. */
  reconnected(sessionId: string): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const test =
      this.unconfirmedTest ?? (this.state.phase === "unconfirmed" ? this.current : undefined);
    if (!test) return Promise.resolve();
    const check = async () => {
      await test.task;
      if (this.current || this.unconfirmedTest !== test || this.state.phase !== "unconfirmed")
        return;
      await this.dependencies.run(sessionId, async (session, signal) => {
        const previous = test.descriptor;
        const next = session.descriptor;
        if (!previous || previous.transport !== next.transport) return;
        const identity =
          previous.transport === "usb"
            ? previous.serialNumber
            : previous.transport === "wifi"
              ? previous.address
              : undefined;
        const nextIdentity = next.transport === "usb" ? next.serialNumber : next.address;
        if (!identity?.trim() || identity !== nextIdentity || !session.connected) return;
        signal.throwIfAborted();
        const reading = await session.readMotorTest(signal);
        signal.throwIfAborted();
        if (
          !session.connected ||
          this.current ||
          this.unconfirmedTest !== test ||
          this.state.phase !== "unconfirmed"
        )
          return;
        this.requireIdle(reading, test.request.port);
        this.unconfirmedTest = undefined;
        // Keep the prior sample and outcome history unchanged. This observation
        // establishes current idleness, not the missing previous test result.
        this.state = {
          ...this.state,
          phase: "stopped",
          message: "EV3 is idle after reconnect; the previous test result is unavailable.",
        };
        this.publish();
      });
    };
    const pending = check()
      .catch(() => {
        // A mismatch, busy device, or failed read leaves stop uncertainty visible.
      })
      .finally(() => {
        if (this.reconnecting === pending) this.reconnecting = undefined;
      });
    this.reconnecting = pending;
    return pending;
  }
  private match(ref: MotorTestRef, owner: number, test = this.current): Test | undefined {
    if (!test || test.request.testId !== ref.testId || test.request.sessionId !== ref.sessionId)
      return;
    if (test.owner !== owner) throw new Error("This motor test belongs to another window.");
    return test;
  }
  private patch(test: Test, patch: Partial<MotorTestState>): void {
    if (this.current !== test) return;
    if (test.disconnected && !test.stopConfirmed) patch = { ...patch, phase: "unconfirmed" };
    this.state = {
      ...this.state,
      ...patch,
      elapsedMs: test.started === undefined ? 0 : Math.max(0, this.now() - test.started),
    };
    this.publish();
  }
  private publish(): void {
    this.dependencies.publish(this.getState());
  }
  private assertConnected(test: Test, session: DeviceSession, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (test.disconnected || !session.connected)
      throw new Error("EV3 disconnected; motor stop is unconfirmed.");
  }
  private wait(test: Test, signal: AbortSignal, ms = 150): Promise<void> {
    signal.throwIfAborted();
    if (test.stop) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        test.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      test.wake = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  private accept(test: Test, reading: MotorTestReading): void {
    const output = reading.outputs.find((item) => item.port === test.request.port);
    if (!output || ![7, 8].includes(output.type) || output.angle === null)
      throw new Error("The selected motor was removed or is not ready.");
    test.origin ??= output.angle;
    this.patch(test, {
      angle: output.angle,
      displacement: output.angle - test.origin,
      updatedAt: reading.sampledAt,
    });
  }
  private preflight(test: Test, reading: MotorTestReading): void {
    this.requireIdle(reading, test.request.port);
    this.accept(test, reading);
  }
  private requireIdle(reading: MotorTestReading, port: number): void {
    if (!reading.programStopped)
      throw new Error("Stop the EV3 user program before testing a motor.");
    if (
      [0, 1, 2, 3].some((port) => {
        const output = reading.outputs.find((item) => item.port === port);
        return !output || ![7, 8, 126].includes(output.type) || output.speed === null;
      })
    )
      throw new Error("The state of all four motor outputs must be known before testing.");
    if (
      reading.outputs.some((output) => output.busy || (output.speed !== null && output.speed !== 0))
    )
      throw new Error("Wait for all motors to stop before testing.");
    const selected = reading.outputs.find((output) => output.port === port);
    if (!selected || ![7, 8].includes(selected.type) || selected.angle === null)
      throw new Error("The selected motor was removed or is not ready.");
  }
  private shouldStop(test: Test): boolean {
    if (test.request.mode === "jog" && this.now() - test.keepalive > 350) test.stop = true;
    return test.stop;
  }

  private async execute(test: Test, session: DeviceSession, signal: AbortSignal): Promise<void> {
    const r = test.request;
    this.assertConnected(test, session, signal);
    if (this.dependencies.recording())
      throw new Error("Stop sensor recording before testing a motor.");
    if (this.shouldStop(test)) {
      this.patch(test, { phase: "stopped" });
      return;
    }
    this.preflight(test, await session.readMotorTest(signal));
    this.assertConnected(test, session, signal);
    if (this.shouldStop(test)) {
      this.patch(test, { phase: "stopped" });
      return;
    }
    if (r.mode === "angle") await this.angle(test, session, signal);
    else await this.timed(test, session, signal);
  }

  private async timed(test: Test, session: DeviceSession, signal: AbortSignal): Promise<void> {
    const r = test.request;
    const duration = r.mode === "jog" ? 10000 : r.durationMs!;
    test.started = this.now();
    let lastPulse = test.started;
    test.issued = true;
    await session.motorTimed(
      r.port,
      r.power * r.direction,
      r.mode === "jog" ? 400 : duration,
      r.brake,
      signal,
    );
    this.assertConnected(test, session, signal);
    // A delayed acknowledgement must not cause a timed run to be cut short and
    // nevertheless reported complete. The firmware already bounds its motion.
    if (r.mode === "timed") test.started = this.now();
    this.patch(test, { phase: test.stop ? "stopping" : "running" });
    for (;;) {
      this.assertConnected(test, session, signal);
      if (this.shouldStop(test)) {
        await this.finish(test, session, signal, "stopped", test.brake);
        return;
      }
      const elapsed = this.now() - test.started;
      if (elapsed >= duration) {
        await this.finish(
          test,
          session,
          signal,
          r.mode === "jog" ? "timeout" : "completed",
          r.mode === "jog" || r.brake,
        );
        return;
      }
      await this.wait(test, signal);
      this.assertConnected(test, session, signal);
      if (this.shouldStop(test)) continue;
      const reading = await session.readMotorTest(signal);
      this.assertConnected(test, session, signal);
      this.accept(test, reading);
      if (!reading.programStopped)
        throw new Error("Another EV3 program interrupted the motor test.");
      if (this.shouldStop(test)) continue;
      if (r.mode === "jog") {
        // Never revive a pulse after a stalled renderer or delayed transport exchange.
        if (this.now() - lastPulse >= 400) {
          test.stop = true;
          continue;
        }
        const remaining = 10000 - (this.now() - test.started);
        if (remaining < 100) {
          await this.finish(test, session, signal, "timeout", true);
          return;
        }
        lastPulse = this.now();
        await session.motorTimed(
          r.port,
          r.power * r.direction,
          Math.min(400, Math.ceil(remaining)),
          r.brake,
          signal,
        );
      }
    }
  }

  private async angle(test: Test, session: DeviceSession, signal: AbortSignal): Promise<void> {
    const r = test.request;
    const image = createMotorTestImage({
      token: test.token,
      port: r.port,
      power: r.power * r.direction,
      angle: r.degrees!,
      brake: r.brake,
    });
    test.helperPath = `${REMOTE_PROJECT_ROOT}/kobrixa-motor-${r.testId}.rbf`;
    await session.upload(test.helperPath, image, signal);
    this.assertConnected(test, session, signal);
    if (test.stop) {
      await session.delete(test.helperPath, signal);
      this.patch(test, { phase: "stopped" });
      return;
    }
    this.preflight(test, await session.readMotorTest(signal));
    this.assertConnected(test, session, signal);
    if (test.stop) {
      await session.delete(test.helperPath, signal);
      this.patch(test, { phase: "stopped" });
      return;
    }
    test.helperStarted = true; // Run may reach the brick even when its response fails.
    await session.runMotorHelper(test.helperPath, signal);
    const preparing = this.now();
    for (;;) {
      this.assertConnected(test, session, signal);
      const helper = await session.readMotorHelper(test.token, signal);
      this.assertConnected(test, session, signal);
      if (helper.owned) break;
      if (this.now() - preparing >= 2000)
        throw new Error("The motor test program did not become ready.");
      // Even a released button must wait for ownership before cleaning up the just-started helper.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (test.stop) {
      await this.finish(test, session, signal, "stopped", test.brake);
      return;
    }
    test.started = this.now();
    test.issued = true;
    await session.armMotorHelper(test.token, signal);
    this.assertConnected(test, session, signal);
    this.patch(test, { phase: test.stop ? "stopping" : "running" });
    for (;;) {
      this.assertConnected(test, session, signal);
      if (test.stop) {
        await this.finish(test, session, signal, "stopped", test.brake);
        return;
      }
      const helper = await session.readMotorHelper(test.token, signal);
      this.assertConnected(test, session, signal);
      if (!helper.owned) throw new Error("Motor test result could not be confirmed.");
      if (helper.angle !== null)
        this.patch(test, {
          angle: helper.angle,
          displacement: helper.angle - test.origin!,
          updatedAt: Date.now(),
        });
      if (helper.state === 2) {
        if (helper.result !== 1 && helper.result !== 2)
          throw new Error("The motor test ended before completing the requested movement.");
        await this.finish(
          test,
          session,
          signal,
          helper.result === 1 ? "completed" : "timeout",
          helper.result === 2 || r.brake,
        );
        return;
      }
      if (this.now() - test.started > 12000) throw new Error("The motor test result timed out.");
      await this.wait(test, signal);
    }
  }

  private async stopDevice(
    test: Test,
    session: DeviceSession,
    signal: AbortSignal,
    brake: boolean,
  ): Promise<boolean> {
    this.assertConnected(test, session, signal);
    test.stopConfirmed = false;
    if (test.helperStarted) {
      const stopped = await session.stopMotorHelper(test.token, test.request.port, brake, signal);
      if (!stopped) {
        const reading = await session.readMotorTest(signal);
        if (!reading.programStopped) return false;
        await session.motorStop(test.request.port, brake, signal);
      }
    } else if (test.issued) await session.motorStop(test.request.port, brake, signal);
    // The kernel may still report the old busy bit immediately after STOP.
    // Keep ownership while observing it settle, without issuing another drive.
    for (let attempt = 0; attempt < 5; attempt++) {
      const reading = await session.readMotorTest(signal);
      this.assertConnected(test, session, signal);
      if (!reading.programStopped) return false;
      if (reading.outputs.find((item) => item.port === test.request.port)?.busy === false) {
        this.accept(test, reading);
        test.stopConfirmed = true;
        return true;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100));
      this.assertConnected(test, session, signal);
    }
    return false;
  }
  private async finish(
    test: Test,
    session: DeviceSession,
    signal: AbortSignal,
    phase: MotorTestState["phase"],
    brake: boolean,
  ): Promise<void> {
    this.patch(test, { phase: "stopping" });
    if (!(await this.stopDevice(test, session, signal, brake)))
      throw new Error("Motor stop could not be confirmed.");
    // A manual stop can arrive while a coast command/readback is in flight.
    // Honor the stronger request without rewriting an already observed result.
    let appliedBrake = brake;
    const applyRequestedBrake = async () => {
      if (appliedBrake || !test.stop || !test.brake) return;
      if (!(await this.stopDevice(test, session, signal, true)))
        throw new Error("Motor braking could not be confirmed.");
      appliedBrake = true;
    };
    await applyRequestedBrake();
    if (test.helperPath) {
      // Cleanup is not allowed to change a confirmed movement result into a false failure.
      try {
        await session.delete(test.helperPath, signal);
      } catch {
        this.patch(test, { message: "The stopped motor test file could not be removed." });
      }
    }
    await applyRequestedBrake();
    this.patch(test, { phase });
  }
}
