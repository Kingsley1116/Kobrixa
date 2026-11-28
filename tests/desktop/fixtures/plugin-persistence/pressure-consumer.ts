import assert from "node:assert/strict";
import { rssSettingsValues } from "../../b2-process-rss-settings.js";
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
      if (ctx.pluginId.endsWith("-a") && process.env.KOBRIXA_B2_RSS_SETTINGS === "1") {
        ctx.commands.register(`${ctx.pluginId}.settings`, async () => {
          const initial = await ctx.settings.read({ schemaVersion: 1 });
          assert.ok(initial.ok);
          const changes = rssSettingsValues();
          const saved = await ctx.settings.update({
            schemaVersion: 1,
            expectedRevision: initial.value.revision,
            changes,
          });
          assert.ok(saved.ok);
          const read = await ctx.settings.read({ schemaVersion: 1 });
          assert.ok(read.ok);
          assert.deepEqual(read.value.values, changes);
          emit({
            pluginId: ctx.pluginId,
            command: "settings",
            result: { revision: read.value.revision },
          });
        });
      }
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
