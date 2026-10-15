import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { BuildError } from "./build-error.js";
export interface LockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pidAlive?: (pid: number) => boolean;
}
let lastStartedAt = 0;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function acquireOutputLock(
  outputDir: string,
  signal: AbortSignal,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const file = path.join(outputDir, ".kobrixa-build.lock");
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pidAlive = options.pidAlive ?? alive;
  const deadline = now() + 5_000;
  const startedAt = (lastStartedAt = Math.max(now(), lastStartedAt + 1));
  const content = JSON.stringify({ pid: process.pid, startedAt });
  let reclaimed = false;
  for (;;) {
    signal.throwIfAborted();
    if (now() >= deadline)
      throw new BuildError(
        "BUILD1004",
        "Another Kobrixa window is writing this project's build output.",
      );
    try {
      const handle = await open(file, "wx");
      const identity = await handle.stat();
      try {
        await handle.writeFile(content, "utf8");
      } catch (error) {
        const current = await lstat(file).catch(() => undefined);
        if (current?.ino === identity.ino && current.dev === identity.dev)
          await unlink(file).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = await lstat(file);
          if (
            current.dev === identity.dev &&
            current.ino === identity.ino &&
            (await readFile(file, "utf8")) === content
          )
            await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!reclaimed) {
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink())
          throw new BuildError("BUILD1004", "The build lock path is a symbolic link.");
        const existing = await readFile(file, "utf8");
        let stale = false;
        try {
          const value = JSON.parse(existing) as { pid?: unknown; startedAt?: unknown };
          if (
            !value ||
            !Number.isSafeInteger(value.pid) ||
            Number(value.pid) <= 0 ||
            typeof value.startedAt !== "number" ||
            !Number.isFinite(value.startedAt)
          )
            throw new Error("Malformed lock");
          stale = !pidAlive(Number(value.pid));
        } catch {
          stale = now() - info.mtimeMs > 60_000;
        }
        if (stale) {
          const current = await lstat(file);
          if (
            current.ino === info.ino &&
            current.dev === info.dev &&
            (await readFile(file, "utf8")) === existing
          ) {
            await unlink(file);
            reclaimed = true;
            continue;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    await sleep(Math.min(100, deadline - now()));
  }
}
