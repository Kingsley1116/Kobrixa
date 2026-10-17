// Shared fixture data: validation may compile, but never match this in Node/Vitest.
// The lookahead also excludes V8's optional excessive-backtracking fallback.
export const HOSTILE_PATTERN = "(?=a)(a+)+$";
export const HOSTILE_COMPILED_PATTERN = `^(?:${HOSTILE_PATTERN})`;
export const HOSTILE_DOCUMENT = "a".repeat(128) + "!";
export const STRESS_EVENT_PREFIX = "STATIC_LANGUAGE_STRESS ";
export const STRESS_STARTUP_MS = 15_000;
export const STRESS_KILL_MS = 5_000;

export function killStaticAcceptanceChild(child, rendererPid) {
  // The runner gives this child its own POSIX process group. Kill descendants
  // too: killing only Electron main can leave the CPU-bound renderer orphaned.
  if (child.pid && process.platform !== "win32") {
    try {
      return process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  // Windows has no process groups; explicitly kill the known renderer as well.
  const killed = child.kill("SIGKILL");
  if (process.platform === "win32" && rendererPid) {
    try {
      process.kill(rendererPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  return killed;
}

/** Parent-only supervisor. Timers and SIGKILL never depend on Electron's event loop. */
export function waitForHostileTermination(
  child,
  { startupMs = STRESS_STARTUP_MS, killMs = STRESS_KILL_MS } = {},
) {
  const started = performance.now();
  let readyAt;
  let enteredAt;
  let ready;
  let entered;
  let unresponsive = false;
  let killReason;
  let killAccepted = false;
  let buffer = "";
  let timer;
  let reapTimer;
  const killTree = () => killStaticAcceptanceChild(child, ready?.rendererPid);
  const onParentExit = () => killTree();
  process.once("exit", onParentExit);
  let onData;
  return new Promise((resolve, reject) => {
    const kill = (reason) => {
      killReason = reason;
      try {
        killAccepted = killTree();
      } catch (error) {
        reject(error);
      }
      reapTimer = setTimeout(
        () => reject(new Error("Hostile Electron did not report exit after SIGKILL")),
        2000,
      );
    };
    timer = setTimeout(() => kill("startup-timeout"), startupMs);
    onData = (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith(STRESS_EVENT_PREFIX)) continue;
        try {
          const event = JSON.parse(line.slice(STRESS_EVENT_PREFIX.length));
          if (event.type === "ready" && !ready && !killReason) {
            ready = event;
            readyAt = performance.now();
            clearTimeout(timer);
            timer = setTimeout(() => kill("tokenization-deadline"), killMs);
          } else if (event.type === "regex-entered" && ready && !entered && !killReason) {
            entered = event;
            enteredAt = performance.now();
          } else if (event.type === "unresponsive") unresponsive = true;
          else if (event.type === "regex-returned")
            throw new Error("Hostile regex returned before the parent's kill deadline");
        } catch (error) {
          reject(error);
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const proof = {
        pid: child.pid,
        startupMs,
        killMs,
        readyAfterMs: readyAt === undefined ? null : Math.round(readyAt - started),
        killedAfterReadyMs: readyAt === undefined ? null : Math.round(performance.now() - readyAt),
        killedAfterEntryMs:
          enteredAt === undefined ? null : Math.round(performance.now() - enteredAt),
        killReason,
        killAccepted,
        code,
        signal,
        ready,
        entered,
        unresponsive,
      };
      if (
        killReason !== "tokenization-deadline" ||
        !killAccepted ||
        code !== null ||
        signal !== "SIGKILL" ||
        !ready ||
        !entered
      )
        reject(
          new Error(`Missing parent SIGKILL / Monaco regex entry proof: ${JSON.stringify(proof)}`),
        );
      else resolve(proof);
    });
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(reapTimer);
    child.stdout.off("data", onData);
    process.off("exit", onParentExit);
    killTree();
  });
}
