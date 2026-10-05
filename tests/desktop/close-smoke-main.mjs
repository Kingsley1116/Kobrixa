import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { app, BrowserWindow, dialog } from "electron";

const [directory, scenario] = process.argv.slice(2);
const fail = (error) => {
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
  first ??= window;
  window.once("closed", () => closed++);
  if (scenario === "early-close") setImmediate(() => window.close());
});
let drained = false;
app.on("will-quit", (event) => {
  assert.ok(closed > 0, "The production close flow must close its window");
  // Give asynchronous device/reset and lab publication callbacks a chance to run.
  if (!drained) {
    event.preventDefault();
    drained = true;
    setTimeout(() => app.quit(), 200);
  } else console.log(`PASS ${scenario}`);
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
  await window.webContents.executeJavaScript("window.kobrixa.sensorLab.getState()");
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
