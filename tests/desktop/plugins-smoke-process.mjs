import assert from "node:assert/strict";
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
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
}

export function recordSmokeQuit(app, directory, shutdownDeadlineMs, forceMarginMs) {
  let started;
  let forceKillMs = null;
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
      JSON.stringify({
        elapsedMs: performance.now() - started,
        shutdownDeadlineMs,
        forceAtMs: Math.max(0, shutdownDeadlineMs - forceMarginMs),
        forceKillMs,
        stubbornAlive,
      }),
    );
  });
  // Wrap only the process's public forceKill: escalatingKill's private timer bypasses this.
  return () => (forceKillMs ??= performance.now() - started);
}

export function assertSmokeQuit(quit) {
  // Keep the manager's force-kill limit strict to catch a blocked manager timer.
  const forceKillLimitMs = quit.forceAtMs + 500;
  assert.ok(
    Number.isFinite(quit.forceKillMs) &&
      quit.forceKillMs >= 0 &&
      quit.forceKillMs < forceKillLimitMs,
    `Manager did not force-kill stubborn-ts before ${forceKillLimitMs} ms (${quit.forceKillMs})`,
  );
  // elapsedMs starts at before-quit, while forceAtMs is relative to shutdown().
  // Allow shared CI runner scheduling and exit reporting, still below supervisor escalation at 4 s.
  const quitLimitMs = quit.forceAtMs + 800;
  assert.ok(
    Number.isFinite(quit.elapsedMs) && quit.elapsedMs >= 0 && quit.elapsedMs < quitLimitMs,
    `Plugin quit took ${quit.elapsedMs} ms (force at ${quit.forceAtMs} ms + 800 ms grace)`,
  );
  assert.equal(quit.stubbornAlive, false, "stubborn-ts was still alive before Electron exited");
}
