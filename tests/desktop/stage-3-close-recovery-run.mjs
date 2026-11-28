import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const scenarios = ["record", "settings"].flatMap((operation) =>
  ["disable", "close", "update"].flatMap((transition) =>
    ["none", "before-publish"].map((fault) => ({ operation, transition, fault })),
  ),
);
export const incomplete = [
  "Product command/motion/read/checkpoint/settings commit × disable/close/update",
  "Real provider stop and safety-journal failure, including 15+5-second device deadline",
  "Stuck SDK drain at 10 seconds and 24/25-second product shutdown boundaries",
  "Disk-full, user save retry and sealed-payload TTL through product recovery UI",
  "Forced application exit and cold product restart (worker termination is narrower)",
  "Real OS suspend/wake and no motion/recording replay",
  "Product utility/renderer process-tree cleanup and W18a lifetime join",
];
const requiredSources = [
  "tests/desktop/stage-3-close-recovery-main.ts",
  "tests/desktop/stage-3-close-recovery-run.mjs",
  "tests/desktop/stage-3-close-recovery.test.mjs",
  "apps/desktop/src/main/device-broker/lifecycle-coordinator.ts",
  "apps/desktop/src/main/updates/installation.ts",
  "apps/desktop/src/main/plugins/persistence/worker.ts",
  "apps/desktop/src/main/plugins/persistence/host-port.ts",
];
export async function buildCloseRecovery(directory, native = false) {
  await mkdir(directory, { recursive: true });
  const sourceHashes = {},
    artifactHashes = {};
  const main = path.join(root, "tests/desktop/stage-3-close-recovery-main.ts");
  const worker = path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts");
  const primary = path.join(root, "apps/desktop/src/main/plugins/profile-writer-lock.ts");
  const execute = `
    import {runPublication, runRecovery} from ${JSON.stringify(main)};
    import {writeFile} from 'node:fs/promises';
    import {readFileSync} from 'node:fs';
    import {randomUUID} from 'node:crypto';
    const config = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
    const run = async (profile) => {
      const input = {...config, profile};
      const observation = config.point ? await runRecovery(input, config.point) : await runPublication(input, config.scenario);
      await writeFile(config.output, JSON.stringify({observation, pid:process.pid, node:process.versions.node, electron:process.versions.electron ?? null}));
    };
    ${
      native
        ? `
      import {app, dialog} from 'electron';
      import {startPrimary} from ${JSON.stringify(primary)};
      const fail = (error) => {console.error(error); app.exit(1);};
      process.removeAllListeners('uncaughtException');
      process.on('uncaughtException', fail);
      process.on('unhandledRejection', fail);
      dialog.showErrorBox = (title, content) => fail(new Error(title + ': ' + content));
      if (app.isReady()) throw new Error('Primary lock must precede readiness');
      app.setPath('userData', config.directory);
      const primary = startPrimary(app, run, () => false);
      if (!primary) throw new Error('Primary profile lock refused');
      primary.ready.then(() => app.exit(0), (error) => {console.error(error); app.exit(1);});
    `
        : `await run({hostEpoch:randomUUID(),assertHeld(){}});`
    }
  `;
  for (const [name, source, format] of [
    ["main", execute, "esm"],
    [
      "worker",
      `import {runPersistenceWorker} from ${JSON.stringify(worker)}; runPersistenceWorker({mappers:new Map()});`,
      "cjs",
    ],
  ]) {
    const outfile = path.join(directory, `${name}.${format === "cjs" ? "cjs" : "mjs"}`);
    const result = await build({
      stdin: { contents: source, resolveDir: root, sourcefile: `${name}-entry.ts`, loader: "ts" },
      outfile,
      absWorkingDir: root,
      bundle: true,
      platform: "node",
      format,
      target: "node24",
      external: ["electron"],
      metafile: true,
      tsconfig: path.join(root, "tsconfig.base.json"),
    });
    artifactHashes[path.basename(outfile)] = hash(await readFile(outfile));
    for (const file of Object.keys(result.metafile.inputs)) {
      if (file === `${name}-entry.ts` || file.startsWith("<")) continue;
      const source = file.replace(/\?raw$/, "");
      sourceHashes[source] = hash(await readFile(path.resolve(root, source)));
    }
  }
  for (const file of requiredSources)
    sourceHashes[file] = hash(await readFile(path.join(root, file)));
  const identity = { sourceHashes, artifactHashes, native, scope: "acceptance-host-real-worker" };
  await writeFile(path.join(directory, "identity.json"), JSON.stringify(identity, null, 2));
  return identity;
}

