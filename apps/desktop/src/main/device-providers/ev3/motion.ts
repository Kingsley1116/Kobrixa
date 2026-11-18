import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { REMOTE_PROJECT_ROOT, type DeviceSession, type MotorTestReading } from "@kobrixa/device";
import type { Handle, MotionSpec } from "@kobrixa/plugin-protocol";
import type {
  IdleObservation,
  MotionCompletion,
  ProviderCleanupContext,
  ProviderOperationContext,
  ProviderStep,
} from "../../device-broker/provider.js";
import { createMotorTestImage } from "../../device/motor-test-image.js";
type State = {
  port: number;
  token: number;
  helper: boolean;
  issued: boolean;
  path: string;
  origin: number | null;
  angle: number | null;
  ctx: ProviderOperationContext;
  bind: (step: ProviderStep) => DeviceSession;
};
const knownIdle = (r: MotorTestReading) =>
  r.programStopped &&
  r.outputs.length === 4 &&
  new Set(r.outputs.map((o) => o.port)).size === 4 &&
  r.outputs.every((o) => [7, 8, 126].includes(o.type) && o.busy === false && o.speed === 0);
export class Ev3MotionEngine {
  private states = new Map<Handle, State>();
  release(operationId: Handle): void {
    this.states.delete(operationId);
  }
  async execute(
    port: number,
    motion: MotionSpec,
    ctx: ProviderOperationContext,
    bind: (step: ProviderStep) => DeviceSession,
  ): Promise<MotionCompletion> {
    if (this.states.has(ctx.operationId) || this.states.size >= 256)
      throw new Error("provider-contract");
    const s: State = {
      port,
      token: randomInt(1, 0x7fffffff),
      helper: false,
      issued: false,
      path: `${REMOTE_PROJECT_ROOT}/kobrixa-motor-${ctx.operationId}.rbf`,
      origin: null,
      angle: null,
      ctx,
      bind,
    };
    this.states.set(ctx.operationId, s);
    const check = (step: ProviderStep) => {
      if (ctx.stopState().requested || ctx.now() >= ctx.deadlineMonotonicMs)
        throw new Error("cancelled");
      ctx.assertContinuation(step);
    };
    const accept = (r: MotorTestReading) => {
      const o = r.outputs.find((value) => value.port === port);
      s.angle = o && [7, 8].includes(o.type) ? o.angle : null;
      if (s.origin === null) s.origin = s.angle;
    };
    const preflight = async () => {
      check("preflight");
      const r = await bind("preflight").readMotorTest(ctx.cancellation);
      check("preflight");
      if (!r.programStopped) throw new Error("preflight-program-running");
      if (r.outputs.some((o) => o.busy === true || (o.speed !== null && o.speed !== 0)))
        throw new Error("preflight-output-moving");
      if (!knownIdle(r)) throw new Error("preflight-output-unknown");
      const o = r.outputs.find((value) => value.port === port);
      if (!o || ![7, 8].includes(o.type) || o.angle === null) throw new Error("motor-unavailable");
      accept(r);
    };
    const complete = (movement: MotionCompletion["movement"]): MotionCompletion => ({
      movement,
      angle: s.angle,
      displacement: s.angle === null || s.origin === null ? null : s.angle - s.origin,
    });
    await preflight();
    if (motion.mode === "relative-angle") {
      check("helper-upload");
      await bind("helper-upload").upload(
        s.path,
        createMotorTestImage({
          token: s.token,
          port,
          power: motion.power * motion.direction,
          angle: motion.degrees,
          brake: motion.brake,
        }),
        ctx.cancellation,
      );
      check("helper-upload");
      await preflight();
      check("helper-run");
      s.helper = true;
      await bind("helper-run").runMotorHelper(s.path, ctx.cancellation);
      check("helper-run");
      const waiting = ctx.now();
      for (;;) {
        check("read");
        const reply = await bind("read").readMotorHelper(s.token, ctx.cancellation);
        check("helper-arm");
        if (ctx.now() - waiting >= 2000) throw new Error("deadline");
        if (reply.owned && reply.state === 0) break;
        await delay(50);
        check("read");
      }
      check("helper-arm");
      s.issued = true;
      const armed = ctx.now();
      await bind("helper-arm").armMotorHelper(s.token, ctx.cancellation);
      check("read");
      for (;;) {
        check("read");
        const reply = await bind("read").readMotorHelper(s.token, ctx.cancellation);
        check("read");
        if (!reply.owned) throw new Error("readback-failed");
        s.angle = reply.angle;
        ctx.publishProgress({
          stage: "moving",
          elapsedMs: Math.max(0, ctx.now() - armed),
          angle: s.angle,
          displacement: complete("unknown").displacement,
        });
        if (reply.state === 2) {
          if (reply.result === 1) return complete("completed");
          if (reply.result === 2) {
            ctx.requestSafetyStop("deadline");
            return complete("timed-out");
          }
          throw new Error("readback-failed");
        }
        if (ctx.now() - armed >= 12000) {
          ctx.requestSafetyStop("deadline");
          return complete("unknown");
        }
        await delay(150);
        check("read");
      }
    }
    check("motion-pulse");
    let lastPulse = ctx.now();
    const started = lastPulse;
    s.issued = true;
    await bind("motion-pulse").motorTimed(
      port,
      motion.power * motion.direction,
      motion.mode === "jog" ? 400 : motion.durationMs,
      motion.brake,
      ctx.cancellation,
    );
    check("read");
    const observedStart = ctx.now();
    for (;;) {
      if (ctx.stopState().requested) return complete("interrupted");
      check("read");
      if (motion.mode === "jog" && ctx.now() - started >= 10000) {
        ctx.requestSafetyStop("deadline");
        return complete("timed-out");
      }
      await delay(150);
      check("read");
      const r = await bind("read").readMotorTest(ctx.cancellation);
      check("read");
      accept(r);
      if (!r.programStopped) throw new Error("readback-failed");
      ctx.publishProgress({
        stage: "moving",
        elapsedMs: Math.max(0, ctx.now() - started),
        angle: s.angle,
        displacement: complete("unknown").displacement,
      });
      if (motion.mode === "timed") {
        if (ctx.now() - observedStart >= motion.durationMs) return complete("completed");
      } else {
        const remaining = 10000 - (ctx.now() - started);
        if (ctx.now() - lastPulse >= 400 || remaining < 100) {
          ctx.requestSafetyStop("deadline");
          return complete("timed-out");
        }
        check("motion-pulse");
        lastPulse = ctx.now();
        await bind("motion-pulse").motorTimed(
          port,
          motion.power * motion.direction,
          Math.min(400, Math.floor(remaining)),
          motion.brake,
          ctx.cancellation,
        );
        check("read");
      }
    }
  }
  async stop(
    target: { kind: "operation"; operationId: Handle } | { kind: "current-device" },
    ctx: ProviderCleanupContext,
    bind: (step: "stop" | "readback") => DeviceSession,
    actuator: (port: number) => Handle,
  ): Promise<IdleObservation> {
    const state = target.kind === "operation" ? this.states.get(target.operationId) : undefined;
    let appliedBrake: boolean | undefined;
    const apply = async () => {
      ctx.assertCleanup("stop");
      const brake = ctx.brakeRequired();
      if (target.kind === "current-device") {
        await bind("stop").stop(undefined, ctx.signal);
        for (let port = 0; port < 4; port++) {
          ctx.assertCleanup("stop");
          await bind("stop").motorStop(port, brake, ctx.signal);
        }
      } else if (state) {
        if (state.helper) {
          const owned = await bind("stop").stopMotorHelper(
            state.token,
            state.port,
            brake,
            ctx.signal,
          );
          ctx.assertCleanup("readback");
          if (!owned) {
            const reading = await bind("readback").readMotorTest(ctx.signal);
            if (!reading.programStopped) throw new Error("readback-failed");
            await bind("stop").motorStop(state.port, brake, ctx.signal);
          }
        } else if (state.issued) await bind("stop").motorStop(state.port, brake, ctx.signal);
      } else throw new Error("readback-failed");
      appliedBrake = brake;
    };
    let last: MotorTestReading | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (ctx.now() >= ctx.deadlineMonotonicMs) throw new Error("stop-deadline");
      if (appliedBrake === undefined || (!appliedBrake && ctx.brakeRequired())) await apply();
      ctx.assertCleanup("readback");
      last = await bind("readback").readMotorTest(ctx.signal);
      ctx.assertCleanup("readback");
      if (knownIdle(last) && (appliedBrake || !ctx.brakeRequired())) break;
      if (attempt < 4) await delay(Math.min(100, Math.max(0, ctx.deadlineMonotonicMs - ctx.now())));
    }
    if (!last) throw new Error("readback-failed");
    const result: IdleObservation = {
      programStopped: last.programStopped,
      observedAt: last.sampledAt,
      outputs: last.outputs.map((o) => ({
        actuatorId: actuator(o.port),
        known: [7, 8, 126].includes(o.type) && o.speed !== null,
        busy: o.busy,
        speed: o.speed,
      })),
    };
    // Deletion is ordinary work: the old work context must still permit it.
    // It is never sent through ProviderCleanupContext, and cannot change evidence.
    if (state?.helper && knownIdle(last)) {
      try {
        state.ctx.assertContinuation("file-remove");
        await state.bind("file-remove").delete(state.path, state.ctx.cancellation);
      } catch {
        /* Exact helper path is retained; movement evidence remains unchanged. */
      }
    }
    return result;
  }
}
