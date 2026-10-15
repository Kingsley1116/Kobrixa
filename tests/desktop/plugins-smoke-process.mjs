import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function waitForSmokeExit(child, phase) {
  const timeoutMs = 90_000;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`${phase} timed out after ${timeoutMs} ms; Electron was killed with SIGKILL.`),
      );
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timer));
}

export function recordSmokeQuit(app, directory, shutdownDeadlineMs) {
  let started;
  app.on("before-quit", () => (started ??= performance.now()));
  // Register after installPluginQuitCleanup: only its second, allowed will-quit is measured.
  app.on("will-quit", (event) => {
    if (event.defaultPrevented) return;
    const pid = Number(readFileSync(path.join(directory, "stubborn-ts/pid.txt"), "utf8"));
    let stubbornAlive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      stubbornAlive = false;
    }
    // This must be synchronous: Electron is still alive until the listener returns.
    writeFileSync(
      path.join(directory, "quit-result.json"),
      JSON.stringify({ elapsedMs: performance.now() - started, shutdownDeadlineMs, stubbornAlive }),
    );
  });
}
