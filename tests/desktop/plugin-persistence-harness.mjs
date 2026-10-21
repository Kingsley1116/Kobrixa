import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const FAULT_POINTS = Object.freeze([
  "reserve",
  "open-temp",
  "chunk-write",
  "seal-sync",
  "object-rename",
  "object-dir-sync",
  "backup-head",
  "head-write",
  "before-publish",
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
  "import-marker",
]);
export const MATRIX_IDS = Object.freeze(
  Array.from({ length: 29 }, (_, i) => `B2-N${String(i + 1).padStart(2, "0")}`),
);
const OUTCOMES = [
  ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE"],
  [-32602, "PLUGIN_E_SETTINGS_SCHEMA"],
  ["PLUGIN_E_SETTINGS_CONFLICT"],
  ["PLUGIN_E_STORAGE_CONFLICT"],
  ["PLUGIN_E_STORAGE_QUOTA", "secondary-exited"],
  [-32602, "PLUGIN_E_STORAGE_CONFLICT"],
  ["PLUGIN_E_SETTINGS_SAVE", "PLUGIN_E_STORAGE_IO"],
  ["not-committed"],
  [-32800, "PLUGIN_E_STALE_RESOURCE", "checkpoint-only"],
  ["unknown", "committed"],
  ["file-sync-only", "PLUGIN_E_STORAGE_IO"],
  ["committed"],
  ["PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_STORAGE_CONFLICT", "snapshot"],
  ["PLUGIN_E_STORAGE_IO", "PLUGIN_E_STORAGE_VERSION"],
  ["PLUGIN_E_STORAGE_CONFLICT", "timeout"],
  ["resynchronized"],
  ["checkpoint-only", "retryable"],
  ["blocker"],
  ["checkpoint-only"],
  ["drained", "blocker"],
  ["drained", "blocker"],
  ["core-only"],
  ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE", "cancelled"],
  ["PLUGIN_E_STORAGE_IO", "unknown", "committed"],
  ["PLUGIN_E_PERMISSION_DENIED", -32602, "PLUGIN_E_STORAGE_IO"],
  ["blocked"],
  ["resumed"],
  ["pending", "complete"],
  ["rejected"],
];
export async function readEvidence(file = process.env.PERSISTENCE_EVIDENCE) {
  assert.ok(
    file,
    "PERSISTENCE_EVIDENCE is required; no automatic acceptance without real evidence",
  );
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.equal(value.format, 1);
  return value;
}
function hash(value) {
  assert.match(value, /^[0-9a-f]{64}$/);
}
function identity(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}
function reopened(item) {
  identity(item.before.hostEpoch);
  identity(item.after.hostEpoch);
  assert.notEqual(item.before.hostEpoch, item.after.hostEpoch);
  for (const stage of [item.before, item.after]) {
    hash(stage.diskTreeHash);
    for (const key of [
      "recordCount",
      "reservedCreates",
      "committedBytes",
      "reservedBytes",
      "hostCommittedBytes",
      "hostReservedBytes",
      "sourceStaging",
      "hostStaging",
      "sourceExports",
      "hostExports",
      "sourceTemporaryBytes",
      "hostTemporaryBytes",
      "sourceMetadataBytes",
      "hostMetadataBytes",
    ])
      integer(stage.quota[key], `quota ${key}`);
    assert.equal(stage.quota.recordCount + stage.quota.reservedCreates <= 256, true);
    assert.equal(stage.quota.committedBytes + stage.quota.reservedBytes <= 536870912, true);
    assert.equal(
      stage.quota.hostCommittedBytes + stage.quota.hostReservedBytes <= 1073741824,
      true,
    );
    assert.equal(stage.quota.sourceStaging <= 2 && stage.quota.hostStaging <= 16, true);
    assert.equal(stage.quota.sourceExports <= 1 && stage.quota.hostExports <= 4, true);
    assert.equal(stage.quota.sourceTemporaryBytes <= 33554432, true);
    assert.equal(stage.quota.hostTemporaryBytes <= 134217728, true);
    assert.equal(stage.quota.sourceMetadataBytes <= 4194304, true);
    assert.equal(stage.quota.hostMetadataBytes <= 67108864, true);
    assert.ok(Array.isArray(stage.handles));
    assert.ok(Array.isArray(stage.core.records));
    assert.ok(Array.isArray(stage.core.errors));
  }
  for (const old of item.before.handles) assert.ok(!item.after.handles.includes(old));
}
export function verifyMatrix(report) {
  realReport(report);
  assert.equal(report.level, "real-process", "matrix evidence must be real-process");
  assert.deepEqual(report.cases.map((entry) => entry.id).sort(), MATRIX_IDS);
  for (const [index, id] of MATRIX_IDS.entries()) {
    const entry = report.cases.find((candidate) => candidate.id === id);
    assert.ok(OUTCOMES[index].includes(entry.outcome), `${id}: unexpected outcome`);
    assert.ok(entry.assertions.length > 0, `${id}: no concrete assertions`);
    for (const check of entry.assertions) {
      assert.ok(typeof check.name === "string" && check.name.length > 0);
      assert.ok(
        Object.hasOwn(check, "actual") && Object.hasOwn(check, "expected"),
        "missing assertion observations",
      );
      assert.deepEqual(check.actual, check.expected, `${id}: ${check.name}`);
    }
    reopened(entry);
  }
  const get = (id) => report.cases.find((entry) => entry.id === id);
  hash(get("B2-N01").foreignBeforeHash);
  hash(get("B2-N01").foreignAfterHash);
  hash(get("B2-N29").sentinelBeforeHash);
  hash(get("B2-N29").sentinelAfterHash);
  identity(get("B2-N10").originalCommitId);
  for (const key of ["originalExpiry", "expiryAfterRetry"]) finite(get("B2-N19")[key], key);
  integer(get("B2-N20").nonRetiredGenerationBefore, "generation");
  assert.equal(get("B2-N01").foreignBeforeHash, get("B2-N01").foreignAfterHash);
  assert.equal(get("B2-N02").newTemporaryFiles, 0);
  assert.equal(get("B2-N02").watchEvents, 0);
  assert.equal(get("B2-N03").successfulCommits, 1);
  assert.equal(get("B2-N03").conflictingCommits, 1);
  assert.equal(get("B2-N05").secondaryStoreInitializations, 0);
  assert.equal(get("B2-N05").secondaryWorkerInitializations, 0);
  assert.equal(get("B2-N05").primaryFocusCount, 1);
  assert.equal(get("B2-N10").republishCount, 0);
  assert.equal(get("B2-N10").reconciledCommitId, get("B2-N10").originalCommitId);
  assert.equal(get("B2-N11").unsupportedDurability, "file-sync-only");
  assert.equal(get("B2-N11").eioReason, "sync-failed");
  assert.equal(get("B2-N12").pinnedObjectDeleted, false);
  assert.deepEqual(get("B2-N16").unsubscribeRemoved, [true, false]);
  assert.ok(get("B2-N16").validatedAt <= get("B2-N16").enqueuedAt);
  assert.ok(get("B2-N16").enqueuedAt <= get("B2-N16").ackedAt);
  assert.ok(get("B2-N16").ackedAt < get("B2-N16").callbackFinishedAt);
  assert.equal(get("B2-N18").drainDeadlineMs, 10000);
  assert.equal(get("B2-N18").managerBudgetMs, 4000);
  assert.equal(get("B2-N19").originalExpiry, get("B2-N19").expiryAfterRetry);
  assert.equal(get("B2-N20").nonRetiredGenerationBefore, get("B2-N20").nonRetiredGenerationAfter);
  assert.ok(get("B2-N21").stopConfirmedAt <= get("B2-N21").disconnectAt);
  assert.ok(get("B2-N21").saveConfirmedAt <= get("B2-N21").disconnectAt);
  assert.equal(get("B2-N21").wakeReplayCount, 0);
  for (const key of ["optionalSchemaReads", "mapperCalls", "pluginLaunches", "deviceConnects"])
    assert.equal(get("B2-N22")[key], 0);
  assert.equal(get("B2-N23").destinationMutations, 0);
  assert.equal(get("B2-N23").deviceLocks, 0);
  assert.equal(get("B2-N24").unlinkBeforeReplace, false);
  assert.equal(get("B2-N25").clipboardReads, 0);
  assert.equal(get("B2-N25").otherFormatsWritten, 0);
  assert.equal(get("B2-N26").completeMarker, false);
  assert.equal(get("B2-N29").sentinelBeforeHash, get("B2-N29").sentinelAfterHash);
}
export function verifyInterop(report) {
  assert.equal(report.consumers?.length, 2, "two consumers required");
  realReport(report);
  assert.deepEqual(report.consumers.map((entry) => entry.transport).sort(), [
    "message-port",
    "stdio",
  ]);
  const required = [
    "settings/read",
    "settings/watch",
    "settings/update",
    "storage/beginWrite",
    "storage/writeChunk",
    "storage/sealWrite",
    "storage/commitWrite",
    "storage/list",
    "storage/openRead",
    "storage/readChunk",
    "storage/closeRead",
    "storage/flush",
    "events/unsubscribe",
    "storage/exportBegin",
    "ui/copyText",
    "storage/drain",
  ];
  for (const consumer of report.consumers) {
    assert.equal(consumer.apiVersion, "1.7.0");
    assert.equal(consumer.privateServiceCalls, 0);
    assert.equal(consumer.exitCode, 0);
    for (const method of required) assert.ok(consumer.methods.includes(method), method);
    assert.equal(consumer.settingsConflict, "PLUGIN_E_SETTINGS_CONFLICT");
    assert.equal(consumer.drained, "saved");
    assert.notEqual(consumer.callbackResult, "saved");
    hash(consumer.recordBeforeHash);
    hash(consumer.recordAfterHash);
    assert.equal(consumer.recordBeforeHash, consumer.recordAfterHash);
    assert.equal(consumer.foreignOwnerAccepted, false);
  }
  for (const version of ["1.4.0", "1.5.0", "1.6.0"]) {
    const legacy = report.negotiation.find((entry) => entry.version === version);
    assert.ok(legacy);
    assert.equal(legacy.commandSucceeded, true);
    assert.deepEqual(legacy.persistenceDeliveries, []);
  }
  assert.equal(report.unregistered17DrainCallbacks, 0);
}
// Worker fault hooks acknowledge the BEFORE edge of fs.at. import-marker is
// after gate.dispatch but still BEFORE atomicReplace. Process death is not power loss:
// the post-replacement hooks below must reopen the new head. No named hook pauses
// inside rename, so none of these acknowledged frontiers permits an old/new choice.
export const KILL_HEAD_FRONTIERS = Object.freeze({
  reserve: "old",
  "open-temp": "old",
  "chunk-write": "old",
  "seal-sync": "old",
  "object-rename": "old",
  "object-dir-sync": "old",
  "backup-head": "old",
  "head-write": "old",
  "before-publish": "old",
  "import-marker": "old",
  "after-publish": "new",
  "head-dir-sync": "new",
  "cache-publish": "new",
  "receipt-send": "new",
  cleanup: "new",
});
export function verifyKills(report) {
  realReport(report);
  assert.equal(report.level, "real-process");
  assert.deepEqual(
    [...new Set(report.kills.map((entry) => entry.point))].sort(),
    [...FAULT_POINTS].sort(),
  );
  for (const entry of report.kills) {
    assert.equal(entry.pauseAcknowledged, true);
    assert.ok(
      entry.exitCode === null || (Number.isInteger(entry.exitCode) && entry.exitCode !== 0),
    );
    hash(entry.oldHeadHash);
    hash(entry.newHeadHash);
    hash(entry.after.headHash);
    assert.equal(entry.profileId, entry.reopenedProfileId);
    assert.ok(typeof entry.profileId === "string" && entry.profileId.length > 0);
    if (entry.termination === "worker-terminate") {
      assert.ok(Number.isSafeInteger(entry.workerId) && entry.workerId > 0);
      assert.notEqual(entry.workerId, entry.reopenedWorkerId);
      assert.ok(entry.trace.some((row) => row.point === entry.point));
      assert.equal(entry.exitObserved, true);
    } else {
      assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0);
      assert.ok(entry.signal === "SIGKILL" || entry.platformTermination === "taskkill-/T-/F");
      integer(entry.reopenedPid, "reopened pid");
      assert.ok(entry.reopenedPid > 0);
      assert.equal(entry.exitObserved, true);
      assert.notEqual(entry.pid, entry.reopenedPid);
    }
    reopened(entry);
    const frontier = KILL_HEAD_FRONTIERS[entry.point];
    assert.ok(frontier, "Unknown publication frontier");
    assert.notEqual(entry.oldHeadHash, entry.newHeadHash, "Kill trial needs distinguishable heads");
    assert.equal(
      entry.after.headHash,
      frontier === "old" ? entry.oldHeadHash : entry.newHeadHash,
      `${entry.point}: wrong reopened head for publication frontier`,
    );
    identity(entry.originalTicketId);
    assert.equal(entry.reconciledTicketId, entry.originalTicketId, "Reconcile the original ticket");
    assert.ok(
      entry.trace?.some(
        (row) => row.point === entry.point && row.ticket === entry.originalTicketId,
      ),
      "Missing original-ticket frontier trace",
    );
    assert.equal(entry.partialVisible, false);
    if (frontier === "new") {
      assert.equal(entry.republishCount, 0);
      identity(entry.originalCommitId);
      assert.equal(entry.originalCommitId, entry.reconciledCommitId);
    }
  }
}
export function statistics(samples) {
  assert.equal(samples.length, 30, "30 samples required");
  assert.ok(
    [...samples].every((value) => Number.isFinite(value) && value >= 0),
    "finite samples required",
  );
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: 30, p50: sorted[14], p95: sorted[28], max: sorted[29] };
}
export function verifyLoad(report) {
  realReport(report);
  const load = report.load;
  for (const key of [
    "peakMainAddedRss",
    "peakWorkerAddedRss",
    "pendingJobs",
    "pendingSerializedBytes",
    "sourcePendingSerializedBytes",
    "sourceMetadataCacheBytes",
    "hostMetadataCacheBytes",
    "minimumFreeBytes",
  ])
    integer(load[key], key);
  for (const field of [
    "os",
    "architecture",
    "cpu",
    "ram",
    "filesystem",
    "artifact",
    "commit",
    "node",
    "electron",
  ])
    assert.ok(
      typeof load.environment[field] === "string" && load.environment[field].length > 0,
      field,
    );
  assert.equal(load.records, 50);
  assert.equal(load.recordBytes, 8388608);
  assert.equal(load.stagingRecords, 2);
  assert.equal(load.liveLogicalBytes, 436207616);
  assert.equal(load.jobs, 4);
  assert.equal(load.settingsKeys, 128);
  assert.equal(load.settingsBytes, 65536);
  assert.equal(load.visibleFields, 16);
  assert.equal(load.chunkBytes, 262144);
  for (const [name, limit] of [
    ["draftMs", 50],
    ["pageMs", 100],
    ["warmListMs", 200],
    ["extraStopDispatchMs", 50],
  ])
    assert.ok(statistics(load[name]).p95 <= limit, `${name}: p95 exceeded ${limit}`);
  assert.ok(statistics(load.mainSyncSegmentMs).max <= 16);
  assert.ok(statistics(load.commitMs).max <= 10000);
  assert.ok(statistics(load.flushMs).max <= 10000);
  assert.ok(load.peakMainAddedRss <= 33554432);
  assert.ok(load.peakWorkerAddedRss <= 67108864);
  assert.equal(load.rssMethod, "separate-process-baseline-and-peak");
  assert.equal(load.coldWarmSeparated, true);
  assert.ok(load.pendingJobs <= 32 && load.pendingSerializedBytes <= 8388608);
  assert.ok(load.sourcePendingSerializedBytes <= 1048576);
  assert.ok(load.sourceMetadataCacheBytes <= 524288 && load.hostMetadataCacheBytes <= 8388608);
  assert.ok(load.minimumFreeBytes >= 16777216);
  assert.equal(load.claimsPhysicalStopLatency, false);
}
export function verifyImports(report) {
  realReport(report);
  const imports = report.imports;
  verifyRestartDetails(imports.restartDetails);
  assert.equal(imports.records, 50);
  assert.equal(imports.recordBytes, 8388608);
  assert.deepEqual(imports.points, [
    "before-publish",
    "after-publish",
    "before-receipt",
    "after-receipt",
    "before-marker",
    "after-marker",
  ]);
  for (const trial of imports.trials) {
    assert.ok(imports.points.includes(trial.point));
    assert.equal(trial.actualProcessDeath, true);
    assert.ok(trial.reopens.length >= 3);
    const first = trial.reopens[0];
    for (const attempt of trial.reopens) {
      assert.equal(attempt.count, 50);
      assert.equal(attempt.bytes, 419430400);
      assert.deepEqual(attempt.ids, first.ids);
      assert.deepEqual(attempt.hashes, first.hashes);
      assert.equal(attempt.originalsHash, trial.originalsHash);
      assert.equal(attempt.completeMarker, true);
      assert.equal(attempt.republishCount, 0);
    }
  }
  assert.deepEqual(
    [...new Set(imports.trials.map((trial) => trial.point))].sort(),
    [...imports.points].sort(),
  );
  assert.equal(imports.deletedRecordRecreated, false);
  assert.equal(imports.pendingRendererMarkedEmpty, false);
  assert.equal(imports.maxBatch <= 64, true);
  assert.equal(imports.maxCandidateNames <= 4096, true);
  assert.equal(imports.maxJournalItems <= 512, true);
  assert.equal(imports.maxJournalBytes <= 2097152, true);
}

