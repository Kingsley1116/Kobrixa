import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createFoundationFixture } from "./plugin-persistence-main.ts";
import { runReferenceEntry } from "./plugin-persistence-harness.mjs";

const prefix = "--persistence-config=";
const config = JSON.parse(
  readFileSync(process.argv.find((arg) => arg.startsWith(prefix)).slice(prefix.length), "utf8"),
);
app.setPath("userData", config.profile);
if (config.rss) {
  writeFileSync(
    config.rss.cold,
    JSON.stringify({
      phase: "cold-start",
      pid: process.pid,
      trial: config.runId,
      at: Number(process.hrtime.bigint()) / 1e6,
      bytes: process.memoryUsage.rss(),
      uptime: process.uptime(),
    }),
    { flag: "wx" },
  );
}
// The supervisor owns exit, including receipt I/O after the last window closes.
app.on("window-all-closed", () => {});
// The factory requests the primary lock on this initial call stack.
void runReferenceEntry(createFoundationFixture, config, {
  write: writeFile,
  now: Date.now,
  pid: process.pid,
  reportFailure: (failure) => console.error(JSON.stringify(failure)),
}).then((code) => app.exit(code));
