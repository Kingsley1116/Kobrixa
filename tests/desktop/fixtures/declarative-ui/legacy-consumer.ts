import { definePlugin, electronParentPortChannel, runPlugin } from "@kobrixa/plugin-sdk";

// Observation wraps the unchanged 1.4 or current SDK channel, not its codec or
// dispatch. This same consumer must work with either preserved SDK version.
void (async () => {
  const channel = await electronParentPortChannel();
  const log = (direction: "host" | "plugin", text: string) =>
    console.error("UI_LEGACY_WIRE:" + JSON.stringify({ direction, message: JSON.parse(text) }));
  await runPlugin(
    definePlugin({
      activate(ctx) {
        ctx.commands.register(`${ctx.pluginId}.legacy`, async () => {
          console.error("UI_LEGACY_EXECUTED:" + ctx.pluginId);
        });
      },
    }),
    {
      channel: {
        send(text) {
          log("plugin", text);
          channel.send(text);
        },
        onMessage(listener) {
          return channel.onMessage((text) => {
            log("host", text);
            listener(text);
          });
        },
      },
    },
  );
})();