const finite = (n, label) =>
  assert.ok(typeof n === "number" && Number.isFinite(n) && n >= 0, label);
const integer = (n, label) => {
  finite(n, label);
  assert.ok(Number.isSafeInteger(n), label);
};
export function verifyRunReceipt(r, expected = {}) {
  assert.equal(r.level, "real-process");
  assert.equal(r.status, "passed");
  for (const field of ["runId", "case", "profileId"])
    assert.ok(typeof r[field] === "string" && r[field].length > 0, field);
  assert.match(r.commit, /^[0-9a-f]{40}$/);
  hash(r.bundleSha256);
  hash(r.artifactSha256);
  identity(r.hostEpoch);
  integer(r.pid, "pid");
  assert.ok(r.pid > 0);
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(r[key], value, `stale receipt: ${key}`);
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
  for (const field of ["closedAt", "exitedAt", "reportedAt"]) finite(r[field], field);
  assert.ok(
    r.closedAt <= r.exitedAt && r.exitedAt <= r.reportedAt,
    "report precedes close/OS exit",
  );
  for (const field of ["workers", "listeners", "children"])
    assert.equal(r.cleanup[field], 0, field);
  assert.deepEqual(r.cleanup.errors, []);
  assert.ok(Array.isArray(r.workerTrace) && r.workerTrace.length >= 2, "missing worker trace");
  const starts = r.workerTrace.filter((e) => e.kind === "start"),
    exits = r.workerTrace.filter((e) => e.kind === "exit");
  assert.equal(starts.length, 1);
  assert.equal(exits.length, 1);
  assert.equal(starts[0].count, 1, "one observed worker");
  assert.equal(exits[0].count, 0, "worker exit must be observed");
  for (const row of r.workerTrace)
    assert.equal(row.pid, r.pid, "worker belongs to another composition phase");
}
export function verifyFoundationReports(reports, cases) {
  assert.deepEqual(
    reports.map((r) => r.case).sort(),
    [...cases].sort(),
    "missing/duplicate case receipts",
  );
  for (const r of reports) verifyRunReceipt(r);
  assert.equal(
    new Set(reports.map((r) => r.profileId)).size,
    reports.length,
    "one fresh profile per case",
  );
  assert.equal(
    new Set(reports.map((r) => r.hostEpoch)).size,
    reports.length,
    "fresh hostEpoch per case",
  );
  assert.equal(new Set(reports.map((r) => r.pid)).size, reports.length, "fresh process per case");
}
// Disjoint AM-22 ownership. State stores can have several distinct retained instances.
const diagnosticOwners = {
  "ui-state": ["bindings", "subscriptions", "queuedEvents", "queuedBytes"],
  "ui-lifecycle": ["owners"],
  "ui-bridge": ["pendingInvocations", "actionTokens"],
  "state-store": ["queuedEvents", "queuedBytes"],
  "host-ports": ["resourceReaders"],
  worker: ["workerJobs"],
};
export function verifyDiagnostics(rows, final = false) {
  assert.deepEqual(
    [...new Set(rows.map((r) => r.module))].sort(),
    Object.keys(diagnosticOwners).sort(),
    "missing diagnostic modules",
  );
  const seen = new Set();
  for (const row of rows) {
    assert.ok(typeof row.instance === "string" && row.instance.length > 0, "diagnostic identity");
    assert.ok(!seen.has(row.instance), "duplicate diagnostic instance");
    seen.add(row.instance);
    for (const key of [...new Set([...Object.values(diagnosticOwners).flat(), "timers"])]) {
      integer(row.snapshot[key], `diagnostic ${key}`);
      if (final || (key !== "timers" && !diagnosticOwners[row.module].includes(key)))
        assert.equal(row.snapshot[key], 0, `duplicate/leaked diagnostic ${key}`);
    }
  }
}
function realReport(report) {
  assert.equal(report.level, "real-process", "evidence must be real-process");
  verifyRunReceipt(report.execution);
}
export const IMPORT_BOUNDARIES = Object.freeze([
  "before-plan",
  "after-plan",
  "before-attempt",
  "after-attempt",
  "before-head",
  "after-head",
  "before-receipt",
  "after-receipt",
  "before-skip",
  "after-skip",
  "before-raw",
  "after-raw",
  "before-consumption",
  "after-consumption",
  "before-marker",
  "after-marker",
  "before-barrier",
  "after-barrier",
]);
export function verifyRestartDetails(trials) {
  assert.deepEqual(
    trials.map((t) => t.boundary).sort(),
    [...IMPORT_BOUNDARIES].sort(),
    "restart boundaries missing/duplicate",
  );
  for (const t of trials) {
    assert.equal(t.actualProcessDeath, true);
    integer(t.pid, "killed pid");
    assert.ok(t.pid > 0);
    identity(t.hostEpoch);
    assert.ok(t.signal === "SIGKILL" || t.platformTermination === "taskkill-/T-/F");
    assert.ok(t.reopens.length >= 3);
    assert.equal(
      new Set([t.hostEpoch, ...t.reopens.map((r) => r.hostEpoch)]).size,
      t.reopens.length + 1,
    );
    assert.ok(t.expectedIds.length > 0);
    t.expectedIds.forEach(identity);
    t.expectedHashes.forEach(hash);
    assert.equal(t.expectedIds.length, t.expectedHashes.length);
    t.originalHashes.forEach(hash);
    hash(t.persistedPreferenceDigest);
    hash(t.expectedPreferenceMappedHash);
    for (const r of t.reopens) {
      identity(r.hostEpoch);
      integer(r.pid, "reopen pid");
      assert.ok(r.pid > 0);
      assert.notEqual(r.pid, t.pid);
      assert.equal(r.profileId, t.profileId);
      assert.ok(typeof t.profileId === "string" && t.profileId.length > 0);
      assert.deepEqual(r.ids, t.expectedIds);
      assert.deepEqual(r.hashes, t.expectedHashes);
      assert.deepEqual(r.originalHashes, t.originalHashes);
      assert.equal(r.committedDestinations, new Set(r.ids).size);
      assert.deepEqual(r.skipReasons, t.skipReasons);
      for (const k of [
        "completedItems",
        "committedItems",
        "skippedItems",
        "barrierRestoredAt",
        "writerStartAttemptAt",
      ])
        integer(r[k], k);
      assert.equal(r.completedItems, r.committedItems + r.skippedItems);
      assert.ok(r.barrierRestoredAt <= r.writerStartAttemptAt);
      for (const k of [
        "writerAdmitted",
        "deletedRecordResurrected",
        "rendererPresent",
        "oldWindowSubmitAccepted",
      ])
        assert.equal(r[k], false, k);
      assert.equal(r.publishesWhileUnknown, 0);
      assert.equal(r.preferenceSourceHash, t.persistedPreferenceDigest);
      assert.equal(r.preferenceMappedHash, t.expectedPreferenceMappedHash);
      assert.ok(
        r.workerTrace?.some((e) => e.kind === "start" && e.pid === r.pid),
        "missing phase worker trace",
      );
    }
  }
}

