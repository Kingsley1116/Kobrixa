import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { definePlugin, runPlugin, unwrap, type DevicesClient } from "@kobrixa/plugin-sdk";

const { mode } = JSON.parse(readFileSync("motion.json", "utf8")) as {
  mode: "jog" | "relative-angle";
};
const operations = new Map<string, string>();
let sessionId: string;
let actuatorId: string;
const monitors = new Set<AbortController>();
async function observe(devices: DevicesClient, operationId: string) {
  const abort = new AbortController();
  monitors.add(abort);
  try {
    const deadline = performance.now() + 20_000;
    do {
      const result = await devices.motion.query({ operationId }, abort.signal);
      console.error(`MOTION_QUERY:${JSON.stringify(result)}`);
      if (
        !result.ok ||
        ["completed", "stopped", "failed", "timeout", "unconfirmed"].includes(
          result.value.operation.phase,
        )
      )
        return;
      await pause(50, undefined, { signal: abort.signal });
    } while (performance.now() < deadline);
    throw new Error("Original operation query deadline");
  } catch (error) {
    if (!abort.signal.aborted) console.error(`MOTION_QUERY_ERROR:${String(error)}`);
  } finally {
    monitors.delete(abort);
  }
}
console.error(`MOTION_PID:${process.pid}`);
void runPlugin(
  definePlugin({
    activate(ctx) {
      ctx.commands.registerContext(`${ctx.pluginId}.hold`, {}, async (invocation) => {
        const { trigger, contextRef, motionScopeRef } = invocation.context;
        if (trigger.kind !== "hold" || !contextRef || !motionScopeRef)
          throw new Error("Expected a real panel hold invocation.");
        console.error(`MOTION_INVOCATION:${JSON.stringify(invocation)}`);
        if (trigger.phase !== "begin") {
          const operationId = operations.get(trigger.gestureRef);
          if (operationId) await ctx.devices.motion.stop({ operationId, stopMode: "brake" });
          return { output: {}, fieldErrors: [] };
        }
        const result = await ctx.devices.motion.prepare({
          sessionId,
          contextRef,
          motionScopeRef,
          motion:
            mode === "jog"
              ? { mode, actuatorId, power: 20, direction: 1, brake: true }
              : { mode, actuatorId, power: 20, direction: 1, brake: true, degrees: 90 },
          ...(mode === "jog" ? { gestureRef: trigger.gestureRef } : {}),
        });
        const { operation } = unwrap(result);
        operations.set(trigger.gestureRef, operation.operationId);
        console.error(`MOTION_PREPARED:${operation.operationId}`);
        // Exactly one start for the original ID. Cancellation never retries prepare/start.
        const started = await ctx.devices.motion.start({ operationId: operation.operationId });
        console.error(`MOTION_START:${JSON.stringify(started)}`);
        void observe(ctx.devices, operation.operationId);
        return { output: { "operation-id": operation.operationId }, fieldErrors: [] };
      });
    },
    async ready(ctx) {
      unwrap(await ctx.devices.negotiate());
      const listed = unwrap(await ctx.devices.list({}));
      const provider = listed.providers.find((item) => item.state === "available");
      if (!provider) throw new Error("No admitted provider.");
      const discovered = unwrap(await ctx.devices.discover({ providerId: provider.providerId }));
      const candidate = discovered.candidates[0];
      if (!candidate) throw new Error("No discovered candidate.");
      const connected = unwrap(
        await ctx.devices.connect({
          target: { kind: "candidate", candidateId: candidate.candidateId },
        }),
      );
      sessionId = connected.session.sessionId;
      const { sources } = unwrap(await ctx.devices.session({ sessionId }));
      const actuator = sources.actuators[0];
      if (!actuator) throw new Error("No discovered actuator.");
      actuatorId = actuator.actuatorId;
      console.error(`MOTION_READY:${JSON.stringify({ sessionId, actuatorId })}`);
    },
    deactivate() {
      for (const abort of monitors) abort.abort();
      operations.clear();
    },
  }),
);
