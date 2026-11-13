import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const action = parse(readFileSync(new URL("./action.yml", import.meta.url), "utf8"));
const step = action.runs.steps.find((entry) => entry.run?.includes("apt-get"));

function runScenario(updateFailures, installFailures) {
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-eo",
      "pipefail",
      "-c",
      `
update_calls=0
install_calls=0
sudo() {
  printf 'CALL %s\\n' "$*"
  if [[ "$*" == *" update" ]]; then
    update_calls=$((update_calls + 1))
    ((update_calls > ${updateFailures}))
  else
    install_calls=$((install_calls + 1))
    ((install_calls > ${installFailures}))
  fi
}
sleep() { printf 'SLEEP %s\\n' "$1"; }
${step.run}
echo COMPLETED
`,
    ],
    { encoding: "utf8" },
  );
}

for (const scenario of [
  { name: "immediate success", update: 0, install: 0, calls: [1, 1], waits: [], status: 0 },
  { name: "update recovers", update: 2, install: 0, calls: [3, 1], waits: [10, 20], status: 0 },
  { name: "install recovers", update: 0, install: 2, calls: [3, 3], waits: [10, 20], status: 0 },
  { name: "update stays broken", update: 3, install: 0, calls: [3, 0], waits: [10, 20], status: 1 },
  {
    name: "install stays broken",
    update: 0,
    install: 3,
    calls: [3, 3],
    waits: [10, 20],
    status: 1,
  },
]) {
  test(scenario.name, () => {
    assert.equal(step.if, "runner.os == 'Linux'");
    assert.equal(step.shell, "bash");
    const result = runScenario(scenario.update, scenario.install);
    assert.ifError(result.error);
    assert.equal(result.status, scenario.status, result.stderr);
    const lines = result.stdout.split("\n");
    assert.equal(
      lines.filter(
        (line) =>
          line === "CALL apt-get -o Acquire::Retries=5 -o APT::Update::Error-Mode=any update",
      ).length,
      scenario.calls[0],
    );
    assert.equal(
      lines.filter(
        (line) =>
          line ===
          "CALL apt-get -o Acquire::Retries=5 install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev",
      ).length,
      scenario.calls[1],
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith("SLEEP ")),
      scenario.waits.map((wait) => `SLEEP ${wait}`),
    );
    assert.equal(lines.includes("COMPLETED"), scenario.status === 0);
    assert.equal(result.stdout.includes("::error::"), scenario.status !== 0);
  });
}
