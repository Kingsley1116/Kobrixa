import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import {
  execute,
  gates,
  inventory,
  requireReports,
  requireInstalledReceipt,
  root,
  runGate,
} from "./stage-3-closeout-run.mjs";
import { resolvePython as labPython } from "./sensor-lab-stdio-run.mjs";
import { resolvePython as devicePython } from "./device-ui-stdio-run.mjs";

test("inventory exposes exact native producers and report inputs without a pass claim", () => {
  const rows = inventory();
  assert.deepEqual(
    rows.map((r) => r.gate),
    ["motor", "lab", "device", "installed", "b2"],
  );
  for (const row of rows) {
    assert.match(row.status, /NOT RUN/);
    for (const command of row.commands) assert.equal(command.executable, process.execPath);
  }
  assert.deepEqual(gates.motor.commands[0].slice(1), ["--all"]);
  assert.match(gates.motor.commands[1][1], /motor-test-boundaries/);
  for (const gate of ["lab", "device"]) {
    assert.deepEqual(gates[gate].commands[0].slice(1), ["--run", "--restart"]);
    assert.match(gates[gate].commands[1][0], /stdio-run/);
    assert.equal(gates[gate].commands[1][1], "--run");
  }
  assert.deepEqual(
    gates.installed.commands.map((c) => c.slice(1)),
    [["--isolated"], ["--isolated", "--single-instance"]],
  );
  assert.equal(gates.b2.commands[0].filter((p) => p.endsWith(".test.mjs")).length, 5);
  assert.throws(() => inventory("typo"), /Unknown gate/);
});

test("gate stops on first failure and never substitutes a handoff", async () => {
  const seen = [];
  await assert.rejects(
    runGate("motor", {
      run: async (args) => {
        seen.push(args);
        throw new Error("failed observation");
      },
    }),
    /failed observation/,
  );
  assert.equal(seen.length, 1);
  for (const text of [
    "NOT RUN on win32",
    "BUILD ONLY, no Electron",
    "HANDOFF pending",
    "# skipped 1",
    "ok 1 - observation # SKIP",
  ]) {
    await assert.rejects(
      execute(["-e", `console.log(${JSON.stringify(text)})`], process.env),
      /acceptance|skip/i,
    );
  }
  await assert.rejects(execute(["-e", "process.exit(7)"], process.env), /Failed command/);
  await execute(["-e", "console.log('executed wrapper child')"], process.env);
});

test("B2 requires both real file inputs before invoking any validator", async () => {
  await assert.rejects(
    runGate("b2", { env: {}, run: () => assert.fail("must not execute") }),
    /PERSISTENCE_EVIDENCE/,
  );
  await assert.rejects(requireReports({ PERSISTENCE_EVIDENCE: "relative.json" }), /absolute/);
  const dir = await mkdtemp(path.join(tmpdir(), "stage3-wrapper-"));
  try {
    const file = path.join(dir, "incomplete.json");
    await writeFile(file, JSON.stringify({ format: 1 }));
    await assert.rejects(
      requireReports({ PERSISTENCE_EVIDENCE: file }),
      /KOBRIXA_SINGLE_INSTANCE_REPORT/,
    );
    const single = path.join(dir, "single.json");
    await writeFile(single, JSON.stringify({ status: "partial", unrun: ["secondary-startup"] }));
    await assert.rejects(
      requireReports({ PERSISTENCE_EVIDENCE: file, KOBRIXA_SINGLE_INSTANCE_REPORT: single }),
      /completed single-instance/,
    );
    await assert.rejects(requireInstalledReceipt("HANDOFF", true), /actual emitted receipt/);
    await assert.rejects(
      requireInstalledReceipt(`Real installed product receipt: ${single}`, true),
      /Partial installed/,
    );
    await writeFile(single, JSON.stringify({ status: "passed", unrun: [] }));
    const env = {
      ...process.env,
      PERSISTENCE_EVIDENCE: file,
      KOBRIXA_SINGLE_INSTANCE_REPORT: single,
    };
    delete env.NODE_TEST_CONTEXT;
    // Execute the real independent validators: syntactically valid JSON is not acceptance.
    const result = spawnSync(
      process.execPath,
      ["tests/desktop/stage-3-closeout-run.mjs", "b2", "--run"],
      { cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /not ok.*B2-RF5: 50 maximum records/);
    await writeFile(file, "not JSON");
    await assert.rejects(requireReports(env), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stdio Python selection accepts commands, environment overrides and canonical executable paths", async () => {
  const command =
    process.env.KOBRIXA_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  for (const resolve of [labPython, devicePython]) {
    const actual = await resolve(command);
    assert.ok(path.isAbsolute(actual));
    assert.equal(await resolve(undefined, { KOBRIXA_TEST_PYTHON: command }), actual);
    assert.equal(await resolve(actual, { KOBRIXA_TEST_PYTHON: "missing-python" }), actual);
    const source = await readFile(
      new URL(
        resolve === labPython ? "./sensor-lab-stdio-run.mjs" : "./device-ui-stdio-run.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    assert.doesNotMatch(source, /\/private\/tmp/);
    assert.match(source, /identity.sourceHashes/);
    assert.match(source, /identity.artifactHashes/);
  }
});

test("slow native jobs are separately required on every platform; B2 consumes supplied reports", async () => {
  const read = async (file) => parse(await readFile(path.join(root, file), "utf8"));
  const ci = await read(".github/workflows/ci.yml");
  const acceptance = await read(".github/workflows/stage-3-acceptance.yml");
  assert.equal(ci.jobs.platform["timeout-minutes"], 30);
  assert.ok(ci.jobs.result.needs.includes("stage3"));
  assert.match(ci.jobs.result.steps.at(-1).run, /n.stage3.result !== expected/);
  assert.equal(ci.jobs.stage3.uses, "./.github/workflows/stage-3-acceptance.yml");
  const native = acceptance.jobs.native;
  assert.deepEqual(native.strategy.matrix.gate, ["motor", "lab", "device", "installed"]);
  assert.deepEqual(native.strategy.matrix.os, ["ubuntu-24.04", "windows-2022", "macos-26"]);
  const step = native.steps.find((s) => s.name === "Execute required native gate");
  assert.equal(step.if, undefined);
  assert.match(step.run, /xvfb-run/);
  assert.match(step.run, /unshare --net/);
  assert.match(step.run, /pipefail/);
  const b2 = acceptance.jobs["b2-reports"];
  assert.ok(b2.steps.some((s) => s.uses?.startsWith("actions/download-artifact@")));
  assert.ok(b2.steps.at(-1).env.PERSISTENCE_EVIDENCE);
  assert.ok(b2.steps.at(-1).env.KOBRIXA_SINGLE_INSTANCE_REPORT);
});
