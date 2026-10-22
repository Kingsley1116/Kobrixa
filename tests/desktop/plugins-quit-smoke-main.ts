import { writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";

const directory = process.argv.at(-1)!;
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  let cleanups = 0;
  installPluginQuitCleanup(
    app,
    async () => {
      cleanups++;
    },
    fail,
  );
  app.on("quit", () => {
    writeFileSync(path.join(directory, "immediate-quit.json"), JSON.stringify({ cleanups }));
  });
  setTimeout(
    () => fail(new Error("Immediate cleanup did not permit Electron to exit")),
    10_000,
  ).unref();
  app.quit();
});
