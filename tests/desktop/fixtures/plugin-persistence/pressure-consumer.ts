import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";
import { createPressureWorkload } from "../../plugin-persistence-pressure.js";
let workload: ReturnType<typeof createPressureWorkload> | undefined;
const emit = (value: unknown) =>
  console.error(
    "PERSISTENCE_PRESSURE:" +
      JSON.stringify({
        clock: { realm: "plugin", pid: process.pid, timeOrigin: performance.timeOrigin },
        ...(value as object),
      }),
  );
void runPlugin(
  definePlugin({
    activate(ctx) {
      workload = createPressureWorkload(ctx.storage, ctx.pluginId, (event) =>
        emit({ pluginId: ctx.pluginId, ...event }),
      );
      const actions = {
        seed: workload.seedOne,
        inventory: workload.inventory,
        verify: workload.verifyOne,
        burst: workload.burst,
        stage: workload.stageOne,
        staging: workload.stagingStatus,
        replace: workload.replaceOne,
        flush: workload.flush,
        quota: workload.quota,
        cleanup: () => workload!.cleanup(),
      };
      for (const [name, action] of Object.entries(actions))
        ctx.commands.register(`${ctx.pluginId}.${name}`, async ({ signal }) => {
          const result = await action(signal);
          const snapshot = workload!.snapshot();
          emit({
            pluginId: ctx.pluginId,
            command: name,
            result,
            snapshot: {
              recordCount: snapshot.records.length,
              verified: snapshot.verified,
              held: snapshot.held,
              readers: snapshot.readers,
            },
          });
        });
    },
    async deactivate() {
      await workload?.cleanup();
    },
  }),
).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
