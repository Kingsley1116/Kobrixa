import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceRequestMap, MotionSnapshot } from "@kobrixa/plugin-protocol";
import type { MotorTestRef, MotorTestRequest, MotorTestState } from "../../shared/motor-test.js";
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

type MotionMethod =
  | "devices/motion/prepare"
  | "devices/motion/start"
  | "devices/motion/query"
  | "devices/motion/stop";
export interface MotorBrokerBindings {
  prepare(
    request: MotorTestRequest,
    sender: number,
  ): DeviceRequestMap["devices/motion/prepare"]["params"] | null;
  call<M extends MotionMethod>(
    method: M,
    params: DeviceRequestMap[M]["params"],
    sender: number,
  ): Promise<{ operation: MotionSnapshot }>;
  pulse(ref: MotorTestRef, sender: number): void;
  hasBlocker(): boolean;
}
interface Dependencies {
  bindings?: MotorBrokerBindings;
  publish(state: MotorTestState): void;
}
interface Active {
  request: MotorTestRequest;
  owner: number;
  operationId: string | null;
  stop: boolean;
  brake: boolean;
  task: Promise<void>;
}
const terminal = (phase: MotionSnapshot["phase"]) =>
  ["completed", "stopped", "timeout", "failed", "unconfirmed"].includes(phase);
export class MotorTestService {
  private current: Active | undefined;
  private retained: Active | undefined;
  private state: MotorTestState = { phase: "idle", angle: null, displacement: null, elapsedMs: 0 };
  constructor(private dependencies: Dependencies) {}
  get busy(): boolean {
    return !!this.current;
  }
  getState = (): MotorTestState => structuredClone(this.state);
  private publish(): void {
    this.dependencies.publish(this.getState());
  }
  private accept(active: Active, snapshot: MotionSnapshot): void {
    if (this.current !== active && this.retained !== active) return;
    this.state = {
      request: active.request,
      phase: snapshot.phase,
      angle: snapshot.angle,
      displacement: snapshot.displacement,
      elapsedMs: snapshot.elapsedMs,
      ...(snapshot.error ? { message: snapshot.error.message } : {}),
    };
    this.publish();
  }
  start(value: MotorTestRequest, owner: number): MotorTestState {
    const request = motorTestRequestSchema.parse(value) as MotorTestRequest;
    if (this.current) throw new Error("Another motor test is in progress.");
    const bindings = this.dependencies.bindings;
    const params = bindings?.prepare(request, owner);
    if (!bindings || !params) throw new Error("Motor UI binding unavailable.");
    const active: Active = {
      request,
      owner,
      operationId: null,
      stop: false,
      brake: request.brake,
      task: Promise.resolve(),
    };
    this.current = active;
    this.state = { request, phase: "preparing", angle: null, displacement: null, elapsedMs: 0 };
    this.publish();
    active.task = (async () => {
      const prepared = await bindings.call("devices/motion/prepare", params, owner);
      active.operationId = prepared.operation.operationId;
      let snapshot = active.stop
        ? (
            await bindings.call(
              "devices/motion/stop",
              { operationId: active.operationId, stopMode: active.brake ? "brake" : "configured" },
              owner,
            )
          ).operation
        : (await bindings.call("devices/motion/start", { operationId: active.operationId }, owner))
            .operation;
      this.accept(active, snapshot);
      while (!terminal(snapshot.phase)) {
        if (active.stop)
          await bindings.call(
            "devices/motion/stop",
            { operationId: active.operationId, stopMode: active.brake ? "brake" : "configured" },
            owner,
          );
        await delay(150);
        snapshot = (
          await bindings.call("devices/motion/query", { operationId: active.operationId }, owner)
        ).operation;
        this.accept(active, snapshot);
      }
    })()
      .catch((error: unknown) => {
        this.state = {
          ...this.state,
          phase: active.operationId ? "unconfirmed" : "failed",
          message: error instanceof Error ? error.message : String(error),
        };
        this.publish();
      })
      .finally(() => {
        if (this.current === active) this.current = undefined;
        this.retained = active;
      });
    return this.getState();
  }
  keepAlive(ref: MotorTestRef, owner: number): void {
    const active = this.current;
    if (
      active &&
      !active.stop &&
      active.owner === owner &&
      active.request.testId === ref.testId &&
      active.request.sessionId === ref.sessionId
    )
      this.dependencies.bindings?.pulse(ref, owner);
  }
  async stop(ref: MotorTestRef, owner: number, brake = true): Promise<MotorTestState> {
    const active = this.current ?? this.retained;
    if (
      !active ||
      active.request.testId !== ref.testId ||
      active.request.sessionId !== ref.sessionId
    )
      return this.getState();
    if (active.owner !== owner) throw new Error("This motor test belongs to another window.");
    active.brake = active.stop ? active.brake || brake : brake;
    active.stop = true;
    if (active.operationId && this.dependencies.bindings) {
      const result = await this.dependencies.bindings.call(
        "devices/motion/stop",
        { operationId: active.operationId, stopMode: active.brake ? "brake" : "configured" },
        owner,
      );
      this.accept(active, result.operation);
    }
    await active.task;
    return this.getState();
  }
  async stopAll(sessionId?: string): Promise<void> {
    const active = this.current ?? this.retained;
    if (active && (!sessionId || active.request.sessionId === sessionId))
      await this.stop(active.request, active.owner, true);
  }
  async flush(): Promise<void> {
    await this.stopAll();
    if (this.state.phase === "unconfirmed" || this.dependencies.bindings?.hasBlocker())
      throw new Error("Device safety remains unconfirmed.");
  }
  disconnected(sessionId: string): void {
    const active = this.current;
    if (active?.request.sessionId === sessionId) {
      active.stop = true;
      active.brake = true;
    }
  }
  reconnected(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }
}