function event(row, name) {
  const events = row.events.filter((entry) => entry.event === name);
  assert.equal(events.length, 1, `Missing/duplicate ${name}`);
  assert.ok(Number.isFinite(events[0].at) && events[0].at >= 0);
  return events[0].at;
}
export function verifyObservation(row) {
  assert.deepEqual(row.cleanup, { workers: 0, workerJobs: 0 });
  assert.ok(
    scenarios.some((scenario) => JSON.stringify(row.scenario) === JSON.stringify(scenario)),
  );
  const { scenario, ticket, publication } = row;
  assert.deepEqual(ticket.owner, row.owner);
  assert.equal(ticket.metadata.kind, scenario.operation);
  assert.ok(row.offers.length > 0);
  for (const offer of row.offers) {
    assert.ok(Number.isFinite(offer.started) && Number.isFinite(offer.deadline));
    assert.ok(offer.deadline > offer.started && offer.deadline - offer.started <= 10000);
  }
  assert.ok(event(row, "worker-paused") <= event(row, "transition-start"));
  assert.ok(event(row, "transition-start") < event(row, "pending-observed"));
  const released = event(
    row,
    scenario.fault === "none" ? "worker-released" : "worker-terminated-before-publish",
  );
  assert.ok(event(row, "pending-observed") <= released);
  assert.ok(released <= event(row, "publication-result"));
  assert.ok(released <= event(row, "transition-settled"));
  assert.ok(event(row, "transition-settled") <= event(row, "worker-cleanup-observed"));
  const trace = row.trace.filter((entry) => entry.ticket === ticket.id);
  assert.ok(trace.some((entry) => entry.point === "before-publish"));
  assert.equal(row.reports.length, 1);
  assert.deepEqual(row.reports[0].owner, row.owner);
  if (scenario.fault === "none") {
    assert.equal(row.publicationError, null);
    assert.equal(publication.disposition, "committed");
    assert.ok(publication.receipt.commitId);
    assert.equal(row.outcome.rejected, false);
    assert.equal(row.reports[0].storage.state, "saved");
    assert.equal(row.reports[0].storage.blocker, false);
    assert.equal(row.reports[0].storage.pendingSettings, false);
    assert.deepEqual(row.reports[0].storage.errors, []);
    assert.deepEqual(row.errors, []);
    assert.ok(trace.some((entry) => entry.point === "after-publish"));
    assert.equal(row.shutdowns, scenario.transition === "disable" ? 0 : 1);
    assert.equal(row.installs, scenario.transition === "update" ? 1 : 0);
    if (scenario.operation === "record") {
      assert.equal(row.readback.bytes, row.payload);
      assert.equal(row.readback.meta.sha256, hash(Buffer.from(row.payload, "base64")));
      assert.equal(row.readback.meta.revision, publication.receipt.revision);
    } else {
      assert.deepEqual(row.readback.values, JSON.parse(Buffer.from(row.payload, "base64")).values);
      assert.equal(row.readback.revision, publication.receipt.revision);
    }
  } else {
    assert.notEqual(publication?.disposition, "committed");
    assert.equal(publication?.receipt, undefined);
    assert.ok(publication || typeof row.publicationError === "string");
    assert.equal(row.reply.ok, false);
    assert.equal(row.reports[0].blocker, true);
    assert.equal(row.reports[0].storage.blocker, true);
    assert.equal(row.outcome.rejected, scenario.transition !== "disable");
    assert.equal(row.shutdowns, 0);
    assert.equal(row.installs, 0);
    assert.equal(row.readback, null);
    assert.ok(!trace.some((entry) => entry.point === "after-publish"));
  }
  if (scenario.transition === "update") {
    assert.ok(event(row, "update-prepare") < event(row, "pending-observed"));
    if (scenario.fault === "none")
      assert.ok(event(row, "install-adapter") >= event(row, "transition-settled"));
  }
}
export function verifyRecovery(row) {
  assert.deepEqual(row.cleanup, { terminatedWorkers: 0, reopenedWorkers: 0, workerJobs: 0 });
  assert.ok(["before-publish", "after-publish"].includes(row.point));
  assert.equal(row.recovery, "ready");
  assert.ok(row.interruptedPublication.result || row.interruptedPublication.error);
  assert.notEqual(row.interruptedPublication.result?.disposition, "committed");
  assert.notEqual(row.old.id, row.next.id);
  assert.equal(row.next.target.id, row.old.target.id);
  assert.equal(row.next.target.expectedRevision, row.old.metadata.record.revision);
  const expected = row.point === "before-publish" ? row.old : row.next;
  assert.equal(row.readback.meta.revision, expected.metadata.record.revision);
  assert.equal(row.readback.meta.sha256, hash(Buffer.from(row.readback.bytes, "base64")));
  assert.equal(row.readback.meta.sha256, expected.metadata.record.sha256);
  assert.equal(row.readback.bytes, row.expected);
  assert.ok(row.trace.some((entry) => entry.point === row.point && entry.ticket === row.next.id));
  assert.ok(
    !row.restartTrace.some((entry) => entry.ticket === row.next.id),
    "Restart must not republish the old ticket",
  );
}
export function verifyReceipt(receipt, { requireProduct = false } = {}) {
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.identity.scope, "acceptance-host-real-worker");
  assert.deepEqual(receipt.incomplete, incomplete);
  assert.equal(receipt.runs.length, scenarios.length + 2);
  for (const file of requiredSources)
    assert.match(receipt.identity.sourceHashes[file], /^[a-f0-9]{64}$/);
  for (const file of ["main.mjs", "worker.cjs"])
    assert.match(receipt.identity.artifactHashes[file], /^[a-f0-9]{64}$/);
  receipt.runs.forEach((run, index) => {
    assert.equal(run.exit.code, 0);
    assert.equal(run.exit.signal, null);
    assert.equal(run.exit.timedOut, false);
    assert.ok(Number.isSafeInteger(run.pid) && run.pid > 0);
    assert.equal(run.exit.pid, run.pid);
    assert.equal(typeof run.node, "string");
    if (receipt.identity.native) assert.equal(typeof run.electron, "string");
    else assert.equal(run.electron, null);
    if (index < scenarios.length) {
      assert.deepEqual(run.observation.scenario, scenarios[index]);
      verifyObservation(run.observation);
    } else {
      assert.equal(
        run.observation.point,
        index === scenarios.length ? "before-publish" : "after-publish",
      );
      verifyRecovery(run.observation);
    }
  });
  assert.equal(
    requireProduct,
    false,
    "Incomplete W18b product matrix; acceptance-host receipts cannot close W18b",
  );
  return { status: "partial", publicationRows: scenarios.length, recoveryRows: 2 };
}