// Test-only entry finalization shared by the generated Electron entry and pure flow tests.
export function diagnosticError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    ...(typeof error?.stack === "string" ? { stack: error.stack } : {}),
  };
}
export async function runReferenceEntry(createFixture, config, io) {
  let fixture,
    originalError,
    closed = false;
  const cleanupErrors = [];
  const recordFailure = async (cleanupState, suffix) => {
    const failure = {
      format: 1,
      kind: "persistence-entry-failure",
      status: "failed",
      runId: config.runId,
      case: config.case,
      pid: io.pid,
      originalError,
      cleanupState,
      cleanupErrors: [...cleanupErrors],
      reportedAt: io.now(),
    };
    try {
      await io.write(`${config.report}.${suffix}.json`, JSON.stringify(failure));
    } catch (error) {
      const diagnostic = diagnosticError(error);
      cleanupErrors.push(diagnostic);
      failure.cleanupErrors.push(diagnostic);
      (io.reportFailure ?? console.error)(failure);
    }
  };
  try {
    fixture = await createFixture();
    const started = fixture.composition.workerCount;
    const evidence = await fixture.runCase(config.case);
    await fixture.close();
    await fixture.close();
    closed = true;
    const workers = fixture.composition.workerCount,
      listeners = fixture.composition.reservationListenerCount;
    await io.write(
      config.report,
      JSON.stringify({
        format: 1,
        level: "real-process",
        status: "closed-reference",
        runId: config.runId,
        case: config.case,
        commit: config.commit,
        bundleSha256: config.bundleSha256,
        artifactSha256: config.artifactSha256,
        pid: io.pid,
        profileId: config.profileId,
        hostEpoch: fixture.composition.profile.hostEpoch,
        environment: fixture.environment,
        evidence,
        closedAt: io.now(),
        cleanup: { workers, listeners, errors: [] },
        workerTrace: [
          { kind: "start", count: started, pid: io.pid },
          { kind: "exit", count: workers, pid: io.pid },
        ],
      }),
    );
    return 0;
  } catch (error) {
    originalError = diagnosticError(error);
  } finally {
    if (fixture && !closed) {
      // Keep an immutable first-failure record outside the potentially hanging
      // close. A later final record must never truncate this fallback evidence.
      await recordFailure("pending", "entry-failure-pending");
      try {
        await fixture.close();
      } catch (error) {
        cleanupErrors.push(diagnosticError(error));
      }
    }
  }
  await recordFailure(cleanupErrors.length ? "failed" : "settled", "entry-failure");
  return 1;
}
