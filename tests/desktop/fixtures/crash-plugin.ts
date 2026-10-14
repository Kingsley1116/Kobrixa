import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-smoke.crash.exit", () => process.exit(7));
    },
  }),
);
