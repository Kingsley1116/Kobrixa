import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the Electron `userData` directory to its canonical form before any
 * service reads it. Plugin persistence anchors its store at the real path and
 * refuses a `userData` whose ancestry still goes through a symlink, and macOS
 * keeps `os.tmpdir()` under `/var` → `/private/var`, so a profile passed via
 * `--user-data-dir` must be canonicalized by the host rather than rejected at
 * startup. Trailing components that do not exist yet are kept verbatim because
 * Electron creates the profile directory lazily.
 */
export function canonicalUserData(input: string): string {
  const absolute = path.resolve(input);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return absolute;
    }
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
}
