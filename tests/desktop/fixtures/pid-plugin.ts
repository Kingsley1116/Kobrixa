import { writeFileSync } from "node:fs";
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

// The launcher starts plugins with the plugin folder as the working directory.
void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-smoke.pid-ts.record", () =>
        writeFileSync("pid.txt", String(process.pid)),
      );
    },
    deactivate() {
      writeFileSync("shutdown.txt", "ok");
    },
  }),
);
