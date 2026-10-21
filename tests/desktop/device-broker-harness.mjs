import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const broker = "apps/desktop/src/main/device-broker/";
const provider = "apps/desktop/src/main/device-providers/ev3/";
const runtime = "packages/plugin-runtime/src/";
const protocol = "packages/plugin-protocol/src/";
export const matrix = Object.freeze({
  F01: [runtime + "registry.test.ts", broker + "registry.test.ts"],
  F02: [broker + "rpc-router.test.ts", broker + "intent.test.ts"],
  F03: [broker + "broker.test.ts", broker + "authority-context.test.ts"],
  F04: [broker + "operations.test.ts"],
  F05: [
    broker + "operations.test.ts",
    provider + "motion.test.ts",
    broker + "legacy-files.test.ts",
  ],
  F06: [broker + "intent.test.ts", provider + "motion.test.ts"],
  F07: [broker + "sampler.test.ts", broker + "reservations.test.ts", broker + "operations.test.ts"],
  F08: [provider + "motion.test.ts"],
  F09: [
    broker + "fake-provider.test.ts",
    broker + "broker.test.ts",
    broker + "provider.test.ts",
    "packages/device/src/io-boundary.test.ts",
  ],
  F10: [broker + "journal.test.ts", broker + "journal-filesystem.test.ts"],
  F11: [broker + "recovery-port.test.ts"],
  F12: [broker + "reservations.test.ts", broker + "sampler.test.ts", broker + "legacy-lab.test.ts"],
  F13: [broker + "rpc-router.test.ts", "packages/plugin-sdk-js/src/events.test.ts"],
  F14: [broker + "legacy-device.test.ts", broker + "legacy-files.test.ts"],
  F15: ["apps/desktop/src/main/device/file-batch.test.ts", broker + "legacy-files.test.ts"],
  F16: ["packages/plugin-sdk-js/src/devices.test.ts", protocol + "device-contract.test.ts"],
  F17: [
    broker + "lifecycle-coordinator.test.ts",
    broker + "resource-participant.test.ts",
    runtime + "ui-lifecycle.test.ts",
  ],
  F18: [protocol + "business-result.test.ts", protocol + "device-contract.test.ts"],
  F19: [broker + "reservations.test.ts", broker + "lifecycle-coordinator.test.ts"],
  F20: ["apps/desktop/src/main/plugins/profile-writer-lock.test.ts", runtime + "manager.test.ts"],
  F21: [
    "packages/device/src/io-boundary.test.ts",
    provider + "motion.test.ts",
    broker + "provider.test.ts",
  ],
});

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
      env: {
        ...process.env,
        pnpm_config_pm_on_fail: "ignore",
        pnpm_config_verify_deps_before_run: "false",
        ...options.env,
      },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} exceeded the harness deadline`));
    }, options.timeoutMs ?? 180_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command}: exit ${code}, signal ${signal}`));
      else resolve({ code, signal });
    });
  });
}

export function assertMatrix(report) {
  assert.equal(report.cases.length, Object.keys(matrix).length);
  for (const id of Object.keys(matrix)) {
    const matches = report.cases.filter((entry) => entry.id === id);
    assert.equal(matches.length, 1, `${id}: missing/duplicate row`);
    assert.equal(matches[0].status, "passed", `${id}: incomplete evidence`);
    assert.ok(matches[0].assertions > 0, `${id}: zero assertions`);
  }
}

