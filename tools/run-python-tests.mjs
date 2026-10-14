// Runs the Python SDK unit tests with a local Python 3.10+; CI must provide one.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const candidates = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(Boolean);
const python = candidates.find(
  (command) =>
    spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
      .status === 0,
);
if (!python) {
  if (process.env.CI) {
    console.error("Python 3.10+ is required in CI. Set KOBRIXA_TEST_PYTHON.");
    process.exit(1);
  }
  console.warn("SKIP Python SDK tests: Python 3.10+ was not found.");
  process.exit(0);
}
const sdk = path.join(root, "sdks/python");
const result = spawnSync(
  python,
  ["-m", "unittest", "discover", "-s", path.join(sdk, "tests"), "-t", sdk, "-v"],
  {
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: sdk },
  },
);
process.exit(result.status ?? 1);
