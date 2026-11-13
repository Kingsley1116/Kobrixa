import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parse } from "yaml";
import {
  nativeHarnessArgs,
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

test("Windows native gates install the addon in temporary app roots without changing installed paths", () => {
  for (const gate of ["motor", "lab", "device"]) {
    for (const args of gates[gate].commands.filter((args) => args[0] !== "--test")) {
      assert.deepEqual(nativeHarnessArgs(args, "win32"), [
        "--import",
        "./tools/release/journal-harness.mjs",
        ...args,
      ]);
      for (const platform of ["darwin", "linux"])
        assert.deepEqual(nativeHarnessArgs(args, platform), args);
    }
  }
  for (const args of gates.installed.commands)
    assert.deepEqual(nativeHarnessArgs(args, "win32"), args);
});

// Count registrations, including loop-generated cases, under Windows skip
// conditions. Never invoke callbacks or load native addons: this is a workflow
// consistency check, not native execution evidence.
async function windowsJournalCases() {
  const url = new URL("./journal-win32-native.test.mjs", import.meta.url);
  const source = ts.createSourceFile(
    url.pathname,
    await readFile(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const registrations = [];
  const code = source.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(source))
    .join("\n")
    .replaceAll("import.meta.url", JSON.stringify(url.href));
  runInNewContext(code, {
    process: { platform: "win32", env: {} },
    createRequire: () => () => ({}),
    fileURLToPath,
    URL,
    path,
    Buffer,
    createHash,
    test(name, options, callback) {
      if (typeof options === "function") callback = options;
      else {
        assert.ok(!options.skip && !options.todo && !options.only, name);
      }
      assert.equal(typeof callback, "function", name);
      registrations.push(name);
    },
  });
  assert.ok(registrations.length > 0);
  assert.equal(new Set(registrations).size, registrations.length);
  return registrations.length;
}

test("Windows workflows build both native variants, retain evidence and prepare production before gates", async () => {
  const acceptance = parse(
    await readFile(path.join(root, ".github/workflows/stage-3-acceptance.yml"), "utf8"),
  );
  const ci = parse(await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"));
  const journal = acceptance.jobs["journal-win32"];
  assert.doesNotMatch(journal.name, /prototype/);
  const build = journal.steps.find((s) => s.name?.startsWith("Build production and test-hook"));
  for (const pattern of [
    /--journal_test_hooks=0/,
    /--journal_test_hooks=1/,
    /--target=\$electronVersion/,
    /--arch=x64/,
    /Get-FileHash/,
    /hashes.txt/,
  ])
    assert.match(build.run, pattern);
  assert.match(build.run, /createRequire.*apps\/desktop\/package\.json.*electron\/package\.json/);
  assert.doesNotMatch(build.run, /apps\/desktop\/node_modules\/electron/);
  const cases = await windowsJournalCases();
  assert.equal(journal.name, `Windows safety-journal native acceptance (${cases} cases)`);
  const suite = journal.steps.find(
    (s) => s.name === `Require all ${cases} native cases with no skips`,
  );
  assert.ok(suite, `workflow must require all ${cases} registered Windows cases`);
  assert.match(suite.run, new RegExp(`'tests ${cases}'`));
  assert.match(suite.run, new RegExp(`'pass ${cases}'`));
  assert.match(suite.run, /createRequire.*apps\/desktop\/package\.json.*electron/);
  assert.doesNotMatch(suite.run, /apps\/desktop\/node_modules\/electron/);
  assert.match(suite.run, /fail 0/);
  assert.match(suite.run, /skipped 0/);
  for (const job of [acceptance.jobs.native, ci.jobs.platform]) {
    const index = job.steps.findIndex((s) => s.run === "node tools/release/journal-win32.mjs");
    assert.ok(index > 0);
    assert.equal(job.steps[index].if, "runner.os == 'Windows'");
    assert.ok(
      index <
        job.steps.findIndex((s) =>
          /Execute required native gate|Declarative UI bridge/.test(s.name),
        ),
    );
    assert.ok(
      job.steps.some(
        (s) => s.uses?.startsWith("actions/upload-artifact") && s.if?.includes("always()"),
      ),
    );
  }
  const scripts = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts;
  assert.equal(
    (
      scripts["test:declarative-ui:smoke"].match(
        /--import \.\/tools\/release\/journal-harness.mjs/g,
      ) ?? []
    ).length,
    2,
  );
});
