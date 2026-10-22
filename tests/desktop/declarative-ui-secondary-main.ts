// Observe the real production single-instance guard in a second Electron process.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { app, utilityProcess } from "electron";

const report = {
  pid: process.pid,
  lockRequests: 0,
  lockGranted: false,
  whenReadyCalls: 0,
  windows: 0,
  utilityForks: 0,
  quit: false,
};
const output = app.commandLine.getSwitchValue("ui-secondary-output");
assert.ok(output);
const lock = app.requestSingleInstanceLock.bind(app);
app.requestSingleInstanceLock = (...args) => {
  report.lockRequests++;
  const result = lock(...args);
  report.lockGranted = result;
  assert.equal(result, false, "secondary unexpectedly obtained the primary lock");
  return result;
};
const ready = app.whenReady.bind(app);
app.whenReady = () => {
  report.whenReadyCalls++;
  return ready();
};
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (...args) => {
  report.utilityForks++;
  return fork(...args);
};
app.on("browser-window-created", () => {
  report.windows++;
});
app.once("quit", () => {
  report.quit = true;
  writeFileSync(output, JSON.stringify({ ...report, versions: process.versions }, null, 2));
});
createRequire(path.join(__dirname, "package.json"))("./main.cjs");