// Execute the installed JavaScript entrypoint directly; .cmd shims require a shell.
export function matrixInvocation(output) {
  const manifestPath = fileURLToPath(import.meta.resolve("vitest/package.json"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.vitest;
  return {
    command: process.execPath,
    args: [
      path.resolve(path.dirname(manifestPath), bin),
      "run",
      ...new Set(Object.values(matrix).flat()),
      "--reporter=json",
      `--outputFile=${output}`,
    ],
  };
}

export function matrixFromResults(result) {
  assert.equal(result.success, true);
  const missing = [];
  const cases = Object.entries(matrix).map(([id, files]) => {
    let assertions = 0;
    for (const file of files) {
      const suite = result.testResults.find((entry) =>
        entry.name.replaceAll("\\", "/").endsWith(file),
      );
      if (!suite) {
        missing.push(`${id}: ${file} did not execute`);
        continue;
      }
      const named = suite.assertionResults.filter((entry) =>
        new RegExp(`\\b${id}\\b`).test(entry.fullName),
      );
      if (!named.length) missing.push(`${id}: ${file} needs its assigned negative-case label`);
      for (const entry of named) assert.equal(entry.status, "passed", `${id}: ${entry.fullName}`);
      assertions += named.length;
    }
    return { id, status: "passed", assertions };
  });
  assert.deepEqual(missing, [], "Missing owner evidence (do not substitute a manual check)");
  return { cases };
}

export async function runOwnedMatrix() {
  const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-device-matrix-"));
  const output = path.join(temporary, "vitest.json");
  let passed = false;
  try {
    const invocation = matrixInvocation(output);
    await run(invocation.command, invocation.args);
    const result = JSON.parse(await readFile(output, "utf8"));
    const report = matrixFromResults(result);
    passed = true;
    return report;
  } finally {
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`Device matrix artifacts: ${temporary}`);
  }
}

export const percentile = (values, fraction) => {
  assert.ok(values.length > 0);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  return [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1];
};
export function assertParity(report) {
  const expected = [
    "negotiate",
    "list",
    "session",
    "read",
    "subscribe",
    "mode-query",
    "mode-set",
    "reserve",
    "recording-read",
    "release",
    "prepare",
    "start",
    "stop",
    "query",
    "unsubscribe",
  ];
  assert.equal(report.transports.length, 2);
  for (const [language, transport] of [
    ["js", "electron-message-port"],
    ["python", "content-length"],
  ]) {
    const result = report.transports.find((entry) => entry.language === language);
    assert.ok(result);
    assert.equal(result.transport, transport);
    assert.equal(result.ok, true);
    assert.deepEqual(result.scenario, expected);
    const receipt = result.eventReceipt;
    assert.equal(receipt?.kind, "devices.telemetry", `${language}: missing SDK event receipt`);
    assert.ok(typeof receipt.subscriptionId === "string" && receipt.subscriptionId.length > 0);
    assert.ok(typeof receipt.sessionId === "string" && receipt.sessionId.length > 0);
    assert.ok(Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0);
    assert.deepEqual(
      result.acknowledged,
      {
        subscriptionId: receipt.subscriptionId,
        sequence: receipt.sequence,
      },
      `${language}: SDK receipt has no correlated successful ACK`,
    );
  }
}
export function assertArtifactIdentity(report, identity) {
  assert.match(identity.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof identity.artifact.dirty, "boolean");
  assert.ok(Object.keys(identity.artifact.sha256).length > 0);
  for (const hash of Object.values(identity.artifact.sha256)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(report.commit, identity.commit, "artifact commit differs from captured identity");
  assert.deepEqual(report.artifact, identity.artifact, "artifact differs from captured identity");
}

export function assertLoad(report, identity) {
  assertArtifactIdentity(
    { commit: report.environment.commit, artifact: report.environment.bundle },
    identity,
  );
  assert.ok(report.durationMs >= 600_000);
  assert.deepEqual(report.scale, {
    channels: 38,
    actuators: 4,
    providers: 8,
    candidatesPerProvider: 32,
    candidatesGlobal: 64,
    subscriptions: 32,
    queueBytes: 262_144,
    journalEntries: 64,
  });
  assert.ok(report.stopDispatchMs.length >= 100);
  assert.ok(report.traffic?.peakQueuedBytes > 0 && report.traffic.peakQueuedBytes <= 262_144);
  assert.ok(report.traffic.overflowFrames > 0, "no observed telemetry overflow pressure");
  assert.ok(percentile(report.stopDispatchMs, 0.95) <= 50, "stop dispatch p95 exceeds 50 ms");
  for (const phase of ["transport", "readback", "journal"])
    percentile(report.measurements[phase], 0.95);
  for (const key of [
    "commit",
    "artifact",
    "os",
    "arch",
    "cpu",
    "ramBytes",
    "filesystem",
    "node",
    "electron",
    "warmCold",
    "memoryMethod",
  ])
    assert.ok(report.environment[key], `Missing environment.${key}`);
  assert.match(report.environment.commit, /^[0-9a-f]{40}$/);
  assert.ok(report.retainedHeap.length >= 11);
  assert.ok(report.retainedHeap.at(-1).elapsedMs >= 600_000);
  // Local leak detector, not a new product budget. Last-half growth must fit the
  // first-half measured oscillation; monotonically growing retention fails.
  const values = report.retainedHeap.map((entry) => entry.bytes);
  assert.ok(values.every((value) => Number.isSafeInteger(value) && value >= 0));
  const first = values.slice(1, 6),
    last = values.slice(-5);
  const noise = Math.max(...first) - Math.min(...first);
  assert.ok(Math.max(...last) <= Math.max(...first) + noise, "retained heap keeps growing");
}
