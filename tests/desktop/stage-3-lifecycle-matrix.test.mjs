import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inventory,
  lifecycle,
  authorityRows,
  persistenceCases,
  deadlines,
  grantRule,
  historicalUiChecks,
  verifyHistoricalUiMatrix,
  verifySourceIdentity,
  validateLifecycleEvidence,
  requireCurrentFoundation,
  verifyFoundationArtifact,
} from "./stage-3-lifecycle-matrix.mjs";

const root = new URL("../../", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = "tests/desktop/stage-3-lifecycle-matrix.mjs";
async function input() {
  // Deliberately synthetic identity, only for verifier tests; never acceptance evidence.
  return {
    format: 1,
    identity: {
      commit: "1".repeat(40),
      apiVersion: "1.8.0",
      sourceHashes: { [source]: hash(await readFile(new URL(source, root))) },
    },
  };
}
async function temporary(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "w13a-oracle-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("§4.7 inventory names all eleven events, both lifetimes, original grants/budgets and blockers", async () => {
  assert.deepEqual(
    lifecycle.map((r) => r.id),
    [
      "panel-hide",
      "panel-close",
      "window-loss",
      "os-suspend",
      "second-instance-launch",
      "feature-disable",
      "provider-disable",
      "renderer-crash",
      "plugin-crash",
      "app-shutdown",
      "safe-mode",
    ],
  );
  const spec = await readFile(
    new URL("docs/superpowers/specs/2026-10-17-plugin-system-stage-3-design.md", root),
    "utf8",
  );
  const section = spec.split("### 4.7 ")[1].split("### 4.8 ")[0];
  assert.equal(
    section
      .split("\n")
      .filter(
        (line) => line.startsWith("| ") && !line.startsWith("| 事件") && !line.startsWith("| --"),
      ).length,
    lifecycle.length,
  );
  for (const row of lifecycle) {
    for (const field of ["motor", "lab", "blocker"])
      assert.ok(row[field].length > 40, `${row.id}.${field}`);
    assert.equal(row.grantRule, grantRule);
    assert.deepEqual(row.deadlines, deadlines);
    assert.ok(row.gap.owner && row.gap.reason);
    assert.equal(row.status, "not-observed");
    for (const id of row.persistenceCases) assert.ok(persistenceCases.includes(id));
    for (const reference of row.tests)
      assert.ok(
        (await readFile(new URL(reference.file, root), "utf8")).includes(reference.name),
        `${row.id}: missing ${reference.name}`,
      );
  }
});
test("authority inventory keeps named executable tests separate from integrated product gaps", async () => {
  assert.equal(authorityRows.length, 7);
  for (const row of authorityRows) {
    assert.ok(row.expectation && row.gap.startsWith("W18:"));
    for (const reference of row.tests)
      assert.ok(
        (await readFile(new URL(reference.file, root), "utf8")).includes(reference.name),
        reference.name,
      );
  }
});
test("fixed deadlines retain 10 / 15+5 / 4 / 24 / 25 seconds and original staging TTL", () => {
  assert.deepEqual(deadlines, {
    gestureCadenceMs: 100,
    gestureExpiryMs: 350,
    drainMs: 10000,
    stopMs: 15000,
    journalMs: 5000,
    managerMs: 4000,
    shutdownRequestMs: 2000,
    cleanupMs: 24000,
    outerSafetyNetMs: 25000,
    stagingIdleMs: 30000,
    stagingTotalMs: 120000,
    motorExchangeMs: 2000,
    ordinaryExchangeMs: 5000,
    fileExchangeMs: 10000,
  });
  assert.equal(
    Math.max(deadlines.drainMs, deadlines.stopMs + deadlines.journalMs) + deadlines.managerMs,
    deadlines.cleanupMs,
  );
});
test("index contains F01–F21/U01–U17 and real replacements without inventing a foundation file", () => {
  const result = inventory();
  assert.deepEqual(
    result.broker.map((r) => r.id),
    Array.from({ length: 21 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
  );
  assert.deepEqual(
    result.ui.map((r) => r.id),
    Array.from({ length: 17 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`),
  );
  assert.deepEqual(result.ui.find((r) => r.id === "U12").replacement, [...persistenceCases]);
  assert.doesNotMatch(JSON.stringify(result), /stage-3-foundations-main/);
  assert.equal(result.fullPass, false);
  assert.throws(() => requireCurrentFoundation(result), /missing current foundation/);
  result.lifecycle[0].status = "passed";
  assert.equal(inventory().lifecycle[0].status, "not-observed");
});
test("empty current observations remain incomplete and cannot pass the evidence gate", async () => {
  const result = await validateLifecycleEvidence(await input());
  assert.ok(result.persistence.every((r) => r.status === "not-observed"));
  assert.ok(result.lifecycle.every((r) => r.status === "not-observed"));
  assert.equal(result.fullPass, false);
  assert.throws(() => requireCurrentFoundation(result));
});
for (const [name, mutate] of [
  ["old API", (i) => (i.identity.apiVersion = "1.7.0")],
  ["symbolic commit", (i) => (i.identity.commit = "P170")],
  ["empty source hashes", (i) => (i.identity.sourceHashes = {})],
  ["stale source bytes", (i) => (i.identity.sourceHashes[source] = "0".repeat(64))],
  ["escaping source", (i) => (i.identity.sourceHashes = { "../outside": "0".repeat(64) })],
])
  test(`provenance rejects ${name}`, async () => {
    const i = await input();
    mutate(i);
    await assert.rejects(() => verifySourceIdentity(i.identity));
  });
test("receipt content cannot change behind a retained SHA and broker evidence needs full owner sources", () =>
  temporary(async (directory) => {
    const i = await input();
    const receipt = JSON.stringify({
      format: 1,
      level: "real-process",
      status: "scoped-case",
      cases: [],
      reports: [],
    });
    await writeFile(path.join(directory, "receipt.json"), receipt);
    i.persistence = [{ path: "receipt.json", sha256: "0".repeat(64) }];
    await assert.rejects(() => validateLifecycleEvidence(i, { directory }), /changed evidence/);
    i.persistence[0].sha256 = hash(receipt);
    await assert.rejects(
      () => validateLifecycleEvidence(i, { directory }),
      /empty foundation receipt/,
    );
    delete i.persistence;
    i.broker = { path: "receipt.json", sha256: hash(receipt) };
    await assert.rejects(
      () => validateLifecycleEvidence(i, { directory }),
      /missing source identity/,
    );
  }));
for (const [name, patch] of [
  ["fixture level", { level: "unit" }],
  ["full-pass label", { status: "passed" }],
  ["unmapped case", { cases: ["installed"], reports: [{ case: "installed" }] }],
  ["case-list mismatch", { cases: ["healthy-release"], reports: [{ case: "retirement" }] }],
  [
    "cross-version",
    { cases: ["healthy-release"], reports: [{ case: "healthy-release", commit: "2".repeat(40) }] },
  ],
])
  test(`supplied foundation wrapper rejects ${name}`, () =>
    temporary(async (directory) => {
      const i = await input();
      const raw = {
        format: 1,
        level: "real-process",
        status: "scoped-case",
        cases: ["healthy-release"],
        reports: [{ case: "healthy-release", commit: i.identity.commit }],
        ...patch,
      };
      const bytes = JSON.stringify(raw);
      await writeFile(path.join(directory, "receipt.json"), bytes);
      i.persistence = [{ path: "receipt.json", sha256: hash(bytes) }];
      await assert.rejects(() => validateLifecycleEvidence(i, { directory }));
    }));
test("B1 historical checks retain actual persistence exception and all original gates", async () => {
  assert.equal(Object.keys(historicalUiChecks).length, 16);
  assert.ok(!historicalUiChecks.U12);
  await assert.rejects(() => verifyHistoricalUiMatrix({}), /U01/);
  await assert.rejects(
    () => verifyHistoricalUiMatrix({ U01: { level: "port-fixture", proof: [] } }),
    /mock\/port fixture/,
  );
  const u16 = {
    rejected: Object.fromEntries(
      [
        "forgedSender",
        "expired",
        "consumed",
        "oldWorkbench",
        "oldHostEpoch",
        "wrongItem",
        "wrongSession",
        "wrongRecord",
        "actionRefSubstitution",
        "invocationIdSubstitution",
      ].map((k) => [k, true]),
    ),
    pluginCannotStopForeignOwner: true,
    resourceFreeDisconnectOrdered: true,
    actualSaveDisconnect: "pending-X-T1",
  };
  historicalUiChecks.U16(u16);
  assert.throws(() => historicalUiChecks.U16({ ...u16, actualSaveDisconnect: true }));
  const u17 = {
    secondaryWriters: 0,
    secondaryProviders: 0,
    secondaryPlugins: 0,
    primaryFocused: true,
    suspendReason: "suspended",
    healthyGenerationRetained: true,
    wakeReplays: 0,
    oldTokenRejected: true,
    providerLossKeepsConsumer: true,
    rendererLossRetiresConsumer: true,
    fileExchangeMs: 10000,
    ordinaryExchangeMs: 5000,
    cleanupMs: 24000,
    outerSafetyNetMs: 25000,
    actualCheckpointRecovery: "pending-X-T1",
  };
  historicalUiChecks.U17(u17);
  for (const patch of [
    { actualCheckpointRecovery: true },
    { cleanupMs: 26000 },
    { outerSafetyNetMs: 27000 },
    { wakeReplays: 1 },
    { secondaryWriters: 1 },
  ])
    assert.throws(() => historicalUiChecks.U17({ ...u17, ...patch }));
});
test("foundation bundle hash cannot be substituted for composite artifact identity", () =>
  temporary(async (directory) => {
    await writeFile(path.join(directory, "main.cjs"), "synthetic unit fixture");
    await assert.rejects(
      () =>
        verifyFoundationArtifact({ artifact: "main.cjs", bundleSha256: "0".repeat(64) }, directory),
      /changed foundation bundle/,
    );
  }));

test(
  "current receipts: independently validate A/B1/B2 join; missing inputs never sign acceptance",
  {
    skip: process.env.KOBRIXA_LIFECYCLE_EVIDENCE
      ? false
      : "NOT RUN: supply current KOBRIXA_LIFECYCLE_EVIDENCE and historical KOBRIXA_UI_MATRIX; unit fixtures are not acceptance",
  },
  async () => {
    const file = path.resolve(process.env.KOBRIXA_LIFECYCLE_EVIDENCE);
    assert.ok(process.env.KOBRIXA_UI_MATRIX, "historical KOBRIXA_UI_MATRIX required");
    const result = await validateLifecycleEvidence(JSON.parse(await readFile(file, "utf8")), {
      directory: path.dirname(file),
      uiMatrix: JSON.parse(await readFile(process.env.KOBRIXA_UI_MATRIX, "utf8")),
    });
    requireCurrentFoundation(result);
    assert.equal(
      result.fullPass,
      false,
      "W13b still needs product and final-artifact observations",
    );
  },
);

// These values exist only in verifier unit tests. They are never written as
// retained native observations or supplied to requireCurrentFoundation.
function healthyReceipt() {
  return {
    case: "healthy-release",
    level: "real-process",
    status: "passed",
    runId: "unit-run",
    profileId: "unit-profile",
    commit: "1".repeat(40),
    bundleSha256: "2".repeat(64),
    artifactSha256: "3".repeat(64),
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    pid: 123,
    exitCode: 0,
    signal: null,
    closedAt: 1,
    exitedAt: 2,
    reportedAt: 3,
    cleanup: { workers: 0, listeners: 0, children: 0, errors: [] },
    workerTrace: [
      { kind: "start", count: 1, pid: 123 },
      { kind: "exit", count: 0, pid: 123 },
    ],
    evidence: {
      checks: {
        retireCalls: 0,
        freezeCalls: 0,
        processExits: 0,
        generationBefore: 1,
        generationAfter: 1,
        unrelatedSettingsCommitted: true,
      },
      events: [],
      samples: {},
    },
  };
}
test("plain Node entry invokes the unchanged B2 oracle and rejects broken lifetime/cleanup", async () => {
  const { verifyPersistenceReports } = await import("./stage-3-lifecycle-matrix.mjs");
  await verifyPersistenceReports([healthyReceipt()], "1".repeat(40));
  for (const mutate of [
    (r) => r.evidence.checks.generationAfter++,
    (r) => r.cleanup.workers++,
    (r) => (r.exitCode = 1),
    (r) => (r.level = "unit"),
    (r) => (r.evidence = { checks: {}, samples: {}, events: [] }),
  ]) {
    const row = healthyReceipt();
    mutate(row);
    await assert.rejects(() => verifyPersistenceReports([row], "1".repeat(40)), /B2 oracle failed/);
  }
});
test("retained scoped artifact uses the existing producer recipe and detects worker/renderer changes", () =>
  temporary(async (directory) => {
    const { pathToFileURL } = await import("node:url");
    const { mkdir } = await import("node:fs/promises");
    const main = Buffer.from("synthetic main"),
      worker = Buffer.from("synthetic worker");
    await writeFile(path.join(directory, "main.cjs"), main);
    await writeFile(path.join(directory, "worker.cjs"), worker);
    const rendererRoot = path.join(directory, "ui");
    await mkdir(path.join(rendererRoot, "renderer"), { recursive: true });
    const files = {
      "preload.cjs": "synthetic preload",
      "renderer/index.html": "synthetic html",
      "renderer/script.js": "synthetic js",
    };
    for (const [file, bytes] of Object.entries(files))
      await writeFile(path.join(rendererRoot, file), bytes);
    const renderer = {
      format: 1,
      root: rendererRoot,
      rendererUrl: pathToFileURL(path.join(rendererRoot, "renderer/index.html")).href,
      preload: path.join(rendererRoot, "preload.cjs"),
      sha256: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, hash(bytes)])),
      sourceSha256: (await input()).identity.sourceHashes,
    };
    const rendererBytes = JSON.stringify(renderer);
    await writeFile(path.join(rendererRoot, "renderer-artifact.json"), rendererBytes);
    const indices = [];
    for (const role of ["recording", "settings"]) {
      const folder = path.join(directory, `plugins/acceptance-builtin-${role}`);
      await mkdir(folder, { recursive: true });
      const files = [];
      for (const name of ["kobrixa-plugin.json", "main.cjs"]) {
        const bytes = Buffer.from(`synthetic ${role}/${name}`);
        await writeFile(path.join(folder, name), bytes);
        files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
      }
      indices.push(Buffer.from(JSON.stringify({ version: 1, pluginId: `unit.${role}`, files })));
      await writeFile(path.join(folder, "resource-index.json"), indices.at(-1));
    }
    const raw = {
      artifact: path.join(directory, "main.cjs"),
      bundleSha256: hash(main),
      renderer: { ...renderer, receiptSha256: hash(rendererBytes) },
    };
    raw.artifactSha256 = hash(
      Buffer.concat([
        main,
        worker,
        Buffer.from(raw.renderer.receiptSha256),
        Buffer.from("null"),
        ...indices,
      ]),
    );
    await verifyFoundationArtifact(raw);
    await writeFile(path.join(directory, "worker.cjs"), "changed worker");
    await assert.rejects(() => verifyFoundationArtifact(raw), /changed foundation artifact/);
    await writeFile(path.join(directory, "worker.cjs"), worker);
    const leaf = path.join(directory, "plugins/acceptance-builtin-recording/main.cjs");
    const original = await readFile(leaf);
    await writeFile(leaf, Buffer.alloc(original.length, 0));
    await assert.rejects(() => verifyFoundationArtifact(raw), /changed leaf/);
    await writeFile(leaf, original);
    await writeFile(path.join(rendererRoot, "preload.cjs"), "changed preload");
    await assert.rejects(() => verifyFoundationArtifact(raw), /Changed renderer artifact/);
  }));

test("empty or duplicated aggregate rows cannot bypass the required current join", () => {
  assert.throws(
    () => requireCurrentFoundation({ persistence: [], broker: [], ui: [], fullPass: false }),
    /missing\/duplicate/,
  );
  const result = inventory();
  result.persistence.pop();
  assert.throws(() => requireCurrentFoundation(result), /missing\/duplicate persistence/);
});
