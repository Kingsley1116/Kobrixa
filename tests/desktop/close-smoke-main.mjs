import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { app, BrowserWindow, dialog } from "electron";

const [directory, scenario] = process.argv.slice(2);
assert.ok(["close", "quit", "early-close", "reopen"].includes(scenario));
const events = [];
const observe = (event, windowId = null) =>
  events.push({ event, at: performance.now(), window: windowId });
const receipt = (status, error = null) =>
  writeFileSync(
    path.join(directory, `close-${scenario}.json`),
    JSON.stringify(
      {
        schema: 1,
        scope: "production-window-close-only",
        scenario,
        status,
        pid: process.pid,
        electron: process.versions.electron,
        events,
        error,
      },
      null,
      2,
    ),
  );
const fail = (error) => {
  receipt("failed", String(error));
  console.error(error);
  app.exit(1);
};
// Report the actual error instead of leaving CI stuck behind Electron's native dialog.
process.removeAllListeners("uncaughtException");
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
dialog.showErrorBox = (title, content) => fail(new Error(`${title}: ${content}`));
dialog.showMessageBox = async (...args) => {
  fail(new Error(`Unexpected close dialog: ${JSON.stringify(args.at(-1))}`));
  return { response: 1, checkboxChecked: false };
};
setTimeout(() => fail(new Error(`Close smoke timed out: ${scenario}`)), 30_000).unref();

let first;
let closed = 0;
app.on("browser-window-created", (_event, window) => {
  const windowId = window.id;
  observe("created", windowId);
  first ??= window;
  window.once("closed", () => {
    observe("closed", windowId);
    closed++;
  });
  if (scenario === "early-close") setImmediate(() => window.close());
});
let drained = false;
app.on("will-quit", (event) => {
  observe("will-quit");
  assert.ok(closed > 0, "The production close flow must close its window");
  // Give asynchronous device/reset and lab publication callbacks a chance to run.
  if (!drained) {
    event.preventDefault();
    drained = true;
    setTimeout(() => app.quit(), 200);
  } else {
    assert.equal(BrowserWindow.getAllWindows().length, 0, "Quit must leave no native windows");
    assert.equal(closed, events.filter((entry) => entry.event === "created").length);
    receipt("passed");
    console.log(`PASS ${scenario}`);
  }
});
async function until(read) {
  for (let i = 0; i < 200; i++) {
    if (await read()) return;
    await pause(50);
  }
  throw new Error(`Window did not become ready: ${scenario}`);
}
async function ready(window) {
  await until(() => !window.webContents.isLoading());
  await until(() =>
    window.webContents.executeJavaScript(
      'Boolean(window.kobrixa && document.querySelector(".app-shell"))',
    ),
  );
  assert.equal(
    await window.webContents.executeJavaScript("Boolean(window.kobrixa.windowChrome)"),
    process.platform === "win32",
  );
  if (process.platform === "win32") {
    assert.equal(window.isMenuBarVisible(), false);
    await until(() =>
      window.webContents.executeJavaScript(
        'Boolean(navigator.windowControlsOverlay?.visible && document.querySelector(".topbar.has-window-controls"))',
      ),
    );
  }
  observe("ready", window.id);
}

createRequire(import.meta.url)(path.join(directory, "main.cjs"));
void (async () => {
  await until(() => first);
  if (scenario !== "early-close") {
    await ready(first);
    if (scenario === "quit") app.quit();
    else first.close();
  }
  await until(() => first.isDestroyed());
  if (scenario === "reopen" && process.platform === "darwin") {
    app.emit("activate");
    await until(() => BrowserWindow.getAllWindows().length === 1);
    const second = BrowserWindow.getAllWindows()[0];
    await ready(second);
    app.quit();
  } else if (process.platform === "darwin" && scenario !== "quit") {
    await pause(200);
    app.quit();
  }
})().catch(fail);
