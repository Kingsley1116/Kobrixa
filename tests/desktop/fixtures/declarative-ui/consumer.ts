import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let calls = 0;
let ticks = 0;
runPlugin(
  definePlugin({
    activate(ctx) {
      ctx.commands.registerContext(`${ctx.pluginId}.inspect`, {}, async (invocation) => ({
        output: {
          "has-binding": Boolean(invocation.context.binding),
          "has-motion": Boolean(invocation.context.motionScopeRef),
          "argument-count": Object.keys(invocation.arguments).length,
        },
        fieldErrors: [],
      }));
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
            console.error(`UI_CALLBACK_WAIT:${invocation.invocationId}`);
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
              "has-binding": Boolean(invocation.context.binding),
              "has-motion": Boolean(invocation.context.motionScopeRef),
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
      const failed = (code: string) => {
        if (code === "PLUGIN_E_STALE_RESOURCE") stopped = true;
        else throw new Error(code);
      };
      const tick = async () => {
        const listed = await ctx.ui.instances();
        if (stopped) return;
        if (!listed.ok) return failed(listed.error.code);
        ticks++;
        for (const binding of listed.value.instances) {
          const state = await ctx.ui.state(binding);
          if (stopped) return;
          if (!state.ok) {
            if (state.error.code === "PLUGIN_E_STALE_RESOURCE") continue;
            return failed(state.error.code);
          }
          const patched = await ctx.ui.patch(binding, state.value.revision, {
            ticks: `tick:${ticks}`,
          });
          if (stopped) return;
          if (!patched.ok) {
            if (patched.error.code === "PLUGIN_E_STALE_RESOURCE") continue;
            return failed(patched.error.code);
          }
        }
      };
      const loop = async () => {
        if (stopped) return;
        try {
          await tick();
        } catch (error) {
          if (stopped) return;
          stopped = true;
          console.error(error instanceof Error ? error.message : String(error));
        }
        if (!stopped)
          timer = setTimeout(
            () => {
              void loop();
            },
            // Wait after the acknowledged patch. Compensating for RPC time
            // can place eleven arrivals inside the host's rolling second.
            100,
          );
      };
      await tick();
      if (!stopped)
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
