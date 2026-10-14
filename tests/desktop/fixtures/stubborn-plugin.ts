import { writeFileSync } from "node:fs";
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

process.on("SIGTERM", () => {});
void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-smoke.stubborn-ts.record", () =>
        writeFileSync("pid.txt", String(process.pid)),
      );
    },
  }),
  { exit: () => {} },
);