export async function verifyArtifacts(directory, identity) {
  for (const file of ["main.mjs", "worker.cjs"])
    assert.equal(
      hash(await readFile(path.join(directory, file))),
      identity.artifactHashes[file],
      `Changed artifact: ${file}`,
    );
}

async function runChild(directory, config, native) {
  const configPath = path.join(directory, "config.json");
  await mkdir(config.directory, { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const executable = native ? require("electron") : process.execPath;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [path.join(path.dirname(directory), "main.mjs"), configPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => logs.push(bytes.toString()));
  let timedOut = false;
  // Harness ceiling only; production 10/20/24/25-second clocks are unchanged.
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 45000);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, pid: child.pid }));
    });
  } finally {
    clearTimeout(timer);
  }
  await writeFile(path.join(directory, "process.log"), logs.join(""));
  await writeFile(path.join(directory, "exit.json"), JSON.stringify({ ...exit, timedOut }));
  if (timedOut || exit.code !== 0 || exit.signal !== null) {
    let failure = null;
    try {
      failure = JSON.parse(await readFile(path.join(config.directory, "failure.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { failure, exit: { ...exit, timedOut }, log: path.join(directory, "process.log") };
  }
  return { ...JSON.parse(await readFile(config.output, "utf8")), exit: { ...exit, timedOut } };
}
export async function runCloseRecovery(directory, native = false) {
  const identity = await buildCloseRecovery(directory, native);
  const runs = [];
  for (const [index, selection] of [
    ...scenarios.map((scenario) => ({ scenario })),
    { point: "before-publish" },
    { point: "after-publish" },
  ].entries()) {
    const trial = path.join(directory, String(index));
    await mkdir(trial);
    const run = await runChild(
      trial,
      {
        ...selection,
        directory: path.join(trial, "profile"),
        workerEntry: path.join(directory, "worker.cjs"),
        output: path.join(trial, "observation.json"),
      },
      native,
    );
    runs.push(run);
    console.log(
      `${run.exit.code === 0 && !run.exit.timedOut ? "Observed" : "FAILED"} ${index + 1}/14: ${JSON.stringify(selection)}`,
    );
  }
  const failed = runs.some(
    (run) => run.exit.code !== 0 || run.exit.signal !== null || run.exit.timedOut,
  );
  const receipt = { schema: 1, status: failed ? "failed" : "partial", identity, incomplete, runs };
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  await verifyArtifacts(directory, identity);
  // Reject concurrent changes to any bundled input, not only the entry point.
  for (const [file, expected] of Object.entries(identity.sourceHashes))
    assert.equal(
      hash(await readFile(path.resolve(root, file))),
      expected,
      `Source changed during run: ${file}`,
    );
  verifyReceipt(receipt);
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, receiptPath] = process.argv.slice(2);
  assert.ok(
    ["--run", "--worker-run", "--build-only", "--verify", "--verify-product"].includes(mode),
    "Use --run (Electron) | --worker-run (Node, worker integration only) | --build-only | --verify <receipt> | --verify-product <receipt>",
  );
  if (mode.startsWith("--verify")) {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await verifyArtifacts(path.dirname(path.resolve(receiptPath)), receipt.identity);
    console.log(
      verifyReceipt(receipt, {
        requireProduct: mode === "--verify-product",
      }),
    );
  } else {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-close-recovery-")));
    console.log(`W18b artifacts: ${directory}`);
    if (mode === "--build-only") await buildCloseRecovery(directory, true);
    else await runCloseRecovery(directory, mode === "--run");
    console.log(
      mode === "--build-only"
        ? "BUILD ONLY; no native observation"
        : `PARTIAL integration receipt: ${directory}/receipt.json; W18b product criteria remain open`,
    );
  }
}
