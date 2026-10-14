import { spawnSync } from "node:child_process";

/** Test helper: a Python 3.10+ command, or undefined outside CI. */
export function findPython(): string | undefined {
  const candidates = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(
    (item): item is string => Boolean(item),
  );
  const found = candidates.find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
        .status === 0,
  );
  if (!found && process.env.CI)
    throw new Error("Python 3.10+ is required in CI. Set KOBRIXA_TEST_PYTHON.");
  return found;
}
