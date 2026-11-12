import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const t = (name) => `tests/desktop/${name}`;
const oracle = [
  "--experimental-transform-types",
  "--import",
  "./tests/desktop/persistence-source-loader.mjs",
  "--test",
  "--test-reporter=tap",
  // This case launches a producer and writes PERSISTENCE_EVIDENCE. Keep supplied
  // report validation read-only; run the producer separately on the native host.
  "--test-skip-pattern=^BM-20 reference cases execute through createFoundationFixture$",
];
export const gates = {
  motor: {
    inputs: [],
    commands: [
      [t("motor-test-public-run.mjs"), "--all"],
      ["--test", t("motor-test-boundaries.test.mjs")],
    ],
  },
  lab: {
    inputs: ["Python >=3.10 (KOBRIXA_TEST_PYTHON or platform default)"],
    commands: [
      [t("sensor-lab-public-run.mjs"), "--run", "--restart"],
      [t("sensor-lab-stdio-run.mjs"), "--run"],
    ],
  },
  device: {
    inputs: ["Python >=3.10 (KOBRIXA_TEST_PYTHON or platform default)"],
    commands: [
      [t("device-ui-public-run.mjs"), "--run", "--restart"],
      [t("device-ui-stdio-run.mjs"), "--run"],
    ],
  },
  installed: {
    inputs: [
      "Final apps/desktop/out package",
      "Linux: networkless namespace plus Landlock; Windows: W17 observation/isolation support",
    ],
    commands: [
      [t("builtin-process-installed.mjs"), "--isolated"],
      [t("builtin-process-installed.mjs"), "--isolated", "--single-instance"],
    ],
  },
  b2: {
    inputs: [
      "PERSISTENCE_EVIDENCE: absolute complete aggregate report",
      "KOBRIXA_SINGLE_INSTANCE_REPORT: absolute native single-instance report",
    ],
    commands: [
      [
        ...oracle,
        ...["interop", "kill", "import", "load", "installed"].map((name) =>
          t(`plugin-persistence-${name}.test.mjs`),
        ),
      ],
    ],
  },
};

export function inventory(name = "all") {
  assert.ok(name === "all" || Object.hasOwn(gates, name), `Unknown gate: ${name}`);
  return Object.entries(gates)
    .filter(([key]) => name === "all" || key === name)
    .map(([gate, spec]) => ({
      gate,
      status: "NOT RUN (inventory only)",
      requiredInputs: [
        ...(gate === "b2"
          ? []
          : ["Built core/desktop dependencies and runnable Electron; Linux GUI requires Xvfb"]),
        ...spec.inputs,
      ],
      commands: spec.commands.map((args) => ({ executable: process.execPath, args, cwd: root })),
    }));
}

export async function requireReports(env) {
  for (const key of ["PERSISTENCE_EVIDENCE", "KOBRIXA_SINGLE_INSTANCE_REPORT"]) {
    assert.ok(env[key] && path.isAbsolute(env[key]), `${key} must name an absolute actual report`);
    const report = JSON.parse(await readFile(env[key], "utf8"));
    assert.ok(
      report && typeof report === "object" && !Array.isArray(report),
      `${key}: expected report object`,
    );
    if (key === "KOBRIXA_SINGLE_INSTANCE_REPORT") {
      assert.equal(
        report.status,
        "passed",
        "Full B2 requires completed single-instance evidence (W17)",
      );
      assert.deepEqual(report.unrun, [], "Full B2 cannot accept unrun single-instance fields");
    }
  }
}

export async function requireInstalledReceipt(output, singleInstance) {
  const matches = [...output.matchAll(/^Real installed product receipt: (.+)$/gm)];
  assert.equal(matches.length, 1, "Installed gate requires its actual emitted receipt");
  const file = matches[0][1].trim();
  assert.ok(path.isAbsolute(file), "Installed receipt path must be absolute");
  const report = JSON.parse(await readFile(file, "utf8"));
  assert.equal(report.status, "passed", "Partial installed evidence cannot pass full acceptance");
  if (singleInstance)
    assert.deepEqual(report.unrun, [], "Single-instance observations remain unrun");
}

export function nativeHarnessArgs(args, platform = process.platform) {
  return platform === "win32" &&
    [
      t("motor-test-public-run.mjs"),
      t("sensor-lab-public-run.mjs"),
      t("sensor-lab-stdio-run.mjs"),
      t("device-ui-public-run.mjs"),
      t("device-ui-stdio-run.mjs"),
    ].includes(args[0])
    ? ["--import", "./tools/release/journal-harness.mjs", ...args]
    : args;
}

export async function execute(args, env) {
  const child = spawn(process.execPath, nativeHarnessArgs(args), {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const [stream, destination] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ])
    stream.on("data", (bytes) => {
      output += bytes;
      destination.write(bytes);
    });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, `Failed command: ${JSON.stringify(args)}`);
  assert.doesNotMatch(
    output,
    /(?:^|\n)(?:NOT RUN\b|BUILD ONLY\b|HANDOFF\b)/i,
    "A handoff or unsupported run is not acceptance",
  );
  if (args[0] === t("builtin-process-installed.mjs"))
    await requireInstalledReceipt(output, args.includes("--single-instance"));
  assert.doesNotMatch(
    output,
    /# SKIP\b|# skipped [1-9]\d*/i,
    "Acceptance must not skip required observations",
  );
}

export async function runGate(name, { env = process.env, run = execute } = {}) {
  assert.ok(Object.hasOwn(gates, name), `Unknown gate: ${name}`);
  if (name === "b2") await requireReports(env);
  for (const args of gates[name].commands) await run(args, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [name = "all", mode, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, "Unexpected arguments");
  assert.ok(
    mode === "--inventory" || mode === "--run",
    "Use <gate|all> --inventory or <gate> --run",
  );
  if (mode === "--inventory") console.log(JSON.stringify(inventory(name), null, 2));
  else await runGate(name);
}
