import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let calls = 0;
let ticks = 0;
runPlugin(
  definePlugin({
    activate(ctx) {
      ctx.commands.register(`${ctx.pluginId}.legacy`, async () => {});
      ctx.commands.registerContext(
        `${ctx.pluginId}.activate`,
        {
          speed: { type: "number", min: -100, max: 100, integer: true, nullable: false },
          mode: { type: "enum", values: ["coast", "brake"], nullable: false },
        },
        async (invocation) => {
          if (invocation.arguments.speed === -99) throw new Error("fixture callback failed");
          if (invocation.arguments.speed === -98) {
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(wait);
                reject(new Error("cancelled"));
              };
              const wait = setTimeout(() => {
                invocation.signal.removeEventListener("abort", abort);
                resolve();
              }, 60_000);
              invocation.signal.addEventListener("abort", abort, { once: true });
              if (invocation.signal.aborted) abort();
            });
          }
          calls++;
          return {
            output: {
              calls,
              speed: invocation.arguments.speed!,
              mode: invocation.arguments.mode!,
              origin: invocation.context.origin,
              hasBinding: Boolean(invocation.context.binding),
              hasMotion: Boolean(invocation.context.motionScopeRef),
              unicode: "🙂界",
            },
            fieldErrors: [],
          };
        },
      );
      ctx.commands.registerContext(
        `${ctx.pluginId}.hold`,
        {
          speed: { type: "number", min: -100, max: 100, integer: true, nullable: false },
          mode: { type: "enum", values: ["coast", "brake"], nullable: false },
        },
        async (invocation) => ({
          output: {
            speed: invocation.arguments.speed!,
            mode: invocation.arguments.mode!,
            phase:
              invocation.context.trigger.kind === "hold"
                ? invocation.context.trigger.phase
                : "invalid",
          },
          fieldErrors: [],
        }),
      );
    },
    async ready(ctx) {
      // Serialize the producer. Slow UI never creates unbounded overlapping patch promises.
      const tick = async () => {
        const listed = await ctx.ui.instances();
        if (!listed.ok) throw new Error(listed.error.code);
        ticks++;
        for (const binding of listed.value.instances) {
          const state = await ctx.ui.state(binding);
          if (!state.ok) continue;
          await ctx.ui.patch(binding, state.value.revision, { ticks: `tick:${ticks}` });
        }
      };
      const loop = async () => {
        if (stopped) return;
        const started = performance.now();
        try {
          await tick();
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
        if (!stopped)
          timer = setTimeout(
            () => {
              void loop();
            },
            Math.max(0, 100 - (performance.now() - started)),
          );
      };
      await tick();
      timer = setTimeout(() => {
        void loop();
      }, 100);
    },
    deactivate() {
      stopped = true;
      clearTimeout(timer);
    },
  }),
);
